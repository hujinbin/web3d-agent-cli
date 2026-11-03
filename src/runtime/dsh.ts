import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry, { type Agent, type AgentHandle } from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, {
  LlmAdapter, ToolCallId, createUserMessage,
  type ContentBlock, type GenerateOptions, type RequestMessage, type StreamChunk,
} from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { boundContext, resultString, type RunOptions } from '../agent.js';
import type { AgentEvent, Message } from '../types.js';

const trimNotice = '部分较早的完整对话已因预算移出当前请求。需要旧文件时请重新读取，不要假定仍有历史细节。';
const interruptedResult = '{"error":"任务中断，此调用没有完成结果，请检查文件状态"}';

function textContent(content: readonly ContentBlock[]): string {
  return content.filter(block => block.type === 'text').map(block => block.text).join('');
}

function projectMessage(message: RequestMessage): Message {
  if (message.role === 'assistant') {
    // 原始兼容接口字段放进 DSH 的适配器回放元数据，保留空字符串、null 与缺失值。
    const replay = message.source.replayState as { response?: { web3dMessage?: Message } } | undefined;
    if (replay?.response?.web3dMessage) return structuredClone(replay.response.web3dMessage);
    const calls = message.content.filter(block => block.type === 'tool-call').map(block => ({
      id: String(block.id), type: 'function' as const,
      function: { name: block.name, arguments: block.arguments },
    }));
    const reasoning = message.content.filter(block => block.type === 'reasoning').map(block => block.text).join('');
    return {
      role: 'assistant', content: textContent(message.content) || null,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      ...(calls.length ? { tool_calls: calls } : {}),
    };
  }
  if (message.role === 'tool') return { role: 'tool', tool_call_id: String(message.toolCallId), content: resultString(textContent(message.content)) };
  return { role: message.role === 'developer' ? 'system' : message.role, content: textContent(message.content) };
}

// 仅在 DSH 已静止或上一完整步骤结束时投影，兜底修复中断调用，避免保存孤立请求。
function pairedMessages(messages: Message[]): Message[] {
  const result: Message[] = [];
  const pending = new Set<string>();
  const closePending = () => {
    for (const id of pending) result.push({ role: 'tool', tool_call_id: id, content: interruptedResult });
    pending.clear();
  };
  for (const message of messages) {
    if (message.role !== 'tool') closePending();
    result.push(message);
    for (const call of message.tool_calls ?? []) pending.add(call.id);
    if (message.role === 'tool') pending.delete(message.tool_call_id!);
  }
  closePending();
  return result;
}

export async function runDshAgent(options: RunOptions): Promise<'completed' | 'max_steps' | 'aborted'> {
  const history = structuredClone(options.session.messages);
  const user: Message = { role: 'user', content: options.prompt };
  options.session.messages.push(user);
  await options.onSave();
  if (options.signal.aborted) return 'aborted';

  const ctx = new Context();
  let handle: AgentHandle | undefined;
  let agent: Agent | undefined;
  let calls = 0;
  let limited = false;
  let failure: unknown;
  let result: 'completed' | 'max_steps' | 'aborted' = 'aborted';
  const rawArguments = new Map<string, string>();
  const toolNames = new Map<string, string>();
  const interruptedCalls = new Set<string>();
  const errorResults = new Set<string>();
  const usedIds = new Set(history.flatMap(message => message.tool_calls?.map(call => call.id) ?? []));
  const fail = (error: unknown) => {
    failure ??= error;
    agent?.cancel({ kind: 'hook', reason: 'Web3D 运行时回调失败' });
  };
  const emit = (event: AgentEvent) => {
    if (failure !== undefined) return;
    try { options.onEvent(event); } catch (error) { fail(error); }
  };
  const toMessage = (message: RequestMessage): Message => {
    const projected = projectMessage(message);
    if (projected.role === 'tool' && interruptedCalls.has(projected.tool_call_id!)) projected.content = interruptedResult;
    return projected;
  };
  const project = () => {
    const current = agent?.session.deriveMessages().filter(message => message.role !== 'system' && message.role !== 'developer').map(toMessage) ?? [];
    options.session.messages = [...history, ...pairedMessages(current.length ? current : [user])];
  };
  const cancel = () => agent?.cancel({ kind: 'user' });

  class ProviderBridge extends LlmAdapter {
    async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
      const signal = request.signal ? AbortSignal.any([options.signal, request.signal]) : options.signal;
      signal.throwIfAborted();
      const systems = request.messages.filter(message => message.role === 'system').map(projectMessage);
      const current = request.messages.filter(message => message.role !== 'system' && message.role !== 'developer').map(toMessage);
      const budget = options.contextChars - systems.reduce((size, message) => size + (message.content?.length ?? 0), 0);
      if (budget < 1000) throw new Error('项目规则占用过多上下文，请精简规则或提高 contextChars');
      let bounded = boundContext([...history, ...current], budget);
      if (bounded.removed) {
        bounded = boundContext([...history, ...current], budget - trimNotice.length);
        emit({ type: 'context_trimmed', removed: bounded.removed });
      }
      emit({ type: 'status', text: `模型调用 ${calls + 1}/${options.maxSteps}` });
      signal.throwIfAborted();
      calls++;
      let streamed = false;
      const completion = await options.provider.complete([
        ...systems,
        ...(bounded.removed ? [{ role: 'system' as const, content: trimNotice }] : []),
        ...bounded.messages,
      ], options.tools, signal, text => {
        streamed = true;
        emit({ type: 'text', text });
      });
      signal.throwIfAborted();
      if (completion.finishReason === 'length' || completion.finishReason === 'content_filter') {
        throw new Error(`模型响应未完成（${completion.finishReason}），本轮工具未执行。请调整输出预算或任务`);
      }
      const message = structuredClone(completion.message);
      const batchIds = new Set<string>();
      for (const call of message.tool_calls ?? []) {
        if (!call.id || batchIds.has(call.id)) throw new Error('同一模型响应包含重复或无效的工具调用 ID，本轮工具未执行');
        batchIds.add(call.id);
      }
      for (const call of message.tool_calls ?? []) {
        while (usedIds.has(call.id)) call.id = `call_${randomUUID()}`;
        usedIds.add(call.id);
        rawArguments.set(call.id, call.function.arguments);
        toolNames.set(call.id, call.function.name);
      }
      if (!message.tool_calls?.length && !message.content?.trim()) throw new Error('模型返回空响应，请检查模型是否支持工具调用');
      if (!streamed && message.content) emit({ type: 'text', text: message.content });
      signal.throwIfAborted();
      const blocks: ContentBlock[] = [];
      if (message.reasoning_content) blocks.push({ type: 'reasoning', text: message.reasoning_content });
      if (message.content) blocks.push({ type: 'text', text: message.content });
      for (const call of message.tool_calls ?? []) blocks.push({
        type: 'tool-call', id: ToolCallId(call.id), name: call.function.name, arguments: call.function.arguments,
      });
      for (const [index, block] of blocks.entries()) {
        yield { type: 'block-start', index, blockType: block.type };
        if (block.type === 'text') yield { type: 'text-delta', index, text: block.text };
        if (block.type === 'reasoning') yield { type: 'reasoning-delta', index, text: block.text };
        if (block.type === 'tool-call') yield { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments };
        yield { type: 'block-end', index, block };
      }
      if (completion.usage) yield { type: 'usage', usage: {
        inputTokens: completion.usage.prompt_tokens ?? 0, outputTokens: completion.usage.completion_tokens ?? 0,
        ...(completion.usage.total_tokens === undefined ? {} : { totalTokens: completion.usage.total_tokens }),
      } };
      yield {
        type: 'finish', reason: { kind: message.tool_calls?.length ? 'tool-calls' : 'stop' },
        replayState: { response: { web3dMessage: message } },
      };
    }
  }

  try {
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(SessionStore);
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime, { mode: 'native' });
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 });
    ctx.llm.registerAdapter(['web3d'], new ProviderBridge());
    ctx.systemPrompt.section({ name: 'web3d', order: 0, text: options.systemPrompt, complete: true });
    ctx.on('agent/error', ({ error }) => { failure ??= error; });
    ctx.on('agent/pre-step', async (_input, next) => {
      if (calls > 0) {
        project();
        await options.onSave();
      }
      if (calls >= options.maxSteps) {
        limited = true;
        return { kind: 'reject' };
      }
      return next();
    });
    ctx.on('session/event', (session, event) => {
      if (session !== agent?.session) return;
      if (event.type === 'tool/call') {
        try {
          const input: unknown = JSON.parse(event.data.arguments);
          if (input && typeof input === 'object' && !Array.isArray(input)) emit({ type: 'tool_start', name: event.data.name, input: input as Record<string, unknown> });
        } catch { /* 非法参数由工具门禁生成配对错误结果。 */ }
      }
      if (event.type === 'tool/result') {
        const id = String(event.data.message.toolCallId);
        if (event.data.error?.code === 'ABORTED_BEFORE_DISPATCH') interruptedCalls.add(id);
        const name = toolNames.get(id);
        if (name) emit({ type: 'tool_end', name, result: toMessage(event.data.message).content!, isError: event.data.message.isError === true });
      }
    });
    ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        const input: unknown = JSON.parse(rawArguments.get(String(exec.callId)) ?? '');
        if (!input || typeof input !== 'object' || Array.isArray(input)) return { kind: 'deny', reason: '工具参数必须是 JSON 对象' };
        const tool = options.tools.find(item => item.name === exec.name);
        if (!tool) return { kind: 'deny', reason: `未知工具：${exec.name}` };
        if (options.mode === 'plan' && tool.kind !== 'read') return { kind: 'deny', reason: 'plan 模式仅允许读取与检查' };
        if (tool.kind !== 'read') {
          const automatic = (tool.kind === 'write' && options.mode === 'auto-edit') || (tool.kind === 'command' && options.allowRun);
          if (!automatic && !await options.approve({ tool: tool.name, kind: tool.kind, input: input as Record<string, unknown> })) return { kind: 'deny', reason: '用户未批准此操作' };
        }
        return next();
      } catch (error) {
        return { kind: 'deny', reason: error instanceof Error ? error.message : String(error) };
      }
    });
    ctx.on('tools/post-execute', async (exec, outcome, next) => {
      if (errorResults.has(String(exec.callId)) && !outcome.isError) return { kind: 'block', feedback: outcome.content };
      return next();
    });
    for (const tool of options.tools) ctx.tools.register({
      name: tool.name, description: tool.description, parameters: tool.parameters,
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(input, exec) {
        const output = await tool.execute(input as Record<string, unknown>, { cwd: options.session.cwd, signal: exec.signal, readState: options.readState });
        if (output !== null && typeof output === 'object' && 'isError' in output && output.isError === true) errorResults.add(String(exec.callId));
        return resultString(output);
      },
      finalizeContent(_exec, outcome) {
        return [{ type: 'text', text: resultString(textContent(outcome.content)) }];
      },
    });
    handle = await ctx.agents.create({
      sessionId: SessionId(`web3d-${options.session.id}-${randomUUID()}`),
      agentOptions: { provider: 'web3d', model: options.model ?? 'configured' }, meta: { cwd: options.session.cwd },
    });
    agent = handle.agent;
    options.signal.addEventListener('abort', cancel, { once: true });
    if (options.signal.aborted) result = 'aborted';
    else {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: options.prompt }], source: { kind: 'user' } }));
      await agent.whenIdle();
      const end = agent.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1);
      if (failure !== undefined) throw failure;
      if (options.signal.aborted || end?.data.reason?.kind === 'aborted') result = 'aborted';
      else if (limited) result = 'max_steps';
      else if (end?.data.reason?.kind === 'completed') result = 'completed';
      else throw new Error(`DSH 任务未正常完成（${end?.data.reason?.kind ?? '缺少结束事件'}）`);
    }
  } catch (error) {
    failure ??= error;
  } finally {
    options.signal.removeEventListener('abort', cancel);
    // DSH 的取消是协作式的，先等工具退出，再投影和持久化，最后释放整个 Cordis 生命周期。
    try {
      await agent?.whenIdle();
      if (agent) { project(); await options.onSave(); }
    } catch (error) { failure ??= error; }
    try { await handle?.dispose(); } catch (error) { failure ??= error; }
    try { await ctx.fiber.dispose(); } catch (error) { failure ??= error; }
  }
  if (failure !== undefined) throw failure;
  return result;
}
