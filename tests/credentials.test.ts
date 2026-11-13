import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  deleteApiKey, getCredentialStorageLabel, loadApiKey, normalizeCredentialBaseUrl, saveApiKey,
  type CredentialCommand, type CredentialOptions,
} from '../src/credentials.js';

const BASE_URL = 'https://models.example.test/v1';
const FAKE_KEY = 'fake-key-for-local-test-only';

async function temporaryStore(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'web3d-credentials-'));
  try { await run(directory); } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(directory, { recursive: true, force: true });
  }
}

function fileFor(directory: string, baseUrl = BASE_URL): string {
  const account = createHash('sha256').update(normalizeCredentialBaseUrl(baseUrl)).digest('hex');
  return path.join(directory, 'credentials', `${account}.json`);
}

const unavailable: NonNullable<CredentialOptions['runCommand']> = async () => {
  throw new Error(`模拟系统错误可能回显 ${FAKE_KEY}`);
};

test('规范化绑定与 Provider 相同的最终接口地址', () => {
  assert.equal(normalizeCredentialBaseUrl(' HTTPS://MODELS.EXAMPLE.TEST:443/v1/// '), `${BASE_URL}/chat/completions`);
  assert.equal(normalizeCredentialBaseUrl(`${BASE_URL}/chat/completions/`), `${BASE_URL}/chat/completions`);
  assert.equal(normalizeCredentialBaseUrl('http://127.0.0.1:8000/v1'), 'http://127.0.0.1:8000/v1/chat/completions');
  assert.equal(normalizeCredentialBaseUrl('http://[::1]:8000/v1'), 'http://[::1]:8000/v1/chat/completions');
  for (const url of ['invalid', 'http://remote.test/v1', 'https://user:password@models.example.test/v1', `${BASE_URL}?key=secret`, `${BASE_URL}#fragment`, 'file:///tmp']) {
    assert.throws(() => normalizeCredentialBaseUrl(url), /Base URL/);
  }
});

test('系统服务不可用时 AES-GCM 保存、读取、轮换与删除，文件内无明文', async () => {
  await temporaryStore(async directory => {
    const options: CredentialOptions = { directory, platform: 'linux', runCommand: unavailable };
    assert.equal(await loadApiKey(BASE_URL, options), undefined);
    assert.equal(await saveApiKey(BASE_URL, FAKE_KEY, options), 'encrypted-file');
    assert.equal(await loadApiKey(`${BASE_URL}/chat/completions/`, options), FAKE_KEY);
    assert.equal(await loadApiKey('https://other.example.test/v1', options), undefined);
    assert.equal(await loadApiKey('https://models.example.test/another', options), undefined);
    const raw = await readFile(fileFor(directory), 'utf8');
    assert.equal(raw.includes(FAKE_KEY), false);
    assert.equal(raw.includes(Buffer.from(FAKE_KEY).toString('base64')), false);
    assert.match(getCredentialStorageLabel('encrypted-file'), /当前用户目录/);
    assert.equal((await readFile(path.join(directory, 'credentials', 'master.key'))).length, 32);
    if (process.platform !== 'win32') {
      assert.equal((await stat(path.join(directory, 'credentials'))).mode & 0o777, 0o700);
      assert.equal((await stat(fileFor(directory))).mode & 0o777, 0o600);
      assert.equal((await stat(path.join(directory, 'credentials', 'master.key'))).mode & 0o777, 0o600);
    }
    await saveApiKey(BASE_URL, 'fake-rotated-key', options);
    assert.equal(await loadApiKey(BASE_URL, options), 'fake-rotated-key');
    await deleteApiKey(BASE_URL, options);
    assert.equal(await loadApiKey(BASE_URL, options), undefined);
    await deleteApiKey(BASE_URL, options);
  });
});

test('并发首次保存多个地址共用完整主密钥且各自可读', async () => {
  await temporaryStore(async directory => {
    const options: CredentialOptions = { directory, platform: 'linux', runCommand: unavailable };
    const urls = Array.from({ length: 8 }, (_, index) => `https://models${index}.example.test/v1`);
    await Promise.all(urls.map((url, index) => saveApiKey(url, `fake-key-${index}`, options)));
    assert.deepEqual(await Promise.all(urls.map(url => loadApiKey(url, options))), urls.map((_, index) => `fake-key-${index}`));
    assert.equal((await readdir(path.join(directory, 'credentials'))).filter(file => file.endsWith('.tmp')).length, 0);
  });
});

test('密文篡改、地址错配、错误主密钥和过大文件均报固定错误', async () => {
  await temporaryStore(async directory => {
    const options: CredentialOptions = { directory, platform: 'linux', runCommand: unavailable };
    await saveApiKey(BASE_URL, FAKE_KEY, options);
    const original = await readFile(fileFor(directory), 'utf8');
    const record = JSON.parse(original);
    record.ciphertext = Buffer.from('tampered-ciphertext').toString('base64');
    await writeFile(fileFor(directory), JSON.stringify(record));
    await assert.rejects(loadApiKey(BASE_URL, options), error => !String(error).includes(FAKE_KEY));
    record.endpoint = 'https://other.example.test/v1/chat/completions';
    await writeFile(fileFor(directory), JSON.stringify(record));
    await assert.rejects(loadApiKey(BASE_URL, options), /地址绑定/);
    await writeFile(fileFor(directory), original);
    await writeFile(path.join(directory, 'credentials', 'master.key'), 'broken');
    await assert.rejects(loadApiKey(BASE_URL, options), /主密钥格式/);
    await writeFile(fileFor(directory), 'x'.repeat(40 * 1024));
    await assert.rejects(loadApiKey(BASE_URL, options), /大小限制/);
  });
});

test('macOS 钥匙串仅通过 stdin 接收编码密钥并读取、删除', async () => {
  await temporaryStore(async directory => {
    const commands: CredentialCommand[] = [];
    const unusualKey = `fake-'"\\中文-${'x'.repeat(150)}`;
    const encoded = Buffer.from(unusualKey).toString('base64');
    const options: CredentialOptions = {
      directory, platform: 'darwin',
      runCommand: async command => {
        commands.push(command);
        assert.equal(command.args.join(' ').includes(unusualKey), false);
        assert.equal(command.args.join(' ').includes(encoded), false);
        return { exitCode: 0, stdout: command.args[0] === 'find-generic-password' ? `${encoded}\n` : '' };
      },
    };
    assert.equal(await saveApiKey(BASE_URL, unusualKey, options), 'macos-keychain');
    assert.deepEqual(commands[0]?.args, ['-i', '-q']);
    assert.equal(commands[0]?.input.endsWith(` -w ${encoded}\n`), true);
    assert.equal(await loadApiKey(BASE_URL, options), unusualKey);
    assert.equal((await readFile(fileFor(directory), 'utf8')).includes(encoded), false);
    await deleteApiKey(BASE_URL, options);
    assert.equal(commands.at(-1)?.args[0], 'delete-generic-password');
    assert.equal(await loadApiKey(BASE_URL, options), undefined);
  });
});

test('Linux Secret Service 存储与读取协议，缺失记录返回空', async () => {
  await temporaryStore(async directory => {
    const commands: CredentialCommand[] = [];
    let missing = false;
    const options: CredentialOptions = {
      directory, platform: 'linux',
      runCommand: async command => {
        commands.push(command);
        if (command.args[0] === 'lookup') return { exitCode: missing ? 1 : 0, stdout: missing ? '' : Buffer.from(FAKE_KEY).toString('base64') };
        return { exitCode: 0, stdout: '' };
      },
    };
    assert.equal(await saveApiKey(BASE_URL, FAKE_KEY, options), 'linux-secret-service');
    assert.equal(commands[0]?.file, 'secret-tool');
    assert.equal(commands[0]?.input, Buffer.from(FAKE_KEY).toString('base64'));
    assert.equal(commands[0]?.args.join(' ').includes(FAKE_KEY), false);
    assert.equal(await loadApiKey(BASE_URL, options), FAKE_KEY);
    missing = true;
    assert.equal(await loadApiKey(BASE_URL, options), undefined);
    await deleteApiKey(BASE_URL, options);
    assert.equal(commands.at(-1)?.args[0], 'clear');
  });
});

test('Windows DPAPI 标准输入协议不把密钥放进参数，系统失败可兜底', async () => {
  await temporaryStore(async directory => {
    const commands: CredentialCommand[] = [];
    const options: CredentialOptions = {
      directory, platform: 'win32',
      runCommand: async command => {
        commands.push(command);
        assert.equal(command.args.join(' ').includes(FAKE_KEY), false);
        const input = JSON.parse(command.input);
        assert.equal(input.endpoint, `${BASE_URL}/chat/completions`);
        return { exitCode: 0, stdout: command.args.at(-1)?.includes('::Unprotect') ? Buffer.from(FAKE_KEY).toString('base64') : Buffer.from('fake-dpapi-ciphertext').toString('base64') };
      },
    };
    assert.equal(await saveApiKey(BASE_URL, FAKE_KEY, options), 'windows-dpapi');
    assert.equal(await loadApiKey(BASE_URL, options), FAKE_KEY);
    assert.equal(JSON.parse(commands[0]!.input).data, Buffer.from(FAKE_KEY).toString('base64'));
    assert.equal(await saveApiKey(BASE_URL, FAKE_KEY, { ...options, runCommand: async () => ({ exitCode: 1, stdout: FAKE_KEY }) }), 'encrypted-file');
    assert.equal(await loadApiKey(BASE_URL, options), FAKE_KEY);
  });
});

test('取消系统命令后不写兜底凭据，已经保存的密钥仍可读', async () => {
  await temporaryStore(async directory => {
    const previous: CredentialOptions = { directory, platform: 'linux', runCommand: unavailable };
    await saveApiKey(BASE_URL, FAKE_KEY, previous);
    const controller = new AbortController();
    const options: CredentialOptions = {
      directory, platform: 'darwin', signal: controller.signal,
      runCommand: async command => {
        assert.equal(command.signal, controller.signal);
        controller.abort();
        throw new Error(`模拟外部错误回显 ${FAKE_KEY}`);
      },
    };
    await assert.rejects(saveApiKey(BASE_URL, 'fake-new-key', options), { name: 'AbortError' });
    assert.equal(await loadApiKey(BASE_URL, previous), FAKE_KEY);
    await assert.rejects(loadApiKey(BASE_URL, options), { name: 'AbortError' });
    await assert.rejects(deleteApiKey(BASE_URL, options), { name: 'AbortError' });
  });
});

test('读取系统失败时错误不暴露上游回显或密钥', async () => {
  await temporaryStore(async directory => {
    const options: CredentialOptions = { directory, platform: 'darwin', runCommand: async () => ({ exitCode: 0, stdout: '' }) };
    await saveApiKey(BASE_URL, FAKE_KEY, options);
    await assert.rejects(loadApiKey(BASE_URL, { ...options, runCommand: unavailable }), error => {
      assert.equal(String(error).includes(FAKE_KEY), false);
      assert.match(String(error), /无法读取 API Key/);
      return true;
    });
    for (const key of ['', ' ', 'fake\nkey', 'x'.repeat(2049)]) await assert.rejects(saveApiKey(BASE_URL, key, options), /API Key/);
  });
});

test('Windows 当前用户 DPAPI 使用假密钥真实往返', { skip: process.platform !== 'win32' }, async () => {
  await temporaryStore(async directory => {
    const options = { directory };
    assert.equal(await saveApiKey(BASE_URL, FAKE_KEY, options), 'windows-dpapi');
    assert.equal(await loadApiKey(BASE_URL, options), FAKE_KEY);
    assert.equal((await readFile(fileFor(directory), 'utf8')).includes(FAKE_KEY), false);
    await deleteApiKey(BASE_URL, options);
  });
});

test('凭据目录或用户目录链接不会重定向密钥读写', async () => {
  await temporaryStore(async directory => {
    const target = path.join(directory, 'target');
    const linked = path.join(directory, 'linked');
    await mkdir(target);
    await symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
    const options: CredentialOptions = { directory: linked, platform: 'linux', runCommand: unavailable };
    await assert.rejects(saveApiKey(BASE_URL, FAKE_KEY, options), /普通目录/);
    await assert.rejects(loadApiKey(BASE_URL, options), /普通目录/);
    await assert.rejects(deleteApiKey(BASE_URL, options), /普通目录/);
    assert.deepEqual(await readdir(target), []);
    const real = path.join(directory, 'real');
    await mkdir(real);
    await symlink(target, path.join(real, 'credentials'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(saveApiKey(BASE_URL, FAKE_KEY, { ...options, directory: real }), /普通目录/);
    await assert.rejects(loadApiKey(BASE_URL, { ...options, directory: real }), /普通目录/);
    assert.deepEqual(await readdir(target), []);
  });
});

test('Windows 真实凭据子进程可由 AbortSignal 终止且不会写入兜底文件', { skip: process.platform !== 'win32' }, async () => {
  await temporaryStore(async directory => {
    const controller = new AbortController();
    const operation = saveApiKey(BASE_URL, FAKE_KEY, { directory, signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 25);
    try { await assert.rejects(operation, { name: 'AbortError' }); }
    finally { clearTimeout(timer); }
    assert.equal(await loadApiKey(BASE_URL, { directory }), undefined);
    const names = await readdir(path.join(directory, 'credentials')).catch(() => []);
    assert.deepEqual(names, []);
  });
});
