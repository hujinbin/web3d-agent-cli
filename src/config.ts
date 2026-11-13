import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { AgentConfig } from './types.js';

const MAX_CONFIG_BYTES = 16 * 1024;
const pendingSaves = new Map<string, Promise<Partial<AgentConfig>>>();

export type ConfigSource = 'user' | 'project' | 'environment' | 'cli' | 'default';
export type ConfigSources = Record<keyof AgentConfig, ConfigSource>;

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

export function getUserConfigDir(): string {
  const configured = process.env.WEB3D_CONFIG_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.web3d-agent');
}

function validatePartial(value: unknown): Partial<AgentConfig> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置必须是 JSON 对象');
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).filter(key => !Object.hasOwn(DEFAULT_CONFIG, key));
  if (unknown.length) throw new Error(`未知配置字段：${unknown.join(', ')}。密钥请交给凭据存储或环境变量`);
  const config: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(input)) {
    if (item !== undefined) config[key] = item;
  }
  for (const key of ['baseUrl', 'model', 'apiKeyEnv'] as const) {
    if (!Object.hasOwn(config, key)) continue;
    if (typeof config[key] !== 'string') throw new Error(`${key} 必须是字符串`);
    config[key] = config[key].trim();
  }
  if (Object.hasOwn(config, 'baseUrl')) {
    let url: URL;
    try { url = new URL(config.baseUrl as string); }
    catch { throw new Error('baseUrl 必须是合法的绝对地址'); }
    if (url.username || url.password || url.search || url.hash) {
      throw new Error('baseUrl 不能包含凭证、查询参数或片段');
    }
  }
  if (Object.hasOwn(config, 'apiKeyEnv') && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.apiKeyEnv as string)) {
    throw new Error('apiKeyEnv 必须是环境变量名称');
  }
  const ranges: [keyof AgentConfig, number, number][] = [
    ['maxSteps', 1, 100], ['contextChars', 8_000, 1_000_000],
    ['maxOutputTokens', 256, 65_536], ['requestTimeoutMs', 100, 600_000],
  ];
  for (const [key, low, high] of ranges) {
    if (!Object.hasOwn(config, key)) continue;
    const item = config[key];
    if (typeof item !== 'number' || !Number.isInteger(item) || item < low || item > high) {
      throw new Error(`${key} 必须是 ${low}～${high} 之间的整数`);
    }
  }
  if (Object.hasOwn(config, 'stream') && typeof config.stream !== 'boolean') throw new Error('stream 必须是布尔值');
  return config as Partial<AgentConfig>;
}

async function readConfigFile(file: string, label: string): Promise<Partial<AgentConfig>> {
  try {
    const handle = await open(file, constants.O_RDONLY);
    let text: string;
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw new Error('配置来源不是普通文件');
      if (metadata.size > MAX_CONFIG_BYTES) throw new Error('配置文件超过 16 KiB');
      const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const result = await handle.read(buffer, bytes, buffer.length - bytes, null);
        if (!result.bytesRead) break;
        bytes += result.bytesRead;
      }
      if (bytes > MAX_CONFIG_BYTES) throw new Error('配置文件超过 16 KiB');
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes));
    } finally {
      await handle.close();
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch { throw new Error('配置不是有效 JSON'); }
    return validatePartial(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`无法加载${label}：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readUserFile(directory: string): Promise<Partial<AgentConfig>> {
  try {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('用户配置目录必须是实际目录');
    const file = path.join(directory, 'config.json');
    try {
      if ((await lstat(file)).isSymbolicLink()) throw new Error('用户配置文件不能是符号链接');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return await readConfigFile(file, '用户配置 config.json');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export async function readUserConfig(): Promise<Partial<AgentConfig>> {
  return readUserFile(getUserConfigDir());
}

export async function saveUserConfig(patch: Partial<AgentConfig>): Promise<Partial<AgentConfig>> {
  const directory = getUserConfigDir();
  const validated = validatePartial(patch);
  const file = path.join(directory, 'config.json');
  const previous = pendingSaves.get(file) ?? Promise.resolve({});
  // 同一进程的并行设置依次合并，避免不同字段互相覆盖。
  const operation = previous.catch(() => ({})).then(async () => {
    const current = await readUserFile(directory);
    const merged = { ...current, ...validated };
    const text = `${JSON.stringify(merged, null, 2)}\n`;
    if (Buffer.byteLength(text, 'utf8') > MAX_CONFIG_BYTES) throw new Error('用户配置超过 16 KiB');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('用户配置目录必须是实际目录');
    await chmod(directory, 0o700);
    const temporary = path.join(directory, `.config-${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(text, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, file);
    } finally {
      await unlink(temporary).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
    return merged;
  });
  pendingSaves.set(file, operation);
  try { return await operation; }
  finally { if (pendingSaves.get(file) === operation) pendingSaves.delete(file); }
}

function projectOverrides(project: Partial<AgentConfig>): Partial<AgentConfig> {
  const keys = Object.keys(DEFAULT_CONFIG) as (keyof AgentConfig)[];
  const legacyTemplate = project.model === '' && project.baseUrl === DEFAULT_CONFIG.baseUrl && keys.every(key => Object.hasOwn(project, key));
  if (!legacyTemplate) return project;
  // 旧 init 写入完整默认模板，仍为默认的字段应继承用户设置，保留已经修改的项目值。
  return Object.fromEntries(Object.entries(project).filter(([key, value]) => value !== DEFAULT_CONFIG[key as keyof AgentConfig]));
}

export async function loadConfigWithSource(cwd: string, overrides: Partial<AgentConfig> = {}): Promise<{ config: AgentConfig; sources: ConfigSources }> {
  const [user, project] = await Promise.all([
    readUserConfig(),
    readConfigFile(path.join(cwd, 'web3d-agent.json'), '项目配置 web3d-agent.json'),
  ]);
  const environment: Partial<AgentConfig> = {};
  if (process.env.WEB3D_BASE_URL) environment.baseUrl = process.env.WEB3D_BASE_URL;
  if (process.env.WEB3D_MODEL) environment.model = process.env.WEB3D_MODEL;
  const layers: [ConfigSource, Partial<AgentConfig>][] = [
    ['user', user], ['project', projectOverrides(project)],
    ['environment', validatePartial(environment)], ['cli', validatePartial(overrides)],
  ];
  const config = { ...DEFAULT_CONFIG };
  const sources = Object.fromEntries(Object.keys(DEFAULT_CONFIG).map(key => [key, 'default'])) as ConfigSources;
  for (const [source, layer] of layers) {
    Object.assign(config, layer);
    for (const key of Object.keys(layer) as (keyof AgentConfig)[]) sources[key] = source;
  }
  return { config, sources };
}

export async function loadConfig(cwd: string, overrides: Partial<AgentConfig> = {}): Promise<AgentConfig> {
  return (await loadConfigWithSource(cwd, overrides)).config;
}
