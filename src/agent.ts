import { randomUUID } from 'node:crypto';
import type { AgentEvent, ApprovalRequest, Message, ModelProvider, PermissionMode, Session, ToolContext, ToolDefinition } from './types.js';

export interface RunOptions {
  provider: ModelProvider;
  tools: ToolDefinition[];
  session: Session;
  prompt: string;
  systemPrompt: string;
  mode: PermissionMode;
  maxSteps: number;
  contextChars: number;
  allowRun: boolean;
  signal: AbortSignal;
  approve: (request: ApprovalRequest) => Promise<boolean>;
  onEvent: (event: AgentEvent) => void;
  onSave: () => Promise<void>;
  readState: Map<string, string>;
}

// 只按完整用户轮次移除历史，避免工具调用与结果被分割。
export function boundContext(messages: Message[], budget: number): { messages: Message[]; removed: number } {
  const size = (items: Message[]) => JSON.stringify(items).length;
  let current = [...messages];
  let removed = 0;
  while (size(current) > budget) {
    const next = current.findIndex((message, index) => index > 0 && message.role === 'user');
    if (next < 0) throw new Error('当前任务已超过上下文字符预算，请缩小任务或新建会话；本工具不会截断当前工具调用');
    removed += next;
    current = current.slice(next);
  }
  return { messages: current, removed };
}

function resultString(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? 'null';
  if (text.length <= 24_000) return text;
  // 大结果保留合法 JSON 外壳，避免截断产生伪装成完整结果的无效 JSON。
  let length = Math.min(text.length, 22_000);
  while (length > 0) {
    const preview = JSON.stringify({ truncated: true, preview: text.slice(0, length), notice: '工具结果已截断，请缩小范围后重新读取' });
    if (preview.length <= 24_000) return preview;
    length = Math.floor(length * 0.8);
  }
  return '{"truncated":true}';
}

export async function runAgent(options: RunOptions): Promise<'completed' | 'max_steps' | 'aborted'> {
  const { session, provider, signal, onEvent } = options;
  const context: ToolContext = { cwd: session.cwd, signal, readState: options.readState };
  session.messages.push({ role: 'user', content: options.prompt });
  await options.onSave();
  for (let step = 1; step <= options.maxSteps; step++) {
    if (signal.aborted) return 'aborted';
    const budget = options.contextChars - options.systemPrompt.length;
    if (budget < 1000) throw new Error('项目规则占用过多上下文，请精简规则或提高 contextChars');
    const bounded = boundContext(session.messages, budget);
    if (bounded.removed) {
      onEvent({ type: 'context_trimmed', removed: bounded.removed });
    }
    let streamed = false;
    onEvent({ type: 'status', text: `模型调用 ${step}/${options.maxSteps}` });
    const completion = await provider.complete([
      { role: 'system', content: options.systemPrompt },
      ...(bounded.removed ? [{ role: 'system' as const, content: '部分较早的完整对话已因预算移出当前请求。需要旧文件时请重新读取，不要假定仍有历史细节。' }] : []),
      ...bounded.messages,
    ], options.tools, signal, text => {
      streamed = true;
      onEvent({ type: 'text', text });
    });
    if (!streamed && completion.message.content) onEvent({ type: 'text', text: completion.message.content });
    // 被截断的模型响应不能触发任何工具副作用。
    if (completion.finishReason === 'length' || completion.finishReason === 'content_filter') {
      throw new Error(`模型响应未完成（${completion.finishReason}），本轮工具未执行。请调整输出预算或任务`);
    }
    const batchIds = new Set<string>();
    const usedIds = new Set(session.messages.flatMap(message => message.tool_calls?.map(call => call.id) ?? []));
    const calls = (completion.message.tool_calls ?? []).map(call => {
      if (!call.id || batchIds.has(call.id)) throw new Error('同一模型响应包含重复或无效的工具调用 ID，本轮工具未执行');
      batchIds.add(call.id);
      let id = call.id;
      // 部分兼容服务每轮都返回 call_0；仅重映射历史冲突，保持会话与后续请求配对。
      while (usedIds.has(id)) id = `call_${randomUUID()}`;
      usedIds.add(id);
      return { ...call, id, function: { ...call.function } };
    });
    session.messages.push({ ...completion.message, ...(calls.length ? { tool_calls: calls } : {}) });
    if (!calls.length) {
      if (!completion.message.content?.trim()) throw new Error('模型返回空响应，请检查模型是否支持工具调用');
      await options.onSave();
      return 'completed';
    }
    let aborted = false;
    const completed = new Set<string>();
    try {
      for (const call of calls) {
        let result: string;
        let isError = false;
        let input: Record<string, unknown> = {};
        try {
          if (signal.aborted) throw new Error('任务已取消，此调用未执行');
          const parsed: unknown = JSON.parse(call.function.arguments);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('工具参数必须是 JSON 对象');
          input = parsed as Record<string, unknown>;
          onEvent({ type: 'tool_start', name: call.function.name, input });
          const tool = options.tools.find(item => item.name === call.function.name);
          if (!tool) throw new Error(`未知工具：${call.function.name}`);
          if (options.mode === 'plan' && tool.kind !== 'read') throw new Error('plan 模式仅允许读取与检查');
          if (tool.kind !== 'read') {
            const automatic = (tool.kind === 'write' && options.mode === 'auto-edit') || (tool.kind === 'command' && options.allowRun);
            if (!automatic && !await options.approve({ tool: tool.name, kind: tool.kind, input })) throw new Error('用户未批准此操作');
          }
          signal.throwIfAborted();
          const output = await tool.execute(input, context);
          isError = output !== null && typeof output === 'object' && 'isError' in output && output.isError === true;
          result = resultString(output);
        } catch (error) {
          isError = true;
          result = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
        }
        session.messages.push({ role: 'tool', tool_call_id: call.id, content: result });
        completed.add(call.id);
        onEvent({ type: 'tool_end', name: call.function.name, result, isError });
        if (signal.aborted) aborted = true;
      }
    } finally {
      // 只检查当前批次，历史结果不能冒充当前未完成调用的结果。
      for (const call of calls) {
        if (!completed.has(call.id)) session.messages.push({ role: 'tool', tool_call_id: call.id, content: '{"error":"任务中断，此调用没有完成结果，请检查文件状态"}' });
      }
      await options.onSave();
    }
    if (aborted) return 'aborted';
  }
  return 'max_steps';
}
