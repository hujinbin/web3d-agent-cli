import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentConfig } from './types.js';

export const DEFAULT_CONFIG: AgentConfig = {
  baseUrl: 'https://api.openai.com/v1',
  model: '',
  apiKeyEnv: 'WEB3D_API_KEY',
  maxSteps: 20,
  contextChars: 100_000,
  maxOutputTokens: 4096,
  requestTimeoutMs: 120_000,
  stream: true,
};

export async function loadConfig(cwd: string, overrides: Partial<AgentConfig> = {}): Promise<AgentConfig> {
  let local: Record<string, unknown> = {};
  try {
    const raw = await readFile(path.join(cwd, 'web3d-agent.json'), 'utf8');
    if (raw.length > 16_384) throw new Error('配置文件超过 16 KiB');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('配置必须是 JSON 对象');
    local = parsed as Record<string, unknown>;
    const unknown = Object.keys(local).filter(key => !(key in DEFAULT_CONFIG));
    if (unknown.length) throw new Error(`未知配置字段：${unknown.join(', ')}。密钥请保存在环境变量中`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`无法加载 web3d-agent.json：${(error as Error).message}`);
  }
  const env: Partial<AgentConfig> = {};
  if (process.env.WEB3D_BASE_URL) env.baseUrl = process.env.WEB3D_BASE_URL;
  if (process.env.WEB3D_MODEL) env.model = process.env.WEB3D_MODEL;
  const config = { ...DEFAULT_CONFIG, ...local, ...env, ...overrides } as AgentConfig;
  for (const key of ['baseUrl', 'model', 'apiKeyEnv'] as const) {
    if (typeof config[key] !== 'string') throw new Error(`${key} 必须是字符串`);
    config[key] = config[key].trim();
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.apiKeyEnv)) throw new Error('apiKeyEnv 必须是环境变量名称');
  const ranges: [keyof AgentConfig, number, number][] = [
    ['maxSteps', 1, 100], ['contextChars', 8_000, 1_000_000],
    ['maxOutputTokens', 256, 65_536], ['requestTimeoutMs', 100, 600_000],
  ];
  for (const [key, low, high] of ranges) {
    const value = config[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < low || value > high) {
      throw new Error(`${key} 必须是 ${low}～${high} 之间的整数`);
    }
  }
  if (typeof config.stream !== 'boolean') throw new Error('stream 必须是布尔值');
  return config;
}
