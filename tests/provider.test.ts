import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test, type TestContext } from 'node:test';
import { OpenAICompatibleProvider } from '../src/providers/openai.js';
import { DemoProvider } from '../src/providers/demo.js';
import type { AgentConfig, Message, ToolDefinition } from '../src/types.js';

const config: AgentConfig = { baseUrl: '', model: 'test-model', apiKeyEnv: 'WEB3D_API_KEY', maxSteps: 20, contextChars: 100000, maxOutputTokens: 4096, requestTimeoutMs: 1000, stream: false };
const messages: Message[] = [{ role: 'user', content: '检查场景' }];
const tools: ToolDefinition[] = [{ name: 'list_files', description: '读取文件列表', parameters: { type: 'object', properties: {} }, kind: 'read', execute: async () => [] }, { name: 'check_project', description: '检查项目', parameters: { type: 'object', properties: {} }, kind: 'read', execute: async () => ({}) }];

async function serve(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): Promise<string> {
  const server = createServer((req, res) => { void Promise.resolve(handler(req, res)).catch(() => res.destroy()); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}/v1`;
}

function completion(message: unknown, reason = 'stop'): string {
  return JSON.stringify({ choices: [{ message, finish_reason: reason }], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } });
}

function event(delta: unknown, reason: string | null = null): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: reason }] })}\r\n\r\n`;
}

test('JSON 接口正确映射请求、工具和用量，已有 endpoint 不重复拼接', async t => {
  const baseUrl = await serve(t, async (req, res) => {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer fake-key');
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);
    assert.equal(parsed.model, 'test-model');
    assert.equal(parsed.max_tokens, 4096);
    assert.equal(parsed.tool_choice, 'auto');
    assert.equal(parsed.tools[0].function.name, 'list_files');
    assert.equal(parsed.temperature, undefined);
    res.setHeader('content-type', 'application/json');
    res.end(completion({ role: 'assistant', content: '已检查' }));
  });
  const result = await new OpenAICompatibleProvider({ ...config, baseUrl: baseUrl + '/chat/completions' }, 'fake-key').complete(messages, tools, new AbortController().signal);
  assert.equal(result.message.content, '已检查');
  assert.equal(result.usage?.total_tokens, 16);
});

test('SSE 支持 UTF-8 分片和多个工具参数增量', async t => {
  const baseUrl = await serve(t, (_req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    const wire = event({ role: 'assistant', content: '检查模型' })
      + event({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'list_files', arguments: '{"pa' } }, { index: 1, id: 'call_b', type: 'function', function: { name: 'check_project', arguments: '{' } }] })
      + event({ tool_calls: [{ index: 1, function: { arguments: '}' } }, { index: 0, function: { arguments: 'th":"."}' } }] })
      + event({}, 'tool_calls') + 'data: {"choices":[],"usage":{"prompt_tokens":30,"completion_tokens":8,"total_tokens":38}}\r\n\r\n' + 'data: [DONE]\r\n\r\n';
    const bytes = Buffer.from(wire);
    // 每次仅发送一个字节，验证中文字符与事件边界可以跨数据块。
    let index = 0;
    const write = (): void => {
      if (index === bytes.length) { res.end(); return; }
      res.write(bytes.subarray(index, ++index));
      setImmediate(write);
    };
    write();
  });
  let streamed = '';
  const result = await new OpenAICompatibleProvider({ ...config, baseUrl, stream: true }).complete(messages, tools, new AbortController().signal, text => { streamed += text; });
  assert.equal(streamed, '检查模型');
  assert.equal(result.finishReason, 'tool_calls');
  assert.equal(result.message.tool_calls?.[0]?.function.arguments, '{"path":"."}');
  assert.equal(result.message.tool_calls?.[1]?.function.arguments, '{}');
  assert.equal(result.usage?.total_tokens, 38);
});

test('HTTP 错误不会暴露上游回显的密钥或正文', async t => {
  const secret = 'sk-this-must-not-appear';
  const baseUrl = await serve(t, (_req, res) => { res.statusCode = 401; res.end(`authorization Bearer ${secret}`); });
  await assert.rejects(new OpenAICompatibleProvider({ ...config, baseUrl }, secret).complete(messages, tools, new AbortController().signal), (error: Error) => {
    assert.match(error.message, /HTTP 401/);
    assert(!error.message.includes(secret));
    assert(!error.message.includes('authorization'));
    return true;
  });
});

test('SSE 截断时拒绝执行半截工具调用', async t => {
  const baseUrl = await serve(t, (_req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.end(event({ tool_calls: [{ index: 0, id: 'partial', type: 'function', function: { name: 'list_files', arguments: '{"path":' } }] }));
  });
  await assert.rejects(new OpenAICompatibleProvider({ ...config, baseUrl, stream: true }).complete(messages, tools, new AbortController().signal), /意外中断/);
});

test('结束标记不能替代结束原因', async t => {
  const baseUrl = await serve(t, (_req, res) => { res.end(event({ content: '没有结束原因' }) + 'data: [DONE]\n\n'); });
  await assert.rejects(new OpenAICompatibleProvider({ ...config, baseUrl, stream: true }).complete(messages, tools, new AbortController().signal), /意外中断/);
});

test('无效或重复工具 ID 被拒绝，参数 JSON 留给执行层解释', async t => {
  let duplicate = true;
  const baseUrl = await serve(t, (_req, res) => {
    const call = { id: 'same', type: 'function', function: { name: 'list_files', arguments: '{broken' } };
    res.end(completion({ role: 'assistant', content: null, tool_calls: duplicate ? [call, call] : [call] }, 'tool_calls'));
  });
  const provider = new OpenAICompatibleProvider({ ...config, baseUrl });
  await assert.rejects(provider.complete(messages, tools, new AbortController().signal), /标识或类型无效/);
  duplicate = false;
  const result = await provider.complete(messages, tools, new AbortController().signal);
  assert.equal(result.message.tool_calls?.[0]?.function.arguments, '{broken');
});

test('输出被截断时不执行工具', async t => {
  const baseUrl = await serve(t, (_req, res) => { res.end(completion({ role: 'assistant', content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'list_files', arguments: '{}' } }] }, 'length')); });
  await assert.rejects(new OpenAICompatibleProvider({ ...config, baseUrl }).complete(messages, tools, new AbortController().signal), /不会执行/);
});

test('模型返回超量工具或错误角色时拒绝响应', async t => {
  let badRole = true;
  const baseUrl = await serve(t, (_req, res) => {
    const call = (index: number) => ({ id: `call_${index}`, type: 'function', function: { name: 'list_files', arguments: '{}' } });
    res.end(completion(badRole ? { role: 'user', content: '角色错误' } : { role: 'assistant', content: null, tool_calls: Array.from({ length: 33 }, (_, i) => call(i)) }, 'tool_calls'));
  });
  const provider = new OpenAICompatibleProvider({ ...config, baseUrl });
  await assert.rejects(provider.complete(messages, tools, new AbortController().signal), /assistant/);
  badRole = false;
  await assert.rejects(provider.complete(messages, tools, new AbortController().signal), /数量超限/);
});

test('SSE 大参数受限且错误事件不泄露正文', async t => {
  let huge = true;
  const baseUrl = await serve(t, (_req, res) => {
    res.end(huge ? event({ tool_calls: [{ index: 0, id: 'call_large', type: 'function', function: { name: 'list_files', arguments: 'x'.repeat(256 * 1024 + 1) } }] }) : 'data: {"error":{"message":"sk-secret-upstream"}}\n\n');
  });
  const provider = new OpenAICompatibleProvider({ ...config, baseUrl, stream: true });
  await assert.rejects(provider.complete(messages, tools, new AbortController().signal), /大小限制/);
  huge = false;
  await assert.rejects(provider.complete(messages, tools, new AbortController().signal), (error: Error) => {
    assert.match(error.message, /返回了错误/);
    assert(!error.message.includes('sk-secret'));
    return true;
  });
});

test('请求超时与用户取消都终止网络请求', async t => {
  const baseUrl = await serve(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); });
  await assert.rejects(new OpenAICompatibleProvider({ ...config, baseUrl, stream: true, requestTimeoutMs: 40 }).complete(messages, tools, new AbortController().signal), /超时/);
  const controller = new AbortController();
  const pending = new OpenAICompatibleProvider({ ...config, baseUrl, stream: true }).complete(messages, tools, controller.signal);
  controller.abort();
  await assert.rejects(pending, /取消/);
});

test('Base URL 拒绝非本地明文地址、URL 凭证与参数', () => {
  for (const baseUrl of ['http://example.com/v1', 'https://user:secret@example.com/v1', 'https://example.com/v1?key=secret', 'https://example.com/#secret']) {
    assert.throws(() => new OpenAICompatibleProvider({ ...config, baseUrl }), /Base URL/);
  }
});

test('离线演示在每个新用户轮次重新运行并明确脚本身份', async () => {
  const provider = new DemoProvider();
  const signal = new AbortController().signal;
  const first = await provider.complete(messages, tools, signal);
  assert.equal(first.message.tool_calls?.[0]?.function.name, 'list_files');
  const afterList: Message[] = [...messages, first.message, { role: 'tool', content: '目录', tool_call_id: first.message.tool_calls![0]!.id }];
  const second = await provider.complete(afterList, tools, signal);
  assert.equal(second.message.tool_calls?.[0]?.function.name, 'check_project');
  const end = await provider.complete([...afterList, second.message, { role: 'tool', content: '规则检查', tool_call_id: second.message.tool_calls![0]!.id }], tools, signal);
  assert.match(end.message.content!, /不是模型推理/);
  const next = await provider.complete([...afterList, end.message, { role: 'user', content: '再检查' }], tools, signal);
  assert.equal(next.message.tool_calls?.[0]?.function.name, 'list_files');
});
