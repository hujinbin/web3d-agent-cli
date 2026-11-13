import { stripVTControlCharacters } from 'node:util';
import { DEFAULT_CONFIG, getUserConfigDir, saveUserConfig } from './config.js';
import { getCredentialStorageLabel, loadApiKey, normalizeCredentialBaseUrl, saveApiKey } from './credentials.js';
import { completionEndpoint } from './providers/openai.js';
import type { AgentConfig } from './types.js';

export interface SetupIO {
  question(prompt: string, options?: { signal?: AbortSignal }): Promise<string>;
  secret(prompt: string, options?: { signal?: AbortSignal }): Promise<string>;
  write(text: string): void;
}

export interface SetupOptions {
  current: AgentConfig;
  apiKey?: string;
  io: SetupIO;
  signal: AbortSignal;
  modelsOnly?: boolean;
}

export interface ModelSetup {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

const clean = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200);

export async function listModels(baseUrl: string, apiKey: string | undefined, signal: AbortSignal): Promise<string[]> {
  const url = new URL(completionEndpoint(baseUrl));
  url.pathname = url.pathname.replace(/\/chat\/completions$/, '/models');
  const response = await fetch(url, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]), redirect: 'error',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (!response.body) throw new Error('响应为空');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 256 * 1024) throw new Error('模型列表过大');
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== 'object' || !('data' in data) || !Array.isArray(data.data)) throw new Error('模型列表格式不兼容');
  return [...new Set(data.data.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object' || !('id' in item) || typeof item.id !== 'string') return [];
    const id = item.id.trim();
    return id && id.length <= 200 && !/[\x00-\x1f\x7f]/.test(id) ? [id] : [];
  }))].slice(0, 200);
}

export async function configureModel({ current, apiKey: currentKey, io, signal, modelsOnly = false }: SetupOptions): Promise<ModelSetup> {
  const ask = async (label: string, fallback = '') => {
    signal.throwIfAborted();
    const answer = (await io.question(`${label}${fallback ? ` [${clean(fallback)}]` : ''} › `, { signal })).trim();
    signal.throwIfAborted();
    return answer || fallback;
  };
  let baseUrl = modelsOnly ? current.baseUrl : '';
  let apiKey = currentKey;
  let supplied = '';
  if (!modelsOnly) {
    io.write('\n配置模型\n1 自定义 OpenAI 兼容接口\n2 DeepSeek\n3 OpenAI\n4 本地 Ollama\n');
    let choice = '';
    while (!['1', '2', '3', '4'].includes(choice)) choice = await ask('选择服务', '1');
    const presets: Record<string, string> = {
      '2': 'https://api.deepseek.com', '3': DEFAULT_CONFIG.baseUrl, '4': 'http://localhost:11434/v1',
    };
    baseUrl = presets[choice] ?? '';
    while (!baseUrl) {
      const answer = await ask('API 地址', current.baseUrl);
      try {
        baseUrl = completionEndpoint(answer).replace(/\/chat\/completions$/, '');
      } catch {
        io.write('请输入 HTTPS 地址或本机 HTTP 地址，例如 http://localhost:11434/v1。\n');
      }
  }
  const sameEndpoint = normalizeCredentialBaseUrl(baseUrl) === normalizeCredentialBaseUrl(current.baseUrl);
  apiKey = sameEndpoint ? currentKey : undefined;
  if (!apiKey) {
    try { apiKey = await loadApiKey(baseUrl, { signal }); }
    catch { signal.throwIfAborted(); io.write('已保存的密钥暂不可用，请重新输入。\n'); }
  }
  supplied = (await io.secret(apiKey ? 'API Key（隐藏输入，回车沿用已设置的密钥）› ' : 'API Key（隐藏输入，免认证接口可留空）› ', { signal })).trim();
  signal.throwIfAborted();
  apiKey = supplied || apiKey;
  }
  const sameEndpoint = normalizeCredentialBaseUrl(baseUrl) === normalizeCredentialBaseUrl(current.baseUrl);

  io.write('正在读取可用模型…\n');
  let models: string[] = [];
  try { models = await listModels(baseUrl, apiKey, signal); }
  catch {
    signal.throwIfAborted();
    io.write('接口的模型列表暂不可用，可以直接输入模型 ID。\n');
  }
  const shown = models.slice(0, 20);
  if (shown.length) io.write(shown.map((model, index) => `${index + 1} ${clean(model)}`).join('\n') + '\n');
  const defaultModel = sameEndpoint && current.model ? current.model : shown[0] ?? '';
  let model = '';
  while (!model) {
    const answer = await ask(shown.length ? '选择编号或输入模型 ID' : '模型 ID', defaultModel);
    if (/^\d+$/.test(answer) && shown.length) model = shown[Number(answer) - 1] ?? answer;
    else if (answer.length <= 200 && !/[\x00-\x1f\x7f]/.test(answer)) model = answer;
    if (!model) io.write('请输入有效的模型编号或模型 ID。\n');
  }
  signal.throwIfAborted();
  // 先保存凭据，再提交公开的模型设置，凭据保存失败时保留原模型配置。
  if (supplied) {
    const storage = await saveApiKey(baseUrl, supplied, { signal });
    io.write(`密钥已保存到${getCredentialStorageLabel(storage)}。\n`);
  }
  await saveUserConfig({ baseUrl, model, apiKeyEnv: current.apiKeyEnv });
  io.write(`已保存默认模型 ${clean(model)}\n配置目录 ${getUserConfigDir()}\n`);
  if (supplied && process.env[current.apiKeyEnv] && supplied !== process.env[current.apiKeyEnv]) {
    io.write(`当前环境变量 ${current.apiKeyEnv} 会在后续启动时优先生效，可移除该变量以使用刚保存的密钥。\n`);
  }
  return { baseUrl, model, apiKey };
}
