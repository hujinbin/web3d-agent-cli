import assert from 'node:assert/strict';
import test from 'node:test';
import { boundContext, runAgent, type RunOptions } from '../src/agent.js';
import { createSession, validateMessages } from '../src/session.js';
import type { Completion, Message, ModelProvider, ToolDefinition } from '../src/types.js';

const call = (id = 'one', name = 'change', args = '{}'): Completion => ({
  finishReason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: args } }] },
});
const final: Completion = { message: { role: 'assistant', content: '已完成实际检查。' }, finishReason: 'stop' };

function setup(completions: Completion[], extra: Partial<RunOptions> = {}) {
  let effects = 0;
  let saves = 0;
  const requests: Message[][] = [];
  const provider: ModelProvider = { async complete(messages) {
    requests.push(structuredClone(messages));
    const next = completions.shift();
    assert.ok(next, '没有预期的模型返回值');
    return next;
  } };
  const tool: ToolDefinition = { name: 'change', kind: 'write', description: '测试写入', parameters: {}, async execute() { effects++; return { changed: true }; } };
  const options: RunOptions = {
    provider, tools: [tool], session: createSession(process.cwd()), prompt: '完成任务', systemPrompt: '规则',
    mode: 'auto-edit', maxSteps: 4, contextChars: 10_000, allowRun: false,
    signal: new AbortController().signal, approve: async () => false, onEvent: () => {},
    onSave: async () => { saves++; validateMessages(options.session.messages); }, readState: new Map(), ...extra,
  };
  return { options, requests, effects: () => effects, saves: () => saves };
}

test('模型调用工具后收到配对结果，再产生最终答案', async () => {
  const fixture = setup([call(), final]);
  assert.equal(await runAgent(fixture.options), 'completed');
  assert.equal(fixture.effects(), 1);
  assert.equal(fixture.requests[1]?.at(-1)?.tool_call_id, 'one');
  assert.ok(fixture.saves() >= 3);
});

test('plan 模式即使允许命令也不能产生写入或命令副作用', async () => {
  for (const kind of ['write', 'command'] as const) {
    const fixture = setup([call(), final], { mode: 'plan', allowRun: true });
    fixture.options.tools[0]!.kind = kind;
    await runAgent(fixture.options);
    assert.equal(fixture.effects(), 0);
    assert.match(fixture.options.session.messages.find(message => message.role === 'tool')!.content!, /plan/);
  }
});

test('ask 模式拒绝修改并把拒绝作为模型可见的工具结果', async () => {
  const fixture = setup([call(), final], { mode: 'ask' });
  await runAgent(fixture.options);
  assert.equal(fixture.effects(), 0);
  assert.match(fixture.requests[1]!.at(-1)!.content!, /未批准/);
});

test('无效参数和不存在的工具均配对返回错误', async () => {
  const fixture = setup([call('bad-json', 'change', '{'), call('unknown', 'missing'), final]);
  await runAgent(fixture.options);
  assert.equal(fixture.effects(), 0);
  validateMessages(fixture.options.session.messages);
  assert.equal(fixture.options.session.messages.filter(message => message.role === 'tool').length, 2);
});

test('中途取消会为剩余调用补齐结果，恢复时没有孤立调用', async () => {
  const controller = new AbortController();
  const completion = call();
  completion.message.tool_calls!.push(call('two').message.tool_calls![0]!);
  const fixture = setup([completion], { signal: controller.signal });
  fixture.options.tools[0]!.execute = async () => { controller.abort(); return '实际已执行'; };
  assert.equal(await runAgent(fixture.options), 'aborted');
  validateMessages(fixture.options.session.messages);
  assert.equal(fixture.options.session.messages.filter(message => message.role === 'tool').length, 2);
});

test('兼容服务在同一任务的多轮中复用 call_0 时仍可保存与继续', async () => {
  const fixture = setup([call('call_0'), call('call_0'), final]);
  assert.equal(await runAgent(fixture.options), 'completed');
  assert.equal(fixture.effects(), 2);
  validateMessages(fixture.options.session.messages);
  const calls = fixture.options.session.messages.flatMap(message => message.tool_calls ?? []);
  assert.equal(calls[0]!.id, 'call_0');
  assert.notEqual(calls[1]!.id, 'call_0');
  validateMessages(fixture.requests[2]!.filter(message => message.role !== 'system'));
});

test('恢复已有会话后复用工具 ID 会在副作用之前重映射', async () => {
  const fixture = setup([call('call_0'), call('call_0'), final]);
  assert.equal(await runAgent({ ...fixture.options, maxSteps: 1 }), 'max_steps');
  fixture.options.session.messages = structuredClone(fixture.options.session.messages);
  assert.equal(await runAgent(fixture.options), 'completed');
  assert.equal(fixture.effects(), 2);
  validateMessages(fixture.options.session.messages);
  const results = fixture.options.session.messages.filter(message => message.role === 'tool');
  assert.equal(new Set(results.map(message => message.tool_call_id)).size, 2);
});

test('历史工具 ID 冲突后事件中断仍补齐当前批次结果', async () => {
  const completion = call('call_0');
  completion.message.tool_calls!.push(call('call_second').message.tool_calls![0]!);
  const fixture = setup([completion]);
  fixture.options.session.messages.push(
    { role: 'user', content: '先前任务' }, call('call_0').message,
    { role: 'tool', tool_call_id: 'call_0', content: '先前结果' }, final.message,
  );
  fixture.options.onEvent = event => { if (event.type === 'tool_end') throw new Error('显示中断'); };
  await assert.rejects(runAgent(fixture.options), /显示中断/);
  assert.equal(fixture.effects(), 1);
  validateMessages(fixture.options.session.messages);
  const current = fixture.options.session.messages.slice(5);
  assert.notEqual(current[0]!.tool_calls![0]!.id, 'call_0');
  assert.equal(current.filter(message => message.role === 'tool').length, 2);
  assert.match(current.at(-1)!.content!, /任务中断/);
});

test('同批重复工具 ID 在发生副作用前拒绝', async () => {
  const completion = call('same');
  completion.message.tool_calls!.push(call('same').message.tool_calls![0]!);
  const fixture = setup([completion]);
  await assert.rejects(runAgent(fixture.options), /重复或无效/);
  assert.equal(fixture.effects(), 0);
  validateMessages(fixture.options.session.messages);
});

test('截断响应不能触发写入，达到轮次限制后明确结束', async () => {
  const partial = call(); partial.finishReason = 'length';
  const truncated = setup([partial]);
  await assert.rejects(runAgent(truncated.options), /未完成/);
  assert.equal(truncated.effects(), 0);
  const limited = setup([call()], { maxSteps: 1 });
  assert.equal(await runAgent(limited.options), 'max_steps');
  validateMessages(limited.options.session.messages);
});

test('预算只移出旧的完整用户轮次，保留当前任务工具配对', () => {
  const messages: Message[] = [
    { role: 'user', content: '旧任务' + 'x'.repeat(5000) },
    call().message, { role: 'tool', tool_call_id: 'one', content: '旧结果' }, final.message,
    { role: 'user', content: '新任务' }, call('new').message,
    { role: 'tool', tool_call_id: 'new', content: '新结果' },
  ];
  const result = boundContext(messages, 1500);
  assert.equal(result.removed, 4);
  assert.equal(result.messages[0]?.content, '新任务');
  validateMessages(result.messages);
  assert.equal(messages.length, 7);
  assert.throws(() => boundContext([{ role: 'user', content: 'x'.repeat(2000) }], 1000), /当前任务/);
});

test('命令非零退出标记会传递到错误事件，大结果仍是合法 JSON', async () => {
  const events: { type: string; isError?: boolean }[] = [];
  const fixture = setup([call(), final], { contextChars: 100_000, onEvent: event => events.push(event) });
  fixture.options.tools[0]!.execute = async () => ({ isError: true, output: '"'.repeat(30_000) });
  await runAgent(fixture.options);
  assert.equal(events.find(event => event.type === 'tool_end')?.isError, true);
  const toolContent = fixture.options.session.messages.find(message => message.role === 'tool')!.content!;
  assert.ok(toolContent.length <= 24_000);
  assert.equal(JSON.parse(toolContent).truncated, true);
});
