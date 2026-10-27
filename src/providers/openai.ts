import type { AgentConfig, Completion, Message, ModelProvider, ToolCall, ToolDefinition } from '../types.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_ARGUMENT_CHARS = 256 * 1024;
const MAX_TOOLS = 32;

class ProviderError extends Error {}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function endpoint(baseUrl: string): string {
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new ProviderError('Base URL 必须是合法的绝对地址。'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) {
    throw new ProviderError('Base URL 仅允许 HTTPS 或本机 HTTP，且不能包含凭证、查询参数或片段。');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/chat/completions')) url.pathname += '/chat/completions';
  return url.toString();
}

function usageFrom(value: unknown): Completion['usage'] {
  if (!object(value)) return undefined;
  const usage: NonNullable<Completion['usage']> = {};
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens'] as const) {
    const count = value[key];
    if (typeof count === 'number' && Number.isFinite(count) && count >= 0) usage[key] = count;
  }
  return Object.keys(usage).length ? usage : undefined;
}

function validateCompletion(value: unknown, finishReason: unknown, usage?: Completion['usage']): Completion {
  if (!object(value) || value.role !== 'assistant' || typeof finishReason !== 'string' || !finishReason) {
    throw new ProviderError('模型响应缺少合法的 assistant 消息或结束原因。');
  }
  if (value.content !== null && value.content !== undefined && typeof value.content !== 'string') {
    throw new ProviderError('模型返回了不受支持的消息内容格式。');
  }
  const message: Message = { role: 'assistant', content: typeof value.content === 'string' ? value.content : null };
  if (value.tool_calls !== undefined && value.tool_calls !== null) {
    if (!Array.isArray(value.tool_calls) || value.tool_calls.length > MAX_TOOLS) throw new ProviderError('模型工具调用列表无效或数量超限。');
    const ids = new Set<string>();
    message.tool_calls = value.tool_calls.map((call: unknown): ToolCall => {
      if (!object(call) || call.type !== 'function' || typeof call.id !== 'string' || !call.id || call.id.length > 200 || ids.has(call.id) || !object(call.function)) {
        throw new ProviderError('模型工具调用标识或类型无效。');
      }
      const fn = call.function;
      if (typeof fn.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(fn.name) || typeof fn.arguments !== 'string' || fn.arguments.length > MAX_ARGUMENT_CHARS) {
        throw new ProviderError('模型工具名称或参数格式无效。');
      }
      ids.add(call.id);
      return { id: call.id, type: 'function', function: { name: fn.name, arguments: fn.arguments } };
    });
  }
  if (message.tool_calls?.length && ['length', 'content_filter'].includes(finishReason)) {
    throw new ProviderError('模型输出未完整结束，本轮工具调用不会执行。');
  }
  if (!message.content && !message.tool_calls?.length) throw new ProviderError('模型返回了空响应。');
  return { message, finishReason, ...(usage ? { usage } : {}) };
}

async function limitedText(response: Response): Promise<string> {
  if (!response.body) throw new ProviderError('接口响应没有正文。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new ProviderError('接口响应超过 4 MiB 上限。');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function parseSSE(response: Response, onText?: (text: string) => void): Promise<Completion> {
  if (!response.body) throw new ProviderError('接口响应没有正文。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const calls = new Map<number, { id: string; type: string; function: { name: string; arguments: string } }>();
  let buffer = '';
  let text = '';
  let bytes = 0;
  let finishReason: string | undefined;
  let usage: Completion['usage'];
  let ended = false;

  const consumeEvent = (event: string): void => {
    const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (data.trim() === '[DONE]') { ended = true; return; }
    let chunk: unknown;
    try { chunk = JSON.parse(data); } catch { throw new ProviderError('接口返回了无效的流式 JSON。'); }
    if (!object(chunk) || chunk.error) throw new ProviderError('接口在流式响应中返回了错误。');
    usage = usageFrom(chunk.usage) ?? usage;
    if (!Array.isArray(chunk.choices)) throw new ProviderError('流式响应缺少 choices。');
    if (!chunk.choices.length) return;
    const choice = chunk.choices[0];
    if (!object(choice) || (choice.index !== undefined && choice.index !== 0)) throw new ProviderError('流式响应的 choice 无效。');
    if (typeof choice.finish_reason === 'string' && choice.finish_reason) finishReason = choice.finish_reason;
    if (!object(choice.delta)) throw new ProviderError('流式响应缺少 delta。');
    const delta = choice.delta;
    if (delta.role !== undefined && delta.role !== 'assistant') throw new ProviderError('流式响应角色无效。');
    if (delta.content !== undefined && delta.content !== null) {
      if (typeof delta.content !== 'string') throw new ProviderError('流式文本格式无效。');
      text += delta.content;
      onText?.(delta.content);
    }
    if (delta.tool_calls !== undefined) {
      if (!Array.isArray(delta.tool_calls)) throw new ProviderError('流式工具调用格式无效。');
      for (const part of delta.tool_calls) {
        if (!object(part) || !Number.isInteger(part.index) || (part.index as number) < 0 || (part.index as number) >= MAX_TOOLS) throw new ProviderError('流式工具调用索引无效。');
        const index = part.index as number;
        let call = calls.get(index);
        if (!call) { call = { id: '', type: '', function: { name: '', arguments: '' } }; calls.set(index, call); }
        for (const key of ['id', 'type'] as const) {
          if (part[key] !== undefined) {
            if (typeof part[key] !== 'string') throw new ProviderError('流式工具调用字段无效。');
            call[key] += part[key];
          }
        }
        if (part.function !== undefined) {
          if (!object(part.function)) throw new ProviderError('流式工具函数格式无效。');
          for (const key of ['name', 'arguments'] as const) {
            if (part.function[key] !== undefined) {
              if (typeof part.function[key] !== 'string') throw new ProviderError('流式工具参数格式无效。');
              call.function[key] += part.function[key];
            }
          }
        }
        if (call.function.arguments.length > MAX_ARGUMENT_CHARS || call.id.length > 200 || call.function.name.length > 64) throw new ProviderError('流式工具调用超过大小限制。');
      }
    }
  };

  try {
    while (!ended) {
      const { done, value } = await reader.read();
      if (done) { buffer += decoder.decode(); break; }
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new ProviderError('接口响应超过 4 MiB 上限。');
      buffer += decoder.decode(value, { stream: true });
      let separator: RegExpExecArray | null;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        const event = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        consumeEvent(event);
        if (ended) break;
      }
    }
    // 必须同时收到结束标记和结束原因，断开的工具参数不能落入执行层。
    if (!ended && buffer.trim()) consumeEvent(buffer);
    if (!ended || !finishReason) throw new ProviderError('模型流意外中断，未收到完整结束标记和结束原因。');
    const ordered = [...calls.entries()].sort(([a], [b]) => a - b);
    if (ordered.some(([index], position) => index !== position)) throw new ProviderError('模型工具调用索引不连续。');
    return validateCompletion({ role: 'assistant', content: text || null, ...(calls.size ? { tool_calls: ordered.map(([, call]) => call) } : {}) }, finishReason, usage);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export class OpenAICompatibleProvider implements ModelProvider {
  private readonly url: string;

  constructor(private readonly config: AgentConfig, private readonly apiKey?: string) {
    this.url = endpoint(config.baseUrl);
  }

  async complete(messages: Message[], tools: ToolDefinition[], signal: AbortSignal, onText?: (text: string) => void): Promise<Completion> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.config.requestTimeoutMs);
    const combined = AbortSignal.any([signal, controller.signal]);
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
        signal: combined,
        redirect: 'error',
        body: JSON.stringify({
          model: this.config.model,
          messages,
          stream: this.config.stream,
          max_tokens: this.config.maxOutputTokens,
          ...(tools.length ? {
            tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })),
            tool_choice: 'auto',
          } : {}),
        }),
      });
      if (!response.ok) {
        // 不转发上游错误正文，避免网关回显 Authorization 或密钥。
        await response.body?.cancel().catch(() => undefined);
        throw new ProviderError(`模型接口返回 HTTP ${response.status}。请检查模型、Base URL 和密钥配置。`);
      }
      if (this.config.stream) return await parseSSE(response, onText);
      let data: unknown;
      try { data = JSON.parse(await limitedText(response)); } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError('接口返回了无效的 JSON。');
      }
      if (!object(data) || data.error || !Array.isArray(data.choices) || !object(data.choices[0])) throw new ProviderError('接口返回了无效的 Chat Completions 响应。');
      const result = validateCompletion(data.choices[0].message, data.choices[0].finish_reason, usageFrom(data.usage));
      if (result.message.content) onText?.(result.message.content);
      return result;
    } catch (error) {
      if (signal.aborted) throw new ProviderError('模型请求已取消。');
      if (timedOut) throw new ProviderError('模型请求超时，请检查服务或增加 requestTimeoutMs。');
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('无法完成模型请求，请检查网络、接口地址和流式响应格式。');
    } finally { clearTimeout(timer); }
  }
}
