import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { getUserConfigDir } from './config.js';

export type CredentialStorage = 'windows-dpapi' | 'macos-keychain' | 'linux-secret-service' | 'encrypted-file';

export interface CredentialCommand {
  file: string;
  args: string[];
  input: string;
  signal?: AbortSignal;
}

export interface CredentialCommandResult {
  stdout: string;
  exitCode: number;
}

export interface CredentialOptions {
  directory?: string;
  signal?: AbortSignal;
  // 测试可注入平台与执行器，正式调用沿用当前系统。
  platform?: NodeJS.Platform;
  runCommand?: (command: CredentialCommand) => Promise<CredentialCommandResult>;
}

interface StoredCredential {
  version: 1;
  endpoint: string;
  backend: CredentialStorage;
  ciphertext?: string;
  iv?: string;
  tag?: string;
}

const MAX_KEY_BYTES = 2048;
const MAX_FILE_BYTES = 32 * 1024;
const SERVICE = 'web3d-agent-cli';

class CredentialError extends Error {}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('凭据操作已取消。', 'AbortError');
}

export function normalizeCredentialBaseUrl(baseUrl: string): string {
  let url: URL;
  try { url = new URL(baseUrl.trim()); } catch { throw new CredentialError('Base URL 必须是合法的绝对地址。'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) {
    throw new CredentialError('Base URL 仅允许 HTTPS 或本机 HTTP，且不能包含凭证、查询参数或片段。');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/chat/completions')) url.pathname += '/chat/completions';
  return url.toString();
}

function validateKey(key: string): void {
  if (typeof key !== 'string' || !key.trim() || /[\x00-\x1f\x7f]/.test(key) || Buffer.byteLength(key, 'utf8') > MAX_KEY_BYTES) {
    throw new CredentialError('API Key 为空、含控制字符或超过 2048 字节。');
  }
}

function accountFor(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex');
}

function credentialDirectory(options: CredentialOptions): string {
  return path.join(options.directory ?? getUserConfigDir(), 'credentials');
}

async function ensureDirectory(directory: string): Promise<void> {
  const parent = path.dirname(directory);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new CredentialError('用户凭据目录必须是普通目录。');
  await mkdir(directory, { mode: 0o700 }).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new CredentialError('凭据目录必须是普通目录。');
  if (process.platform !== 'win32') await chmod(directory, 0o700);
}

async function readPrivateFile(file: string, limit = MAX_FILE_BYTES): Promise<Buffer> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new CredentialError('凭据存储必须是普通文件。');
  if (process.platform !== 'win32') await chmod(file, 0o600);
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(limit + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const { bytesRead } = await handle.read(buffer, bytes, buffer.length - bytes, null);
      if (!bytesRead) break;
      bytes += bytesRead;
    }
    if (bytes > limit) throw new CredentialError('凭据存储超过大小限制。');
    return buffer.subarray(0, bytes);
  } finally { await handle.close(); }
}

async function atomicWrite(file: string, data: string | Buffer, signal?: AbortSignal): Promise<void> {
  checkCancelled(signal);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally { await handle.close(); }
    checkCancelled(signal);
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => undefined); }
}

async function masterKey(directory: string, create: boolean, signal?: AbortSignal): Promise<Buffer> {
  const file = path.join(directory, 'master.key');
  try {
    const key = await readPrivateFile(file, 32);
    if (key.length !== 32) throw new CredentialError('本机凭据主密钥格式无效。');
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error;
  }
  // 完整写入临时文件后独占发布，避免并发初始化读到半截主密钥。
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await atomicWrite(temporary, randomBytes(32), signal);
    checkCancelled(signal);
    try { await link(temporary, file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } finally { await unlink(temporary).catch(() => undefined); }
  return masterKey(directory, false, signal);
}

async function runCommand(command: CredentialCommand): Promise<CredentialCommandResult> {
  checkCancelled(command.signal);
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let failure: Error | undefined;
    const stop = (error: Error): void => { failure ??= error; child.kill(); };
    const onAbort = (): void => stop(new DOMException('凭据操作已取消。', 'AbortError'));
    const timer = setTimeout(() => stop(new CredentialError('系统凭据服务响应超时。')), 30_000);
    timer.unref();
    command.signal?.addEventListener('abort', onAbort, { once: true });
    const collect = (data: Buffer, keep: boolean): void => {
      outputBytes += data.length;
      if (outputBytes > 64 * 1024) stop(new CredentialError('系统凭据服务输出超过大小限制。'));
      else if (keep) chunks.push(data);
    };
    child.stdout.on('data', (data: Buffer) => collect(data, true));
    child.stderr.on('data', (data: Buffer) => collect(data, false));
    // 子进程的错误和输出可能含回显，统一使用固定错误文本。
    child.on('error', () => { failure ??= new CredentialError('无法启动系统凭据服务。'); });
    child.stdin.on('error', () => { failure ??= new CredentialError('无法向系统凭据服务传入数据。'); });
    child.on('close', code => {
      clearTimeout(timer);
      command.signal?.removeEventListener('abort', onAbort);
      if (failure) reject(failure);
      else resolve({ stdout: Buffer.concat(chunks).toString('utf8'), exitCode: code ?? -1 });
    });
    if (command.signal?.aborted) onAbort();
    child.stdin.end(command.input);
  });
}

async function execute(options: CredentialOptions, file: string, args: string[], input = ''): Promise<CredentialCommandResult> {
  checkCancelled(options.signal);
  const result = await (options.runCommand ?? runCommand)({ file, args, input, signal: options.signal });
  checkCancelled(options.signal);
  return result;
}

function decodeBase64(value: string): Buffer {
  if (!value || value.length > MAX_FILE_BYTES || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new CredentialError('凭据数据格式无效。');
  }
  return Buffer.from(value, 'base64');
}

async function dpapi(endpoint: string, data: string, protect: boolean, options: CredentialOptions): Promise<string> {
  // 脚本固定在命令参数中，API Key 及密文仅通过标准输入传递。
  const script = `$ErrorActionPreference='Stop'; try { Add-Type -AssemblyName System.Security; $p=[Console]::In.ReadToEnd()|ConvertFrom-Json; $d=[Convert]::FromBase64String($p.data); $e=[Text.Encoding]::UTF8.GetBytes($p.endpoint); $r=[Security.Cryptography.ProtectedData]::${protect ? 'Protect' : 'Unprotect'}($d,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r)); } catch { exit 1 }`;
  const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = await execute(options, executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], JSON.stringify({ endpoint, data }));
  if (result.exitCode !== 0) throw new CredentialError('Windows 用户凭据加解密失败。');
  decodeBase64(result.stdout.trim());
  return result.stdout.trim();
}

async function saveSystemKey(endpoint: string, key: string, options: CredentialOptions): Promise<StoredCredential> {
  const platform = options.platform ?? process.platform;
  const account = accountFor(endpoint);
  const encoded = Buffer.from(key, 'utf8').toString('base64');
  if (platform === 'win32') {
    return { version: 1, endpoint, backend: 'windows-dpapi', ciphertext: await dpapi(endpoint, encoded, true, options) };
  }
  let result: CredentialCommandResult;
  let backend: CredentialStorage;
  if (platform === 'darwin') {
    // Base64 保证交互命令为单行且无需插入用户提供的转义字符。
    result = await execute(options, '/usr/bin/security', ['-i', '-q'], `add-generic-password -U -a ${account} -s ${SERVICE} -w ${encoded}\n`);
    backend = 'macos-keychain';
  } else if (platform === 'linux') {
    result = await execute(options, 'secret-tool', ['store', '--label=Web3D Agent API Key', 'application', SERVICE, 'endpoint', account], encoded);
    backend = 'linux-secret-service';
  } else throw new CredentialError('当前系统没有内置凭据服务适配。');
  if (result.exitCode !== 0) throw new CredentialError('系统凭据服务保存失败。');
  return { version: 1, endpoint, backend };
}

async function readRecord(endpoint: string, directory: string): Promise<StoredCredential | undefined> {
  let bytes: Buffer;
  try {
    for (const folder of [path.dirname(directory), directory]) {
      const info = await lstat(folder);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new CredentialError('用户凭据目录必须是普通目录。');
    }
    bytes = await readPrivateFile(path.join(directory, `${accountFor(endpoint)}.json`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const record: unknown = JSON.parse(bytes.toString('utf8'));
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new CredentialError('凭据存储格式无效。');
  const item = record as StoredCredential;
  if (item.version !== 1 || item.endpoint !== endpoint || !['windows-dpapi', 'macos-keychain', 'linux-secret-service', 'encrypted-file'].includes(item.backend)) {
    throw new CredentialError('凭据存储格式或地址绑定无效。');
  }
  return item;
}

function encryptedRecord(endpoint: string, key: string, encryptionKey: Buffer): StoredCredential {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
  cipher.setAAD(Buffer.from(endpoint, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
  return { version: 1, endpoint, backend: 'encrypted-file', ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

export function getCredentialStorageLabel(backend: CredentialStorage): string {
  const labels: Record<CredentialStorage, string> = {
    'windows-dpapi': 'Windows 当前用户 DPAPI',
    'macos-keychain': 'macOS 钥匙串',
    'linux-secret-service': 'Linux Secret Service',
    'encrypted-file': '本机加密文件（主密钥保存在当前用户目录）',
  };
  return labels[backend];
}

export async function saveApiKey(baseUrl: string, key: string, options: CredentialOptions = {}): Promise<CredentialStorage> {
  const endpoint = normalizeCredentialBaseUrl(baseUrl);
  validateKey(key);
  try {
    checkCancelled(options.signal);
    const directory = credentialDirectory(options);
    await ensureDirectory(directory);
    let record: StoredCredential;
    try { record = await saveSystemKey(endpoint, key, options); } catch {
      checkCancelled(options.signal);
      record = encryptedRecord(endpoint, key, await masterKey(directory, true, options.signal));
    }
    await atomicWrite(path.join(directory, `${accountFor(endpoint)}.json`), JSON.stringify(record), options.signal);
    return record.backend;
  } catch (error) {
    checkCancelled(options.signal);
    if (error instanceof CredentialError) throw error;
    throw new CredentialError('无法保存 API Key，请检查用户凭据目录或系统凭据服务。');
  }
}

export async function loadApiKey(baseUrl: string, options: CredentialOptions = {}): Promise<string | undefined> {
  const endpoint = normalizeCredentialBaseUrl(baseUrl);
  try {
    checkCancelled(options.signal);
    const directory = credentialDirectory(options);
    const record = await readRecord(endpoint, directory);
    checkCancelled(options.signal);
    if (!record) return undefined;
    let key: string;
    if (record.backend === 'windows-dpapi') {
      if (typeof record.ciphertext !== 'string') throw new CredentialError('凭据密文格式无效。');
      key = decodeBase64(await dpapi(endpoint, record.ciphertext, false, options)).toString('utf8');
    } else if (record.backend === 'encrypted-file') {
      if (typeof record.iv !== 'string' || typeof record.tag !== 'string' || typeof record.ciphertext !== 'string') throw new CredentialError('凭据密文格式无效。');
      const decipher = createDecipheriv('aes-256-gcm', await masterKey(directory, false, options.signal), decodeBase64(record.iv));
      decipher.setAAD(Buffer.from(endpoint, 'utf8'));
      decipher.setAuthTag(decodeBase64(record.tag));
      key = Buffer.concat([decipher.update(decodeBase64(record.ciphertext)), decipher.final()]).toString('utf8');
    } else {
      const account = accountFor(endpoint);
      const result = record.backend === 'macos-keychain'
        ? await execute(options, '/usr/bin/security', ['find-generic-password', '-a', account, '-s', SERVICE, '-w'])
        : await execute(options, 'secret-tool', ['lookup', 'application', SERVICE, 'endpoint', account]);
      if (result.exitCode === 44 || (record.backend === 'linux-secret-service' && result.exitCode === 1)) return undefined;
      if (result.exitCode !== 0) throw new CredentialError('系统凭据服务读取失败。');
      key = decodeBase64(result.stdout.trim()).toString('utf8');
    }
    checkCancelled(options.signal);
    validateKey(key);
    return key;
  } catch (error) {
    checkCancelled(options.signal);
    if (error instanceof CredentialError) throw error;
    throw new CredentialError('无法读取 API Key，请重新运行 setup 保存凭据。');
  }
}

export async function deleteApiKey(baseUrl: string, options: CredentialOptions = {}): Promise<void> {
  const endpoint = normalizeCredentialBaseUrl(baseUrl);
  try {
    checkCancelled(options.signal);
    const directory = credentialDirectory(options);
    const record = await readRecord(endpoint, directory);
    checkCancelled(options.signal);
    if (!record) return;
    const account = accountFor(endpoint);
    if (record.backend === 'macos-keychain' || record.backend === 'linux-secret-service') {
      const result = record.backend === 'macos-keychain'
        ? await execute(options, '/usr/bin/security', ['delete-generic-password', '-a', account, '-s', SERVICE])
        : await execute(options, 'secret-tool', ['clear', 'application', SERVICE, 'endpoint', account]);
      if (result.exitCode !== 0 && result.exitCode !== 44 && !(record.backend === 'linux-secret-service' && result.exitCode === 1)) {
        throw new CredentialError('系统凭据服务删除失败。');
      }
    }
    checkCancelled(options.signal);
    await unlink(path.join(directory, `${account}.json`)).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  } catch (error) {
    checkCancelled(options.signal);
    if (error instanceof CredentialError) throw error;
    throw new CredentialError('无法删除已保存的 API Key。');
  }
}
