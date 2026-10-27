import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Message, Session } from './types.js';

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export function createSession(cwd: string): Session {
  const now = new Date().toISOString();
  return { version: 1, id: randomUUID(), cwd: path.resolve(cwd), createdAt: now, updatedAt: now, messages: [] };
}

async function sessionDir(cwd: string): Promise<string> {
  const root = await realpath(cwd);
  // 会话存储不能跟随项目中的符号链接写到其他位置。
  let current = root;
  for (const part of ['.web3d-agent', 'sessions']) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('会话目录必须是普通目录');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
  return current;
}

export function validateMessages(input: unknown): Message[] {
  if (!Array.isArray(input) || input.length > 10_000) throw new Error('会话消息格式不正确');
  let pending = new Set<string>();
  const used = new Set<string>();
  for (const raw of input) {
    if (!raw || typeof raw !== 'object' || !['user', 'assistant', 'tool'].includes(raw.role)) throw new Error('会话包含非法角色');
    if (raw.content !== null && typeof raw.content !== 'string') throw new Error('会话消息内容不正确');
    if (raw.role === 'assistant' && raw.tool_calls !== undefined) {
      if (pending.size || !Array.isArray(raw.tool_calls) || !raw.tool_calls.length) throw new Error('会话工具调用未配对');
      for (const call of raw.tool_calls) {
        if (typeof call?.id !== 'string' || !call.id || used.has(call.id) || call.type !== 'function' ||
            typeof call.function?.name !== 'string' || typeof call.function?.arguments !== 'string') throw new Error('会话工具调用格式不正确');
        used.add(call.id);
        pending.add(call.id);
      }
    } else if (raw.role === 'tool') {
      if (!pending.delete(raw.tool_call_id)) throw new Error('会话工具结果没有对应调用');
    } else if (pending.size) throw new Error('会话包含未完成的工具调用');
  }
  if (pending.size) throw new Error('会话包含未完成的工具调用');
  return input as Message[];
}

export async function saveSession(session: Session): Promise<void> {
  if (!ID.test(session.id)) throw new Error('无效会话 ID');
  validateMessages(session.messages);
  const dir = await sessionDir(session.cwd);
  session.updatedAt = new Date().toISOString();
  const temp = path.join(dir, `${session.id}.${randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify(session, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temp, path.join(dir, `${session.id}.json`));
}

export async function listSessions(cwd: string): Promise<Session[]> {
  const dir = await sessionDir(cwd);
  const entries = await readdir(dir, { withFileTypes: true });
  const sessions: Session[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !ID.test(entry.name.replace(/\.json$/, ''))) continue;
    try { sessions.push(await readSession(cwd, entry.name.replace(/\.json$/, ''))); } catch { /* 损坏的单个会话不阻止列出其他记录。 */ }
  }
  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function readSession(cwd: string, id: string): Promise<Session> {
  if (!ID.test(id)) throw new Error('无效会话 ID');
  const file = path.join(await sessionDir(cwd), `${id}.json`);
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error('会话文件不正确或过大');
  const data = JSON.parse(await readFile(file, 'utf8')) as Session;
  if (data.version !== 1 || data.id !== id || typeof data.cwd !== 'string' ||
      await realpath(data.cwd) !== await realpath(cwd) || typeof data.updatedAt !== 'string' || typeof data.createdAt !== 'string') {
    throw new Error('会话版本、标识或工作目录不匹配');
  }
  validateMessages(data.messages);
  data.cwd = path.resolve(cwd);
  return data;
}
