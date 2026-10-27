import { randomUUID } from 'node:crypto';
import type { Completion, Message, ModelProvider, ToolDefinition } from '../types.js';

export class DemoProvider implements ModelProvider {
  async complete(messages: Message[], tools: ToolDefinition[], signal: AbortSignal, onText?: (text: string) => void): Promise<Completion> {
    signal.throwIfAborted();
    const lastUser = messages.findLastIndex(message => message.role === 'user');
    const observed = messages.slice(lastUser + 1).filter(message => message.role === 'tool');
    const next = ['list_files', 'check_project'][observed.length];
    if (next && tools.some(tool => tool.name === next)) {
      return {
        finishReason: 'tool_calls',
        message: { role: 'assistant', content: null, tool_calls: [{ id: `demo_${randomUUID()}`, type: 'function', function: { name: next, arguments: next === 'list_files' ? '{"path":".","max_depth":2}' : '{}' } }] },
      };
    }
    const results = observed.map(message => message.content ?? '').join('\n').slice(0, 12_000);
    const text = `离线演示完成：以上由固定脚本调用工具，不是模型推理，也没有调用收费接口。\n\n工具观察结果：\n${results || '当前没有可执行的演示工具。'}\n\n连接兼容 OpenAI 的模型接口后，可继续根据项目规则执行 Three.js 和 Python 后端开发任务。`;
    onText?.(text);
    return { message: { role: 'assistant', content: text }, finishReason: 'stop' };
  }
}
