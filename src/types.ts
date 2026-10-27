export type PermissionMode = 'ask' | 'auto-edit' | 'plan';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface Completion {
  message: Message;
  finishReason: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export interface ModelProvider {
  complete(messages: Message[], tools: ToolDefinition[], signal: AbortSignal, onText?: (text: string) => void): Promise<Completion>;
}

export interface ApprovalRequest {
  tool: string;
  kind: 'write' | 'command';
  input: Record<string, unknown>;
}

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  readState: Map<string, string>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  kind: 'read' | 'write' | 'command';
  execute(input: Record<string, unknown>, context: ToolContext): Promise<unknown>;
}

export interface Rule {
  name: string;
  source: string;
  content: string;
}

export interface LoadedRules {
  rules: Rule[];
  warnings: string[];
}

export interface AgentConfig {
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  maxSteps: number;
  contextChars: number;
  maxOutputTokens: number;
  requestTimeoutMs: number;
  stream: boolean;
}

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_start'; name: string; input: Record<string, unknown> }
  | { type: 'tool_end'; name: string; result: string; isError: boolean }
  | { type: 'context_trimmed'; removed: number }
  | { type: 'status'; text: string };

export interface Session {
  version: 1;
  id: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
}
