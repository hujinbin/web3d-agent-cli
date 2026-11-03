import type { AgentEvent, ApprovalRequest, Message, ModelProvider, PermissionMode, Session, ToolDefinition } from './types.js';

export interface RunOptions {
  provider: ModelProvider;
  model?: string;
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

export function resultString(value: unknown): string {
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

// 保留原有调用入口，会话和测试与 CLI 统一使用 DSH 执行核心。
export async function runAgent(options: RunOptions): Promise<'completed' | 'max_steps' | 'aborted'> {
  const { runDshAgent } = await import('./runtime/dsh.js');
  return runDshAgent(options);
}
