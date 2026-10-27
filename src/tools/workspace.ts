import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as sync from 'node:fs';
import path from 'node:path';
import type { ToolContext } from '../types.js';

export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_OUTPUT_CHARS = 24_000;
export const IGNORED_DIRECTORIES = new Set([
  '.git', 'node_modules', 'dist', 'build', '.venv', 'venv', '__pycache__',
  '.pytest_cache', '.mypy_cache', '.next', '.idea', '.vscode', 'coverage',
]);

export function checkAbort(context: ToolContext): void {
  context.signal.throwIfAborted();
}

export function inputKeys(input: Record<string, unknown>, allowed: string[]): void {
  const extra = Object.keys(input).filter(key => !allowed.includes(key));
  if (extra.length) throw new Error(`未知参数：${extra.join(', ')}`);
}

export function textArg(input: Record<string, unknown>, key: string, fallback?: string): string {
  const value = input[key] ?? fallback;
  if (typeof value !== 'string' || value.includes('\0')) throw new Error(`${key} 必须为不含空字符的字符串`);
  return value;
}

export function integerArg(input: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = input[key] ?? fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} 必须为 ${min} 到 ${max} 之间的整数`);
  }
  return value;
}

export function isBlocked(relative: string): boolean {
  const segments = relative.replaceAll('\\', '/').toLowerCase().split('/');
  if (segments.includes('.git')) return true;
  if (segments.some((part, index) => part === '.web3d-agent' && segments[index + 1] === 'sessions')) return true;
  return segments.some(part => {
    if (part === '.env' || (part.startsWith('.env.') && !/^\.env\.(example|sample|template)$/.test(part))) return true;
    return /\.(pem|key|p12|pfx|jks)$/.test(part) || /^(id_rsa|id_ed25519|credentials|\.npmrc|\.pypirc)$/.test(part);
  });
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function workspacePath(context: ToolContext, input: string): Promise<string> {
  checkAbort(context);
  if (input.includes('\0') || input.replaceAll('\\', '/').split('/').includes('..')) throw new Error('路径不允许使用 .. 跳转');
  if (process.platform === 'win32' && input.replace(/^[a-z]:/i, '').includes(':')) throw new Error('不支持 Windows 备用数据流路径');
  const root = await fs.realpath(context.cwd);
  const target = path.resolve(root, input);
  if (!isInside(root, target)) throw new Error('路径超出当前工作区');
  if (isBlocked(path.relative(root, target))) throw new Error('禁止访问版本库内部、会话记录或凭据文件');
  try {
    if ((await fs.lstat(target)).isSymbolicLink()) {
      let directoryLink = false;
      try { directoryLink = (await fs.stat(target)).isDirectory(); } catch { /* 悬空链接不作为新文件处理。 */ }
      if (!directoryLink) throw new Error('不支持文件符号链接，请直接访问工作区内的真实文件路径');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  // 新文件也需要检查最近已存在的父目录，防止经符号链接写出工作区。
  let existing = target;
  while (true) {
    try {
      const real = await fs.realpath(existing);
      if (!isInside(root, real) || isBlocked(path.relative(root, real))) throw new Error('符号链接指向受限路径或工作区之外');
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
}

export function fingerprint(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export async function readText(file: string): Promise<string> {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('目标不是普通文件');
    if (stat.size > MAX_FILE_BYTES) throw new Error('文件超过 1 MiB，请缩小目标范围');
    // 多读一个字节，避免文件在 stat 后增长导致无界读取。
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const result = await handle.read(buffer, total, buffer.length - total, null);
      if (!result.bytesRead) break;
      total += result.bytesRead;
    }
    if (total > MAX_FILE_BYTES) throw new Error('文件超过 1 MiB，请缩小目标范围');
    const data = buffer.subarray(0, total);
    if (data.includes(0)) throw new Error('不支持读取二进制文件');
    try {
      // 保留 BOM，使异步读取与写入前同步检查的 UTF-8 哈希保持一致。
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
    } catch {
      throw new Error('文件不是有效 UTF-8 文本');
    }
  } finally {
    await handle.close();
  }
}

export interface WalkResult { files: string[]; truncated: boolean }

export async function walkFiles(context: ToolContext, start: string, depth: number, limit = 2000): Promise<WalkResult> {
  const files: string[] = [];
  let outputChars = 0;
  let visited = 0;
  let truncated = false;
  const root = await fs.realpath(context.cwd);
  const stat = await fs.stat(start);
  if (stat.isFile()) return { files: [path.relative(root, start).replaceAll('\\', '/')], truncated: false };
  const visit = async (directory: string, remaining: number): Promise<void> => {
    checkAbort(context);
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (++visited > 10_000 || files.length >= limit) { truncated = true; return; }
      const target = path.join(directory, entry.name);
      const relative = path.relative(root, target).replaceAll('\\', '/');
      if (entry.isSymbolicLink() || isBlocked(relative)) continue;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name) && remaining > 0) await visit(target, remaining - 1);
      } else if (entry.isFile()) {
        if (outputChars + relative.length + 4 > MAX_OUTPUT_CHARS - 100) { truncated = true; return; }
        files.push(relative);
        outputChars += relative.length + 4;
      }
      if (truncated) return;
    }
  };
  await visit(start, depth);
  return { files, truncated };
}

export function checkedWrite(context: ToolContext, target: string, content: string, mustExist = false): { path: string; bytes: number } {
  checkAbort(context);
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error('写入内容超过 1 MiB');
  const exists = sync.existsSync(target);
  if (mustExist && !exists) throw new Error('文件不存在');
  if (exists) {
    const stat = sync.statSync(target);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('目标不是可编辑的小型普通文件');
    const current = sync.readFileSync(target, 'utf8');
    const expected = context.readState.get(target);
    if (!expected || fingerprint(current) !== expected) throw new Error('文件未完整读取，或内容已变化；请重新完整读取后再修改');
  }
  sync.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.web3d-write-${randomUUID()}.tmp`);
  try {
    // 检查和写入之间不让出事件循环；此处不提供跨进程文件锁保证。
    sync.writeFileSync(temporary, content, { flag: 'wx', mode: exists ? sync.statSync(target).mode : 0o600 });
    sync.renameSync(temporary, target);
  } finally {
    try { sync.unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  context.readState.set(target, fingerprint(content));
  return { path: path.relative(context.cwd, target).replaceAll('\\', '/'), bytes: Buffer.byteLength(content, 'utf8') };
}
