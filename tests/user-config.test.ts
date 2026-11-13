import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, getUserConfigDir, loadConfig, loadConfigWithSource, readUserConfig, saveUserConfig } from '../src/config.js';
import type { AgentConfig } from '../src/types.js';

const environmentKeys = ['WEB3D_CONFIG_DIR', 'WEB3D_MODEL', 'WEB3D_BASE_URL'] as const;
let previousEnvironment: Map<string, string | undefined>;
let root: string;
let project: string;
let userDirectory: string;

beforeEach(async () => {
  previousEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]));
  root = await mkdtemp(path.join(os.tmpdir(), 'web3d-user-config-'));
  project = path.join(root, 'project');
  userDirectory = path.join(root, 'user');
  await mkdir(project);
  process.env.WEB3D_CONFIG_DIR = userDirectory;
  delete process.env.WEB3D_MODEL;
  delete process.env.WEB3D_BASE_URL;
});

afterEach(async () => {
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

test('用户配置目录可以显式指定，空配置读取返回默认值且不创建文件', async () => {
  assert.equal(getUserConfigDir(), userDirectory);
  assert.deepEqual(await readUserConfig(), {});
  assert.deepEqual(await loadConfig(project), DEFAULT_CONFIG);
  const loaded = await loadConfigWithSource(project);
  assert.ok(Object.values(loaded.sources).every(source => source === 'default'));
  await assert.rejects(access(userDirectory), { code: 'ENOENT' });
  delete process.env.WEB3D_CONFIG_DIR;
  assert.equal(getUserConfigDir(), path.join(os.homedir(), '.web3d-agent'));
});

test('用户设置原子保存并合并字段，限制文件权限且清理临时文件', async () => {
  await saveUserConfig({ model: '  user-model  ', baseUrl: 'https://models.example/v1', maxSteps: 7 });
  const merged = await saveUserConfig({ apiKeyEnv: 'MY_MODEL_TOKEN', stream: false });
  assert.deepEqual(merged, {
    model: 'user-model', baseUrl: 'https://models.example/v1', maxSteps: 7,
    apiKeyEnv: 'MY_MODEL_TOKEN', stream: false,
  });
  assert.deepEqual(await readUserConfig(), merged);
  assert.deepEqual(JSON.parse(await readFile(path.join(userDirectory, 'config.json'), 'utf8')), merged);
  assert.deepEqual(await readdir(userDirectory), ['config.json']);
  if (process.platform !== 'win32') {
    assert.equal((await stat(userDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(userDirectory, 'config.json'))).mode & 0o777, 0o600);
  }
});

test('配置优先级为命令行、环境、项目、用户、默认，并报告各字段来源', async () => {
  await saveUserConfig({ model: 'user-model', baseUrl: 'https://user.example/v1', apiKeyEnv: 'CUSTOM_API_KEY', maxSteps: 5 });
  let loaded = await loadConfigWithSource(project);
  assert.equal(loaded.config.model, 'user-model');
  assert.equal(loaded.sources.model, 'user');
  assert.equal(loaded.sources.maxOutputTokens, 'default');
  await writeFile(path.join(project, 'web3d-agent.json'), JSON.stringify({ model: 'project-model', baseUrl: 'https://project.example/v1', stream: false }));
  loaded = await loadConfigWithSource(project);
  assert.equal(loaded.config.model, 'project-model');
  assert.equal(loaded.sources.model, 'project');
  assert.equal(loaded.sources.apiKeyEnv, 'user');
  process.env.WEB3D_MODEL = 'environment-model';
  process.env.WEB3D_BASE_URL = 'https://environment.example/v1';
  loaded = await loadConfigWithSource(project);
  assert.equal(loaded.config.model, 'environment-model');
  assert.equal(loaded.sources.baseUrl, 'environment');
  loaded = await loadConfigWithSource(project, { model: 'cli-model', baseUrl: 'https://cli.example/v1', stream: true });
  assert.equal(loaded.config.model, 'cli-model');
  assert.equal(loaded.config.baseUrl, 'https://cli.example/v1');
  assert.equal(loaded.sources.model, 'cli');
  assert.equal(loaded.sources.stream, 'cli');
  assert.equal(loaded.config.maxSteps, 5);
});

test('旧 init 完整默认模板继承用户设置，并保留改过的项目字段', async () => {
  await saveUserConfig({ model: 'configured-model', baseUrl: 'https://gateway.example/v1', apiKeyEnv: 'USER_KEY_ENV', maxSteps: 6, stream: false });
  await writeFile(path.join(project, 'web3d-agent.json'), JSON.stringify(DEFAULT_CONFIG));
  let loaded = await loadConfigWithSource(project);
  assert.equal(loaded.config.model, 'configured-model');
  assert.equal(loaded.config.baseUrl, 'https://gateway.example/v1');
  assert.equal(loaded.config.apiKeyEnv, 'USER_KEY_ENV');
  assert.equal(loaded.config.maxSteps, 6);
  assert.equal(loaded.config.stream, false);
  assert.equal(loaded.sources.model, 'user');
  assert.equal(loaded.sources.baseUrl, 'user');
  await writeFile(path.join(project, 'web3d-agent.json'), JSON.stringify({ ...DEFAULT_CONFIG, maxSteps: 4 }));
  loaded = await loadConfigWithSource(project);
  assert.equal(loaded.config.maxSteps, 4);
  assert.equal(loaded.sources.maxSteps, 'project');
  assert.equal(loaded.config.model, 'configured-model');
});

test('稀疏项目配置的显式默认值仍然覆盖用户配置', async () => {
  await saveUserConfig({ model: 'user-model', baseUrl: 'https://gateway.example/v1', stream: false, maxSteps: 3 });
  await writeFile(path.join(project, 'web3d-agent.json'), JSON.stringify({ baseUrl: DEFAULT_CONFIG.baseUrl, stream: true }));
  const loaded = await loadConfigWithSource(project, { maxSteps: DEFAULT_CONFIG.maxSteps, model: undefined });
  assert.equal(loaded.config.baseUrl, DEFAULT_CONFIG.baseUrl);
  assert.equal(loaded.sources.baseUrl, 'project');
  assert.equal(loaded.config.stream, true);
  assert.equal(loaded.sources.stream, 'project');
  assert.equal(loaded.config.model, 'user-model');
  assert.equal(loaded.sources.model, 'user');
  assert.equal(loaded.sources.maxSteps, 'cli');
});

test('拒绝密钥字段、URL 凭证与非法值，失败后保留原配置', async () => {
  await saveUserConfig({ model: 'original-model' });
  for (const field of ['apiKey', 'token', 'credentials', 'constructor']) {
    await assert.rejects(saveUserConfig({ [field]: 'fixture-only' } as Partial<AgentConfig>), /未知配置/);
  }
  await assert.rejects(saveUserConfig({ baseUrl: 'https://account:fixture-only@gateway.example/v1' }), /凭证/);
  await assert.rejects(saveUserConfig({ baseUrl: 'https://gateway.example/v1?key=fixture-only' }), /查询参数/);
  await assert.rejects(saveUserConfig({ maxSteps: 0 }), /maxSteps/);
  await assert.rejects(saveUserConfig({ stream: 'yes' } as unknown as Partial<AgentConfig>), /stream/);
  await assert.rejects(saveUserConfig({ model: 'x'.repeat(16_385) }), /16 KiB/);
  assert.deepEqual(await readUserConfig(), { model: 'original-model' });
  assert.deepEqual(await readdir(userDirectory), ['config.json']);
});

test('同一进程并行保存不同字段时依次合并', async () => {
  await Promise.all([
    saveUserConfig({ model: 'parallel-model' }),
    saveUserConfig({ baseUrl: 'https://parallel.example/v1' }),
    saveUserConfig({ stream: false }),
  ]);
  assert.deepEqual(await readUserConfig(), { model: 'parallel-model', baseUrl: 'https://parallel.example/v1', stream: false });
  assert.deepEqual(await readdir(userDirectory), ['config.json']);
});

test('读取指定用户文件时校验大小和字段，解析错误不回显原始内容', async () => {
  await mkdir(userDirectory);
  const file = path.join(userDirectory, 'config.json');
  await writeFile(file, '{"model": "fixture-only", BROKEN');
  await assert.rejects(readUserConfig(), error => {
    assert.match((error as Error).message, /有效 JSON/);
    assert.ok(!(error as Error).message.includes('fixture-only'));
    return true;
  });
  await writeFile(file, 'x'.repeat(16_385));
  await assert.rejects(readUserConfig(), /16 KiB/);
  await writeFile(file, '{"apiKey":"fixture-only"}');
  await assert.rejects(readUserConfig(), /未知配置/);
  await writeFile(file, '{"baseUrl":"https://account:fixture-only@gateway.example/v1"}');
  await assert.rejects(readUserConfig(), /凭证/);
});

test('用户配置目录链接不会重定向设置的读取和保存', async t => {
  const target = path.join(root, 'other-directory');
  await mkdir(target);
  await writeFile(path.join(target, 'config.json'), '{"model":"linked-model"}');
  try { await symlink(target, userDirectory, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('当前账户不能创建目录链接'); return; }
    throw error;
  }
  await assert.rejects(readUserConfig(), /实际目录/);
  await assert.rejects(saveUserConfig({ model: 'replacement' }), /实际目录/);
  assert.equal(await readFile(path.join(target, 'config.json'), 'utf8'), '{"model":"linked-model"}');
});
