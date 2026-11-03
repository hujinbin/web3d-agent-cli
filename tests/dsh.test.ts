import assert from 'node:assert/strict';
import test from 'node:test';
import type { RunOptions } from '../src/agent.js';
import { runDshAgent } from '../src/runtime/dsh.js';
import { createSession, validateMessages } from '../src/session.js';
import type { AgentEvent, Completion, Message, ToolDefinition } from '../src/types.js';

function toolCall(id = 'call_0', argumentsText = '{}', name = 'change'): Completion {
  return {
    finishReason: 'tool_calls',
    message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: argumentsText } }] },
  };
}

const final: Completion = { finishReason: 'stop', message: { role: 'assistant', content: '检查完成' } };

function fixture(completions: Completion[], extra: Partial<RunOptions> = {}) {
  const requests: Message[][] = [];
  const events: AgentEvent[] = [];
  let effects = 0;
  let saves = 0;
  const tool: ToolDefinition = {
    name: 'change', description: '测试工具', parameters: {}, kind: 'write',
    async execute() { effects++; return { changed: true }; },
  };
  const options: RunOptions = {
    provider: { async complete(messages) {
      requests.push(structuredClone(messages));
      const completion = completions.shift();
      assert.ok(completion, '出现额外的模型调用');
      return structuredClone(completion);
    } },
    tools: [tool], session: createSession(process.cwd()), prompt: '执行测试', systemPrompt: '项目规则',
    mode: 'auto-edit', maxSteps: 5, contextChars: 100_000, allowRun: false,
    signal: new AbortController().signal, approve: async () => false,
    onEvent: event => events.push(event),
    onSave: async () => { saves++; validateMessages(options.session.messages); }, readState: new Map(),
    ...extra,
  };
  return { options, requests, events, effects: () => effects, saves: () => saves };
}

test('DSH 回放与请求保持 reasoning_content 的缺失、null、空字符串和正文，界面只显示正文', async () => {
  for (const reasoning of [undefined, null, '', '仅保留在协议中的推理'] as const) {
    const first = toolCall();
    if (reasoning !== undefined) first.message.reasoning_content = reasoning;
    const f = fixture([first, final]);
    assert.equal(await runDshAgent(f.options), 'completed');
    const saved = f.options.session.messages.find(message => message.role === 'assistant')!;
    const replay = f.requests[1]!.find(message => message.role === 'assistant')!;
    for (const message of [saved, replay]) {
      assert.equal(Object.hasOwn(message, 'reasoning_content'), reasoning !== undefined);
      assert.equal(message.reasoning_content, reasoning);
      assert.equal(message.content, null);
    }
    assert.deepEqual(f.events.filter(event => event.type === 'text'), [{ type: 'text', text: '检查完成' }]);
    const resumed = fixture([final], { session: structuredClone(f.options.session), prompt: '继续' });
    await runDshAgent(resumed.options);
    assert.deepEqual(resumed.requests[0]!.filter(message => message.role !== 'system').slice(0, -1), f.options.session.messages);
  }
});

test('DSH 流式回调展示普通内容一次，原始完整消息由事件日志恢复', async () => {
  const f = fixture([]);
  f.options.provider = { async complete(_messages, _tools, _signal, onText) {
    onText?.('检查');
    onText?.('完成');
    return { ...final, message: { role: 'assistant', content: '检查完成', reasoning_content: '不可显示' } };
  } };
  await runDshAgent(f.options);
  assert.deepEqual(f.events.filter(event => event.type === 'text').map(event => event.text), ['检查', '完成']);
  assert.equal(f.options.session.messages.at(-1)!.reasoning_content, '不可显示');
});

test('DSH 最大步骤严格统计模型调用，最后一批工具完成并保存后停止', async () => {
  const first = toolCall('one');
  first.message.tool_calls!.push(toolCall('two').message.tool_calls![0]!);
  const f = fixture([first, toolCall('three')], { maxSteps: 2 });
  assert.equal(await runDshAgent(f.options), 'max_steps');
  assert.equal(f.requests.length, 2);
  assert.equal(f.effects(), 3);
  validateMessages(f.options.session.messages);
  assert.equal(f.options.session.messages.filter(message => message.role === 'tool').length, 3);
  const finishing = fixture([final], { maxSteps: 1 });
  assert.equal(await runDshAgent(finishing.options), 'completed');
  assert.equal(finishing.requests.length, 1);
});

test('DSH 拒绝整个被截断或过滤的工具响应，同批重复 ID 在副作用之前拒绝', async () => {
  for (const reason of ['length', 'content_filter']) {
    const partial = toolCall();
    partial.finishReason = reason;
    const f = fixture([partial]);
    await assert.rejects(runDshAgent(f.options), /模型响应未完成/);
    assert.equal(f.effects(), 0);
    validateMessages(f.options.session.messages);
    assert.equal(f.options.session.messages.length, 1);
  }
  const duplicate = toolCall('same');
  duplicate.message.tool_calls!.push(toolCall('same').message.tool_calls![0]!);
  const f = fixture([duplicate]);
  await assert.rejects(runDshAgent(f.options), /重复或无效/);
  assert.equal(f.effects(), 0);
});

test('DSH 校验原始工具参数，空字符串及非对象均只能得到错误结果', async () => {
  const f = fixture(['', '[]', 'null', '1', '{'].map((input, index) => toolCall(`bad-${index}`, input)).concat(final), { maxSteps: 6 });
  assert.equal(await runDshAgent(f.options), 'completed');
  assert.equal(f.effects(), 0);
  assert.equal(f.options.session.messages.filter(message => message.role === 'tool').length, 5);
  assert.equal(f.events.filter(event => event.type === 'tool_end' && event.isError).length, 5);
  validateMessages(f.options.session.messages);
});

test('DSH 取消会等待正在执行的工具退出，剩余调用补齐结果后才保存', async () => {
  const controller = new AbortController();
  let startTool!: () => void;
  let releaseTool!: () => void;
  const started = new Promise<void>(resolve => { startTool = resolve; });
  const release = new Promise<void>(resolve => { releaseTool = resolve; });
  let exited = false;
  let finished = false;
  let starts = 0;
  const completion = toolCall('first');
  completion.message.tool_calls!.push(toolCall('second').message.tool_calls![0]!);
  const f = fixture([completion], { signal: controller.signal });
  f.options.tools[0]!.execute = async (_input, context) => {
    starts++;
    startTool();
    await release;
    assert.equal(context.signal.aborted, true);
    exited = true;
    return '清理结束';
  };
  f.options.onSave = async () => {
    validateMessages(f.options.session.messages);
    if (f.options.session.messages.some(message => message.role === 'tool')) assert.equal(exited, true);
  };
  const running = runDshAgent(f.options).finally(() => { finished = true; });
  await started;
  controller.abort();
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(finished, false);
  releaseTool();
  assert.equal(await running, 'aborted');
  assert.equal(starts, 1);
  assert.equal(f.options.session.messages.filter(message => message.role === 'tool').length, 2);
  assert.match(f.options.session.messages.at(-1)!.content!, /任务中断/);
  validateMessages(f.options.session.messages);
});

test('DSH 显示回调出错后停止后续副作用，保持配对并向调用者抛出原错误', async () => {
  for (const eventType of ['status', 'text', 'tool_start', 'tool_end'] as const) {
    const completion = toolCall('first');
    completion.message.content = '准备执行';
    completion.message.tool_calls!.push(toolCall('second').message.tool_calls![0]!);
    const f = fixture([completion], { onEvent: event => { if (event.type === eventType) throw new Error(`回调失败-${eventType}`); } });
    await assert.rejects(runDshAgent(f.options), new RegExp(`回调失败-${eventType}`));
    assert.equal(f.effects(), eventType === 'tool_end' ? 1 : 0);
    assert.equal(f.requests.length, eventType === 'status' ? 0 : 1);
    validateMessages(f.options.session.messages);
  }
});

test('DSH 保存失败在下一请求前终止，已完成工具结果仍留在会话中', async () => {
  const f = fixture([toolCall(), final]);
  let saves = 0;
  f.options.onSave = async () => {
    saves++;
    validateMessages(f.options.session.messages);
    if (saves === 2) throw new Error('保存失败');
  };
  await assert.rejects(runDshAgent(f.options), /保存失败/);
  assert.equal(f.requests.length, 1);
  assert.equal(f.effects(), 1);
  assert.equal(f.options.session.messages.at(-1)!.role, 'tool');
  assert.ok(saves >= 3);
});

test('DSH 模型异常向上抛出，结束时不会伪报 completed', async () => {
  const f = fixture([]);
  f.options.provider = { async complete() { throw new Error('本机模拟接口不可用'); } };
  await assert.rejects(runDshAgent(f.options), /本机模拟接口不可用/);
  validateMessages(f.options.session.messages);
  assert.equal(f.options.session.messages.length, 1);
});

test('DSH 请求预算只移出完整历史轮次，保留当前任务并加入说明', async () => {
  const f = fixture([toolCall('new'), final], { contextChars: 2200 });
  f.options.session.messages.push(
    { role: 'user', content: '旧任务' + 'x'.repeat(5000) }, toolCall('old').message,
    { role: 'tool', tool_call_id: 'old', content: '旧结果' }, final.message,
  );
  assert.equal(await runDshAgent(f.options), 'completed');
  assert.equal(f.events.filter(event => event.type === 'context_trimmed').length, 2);
  for (const request of f.requests) {
    assert.ok(request.some(message => message.role === 'system' && message.content?.includes('完整对话')));
    const retained = request.filter(message => message.role !== 'system');
    assert.equal(retained[0]!.content, '执行测试');
    validateMessages(retained);
    assert.ok(!retained.some(message => message.tool_calls?.some(call => call.id === 'old')));
  }
  assert.equal(f.options.session.messages[0]!.content?.length, 5003);
  validateMessages(f.options.session.messages);
});
