import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_CONFIG, loadConfig, readUserConfig } from '../src/config.js';
import { loadApiKey } from '../src/credentials.js';
import { configureModel, listModels, type SetupIO } from '../src/setup.js';

async function fixture(status = 200) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'web3d-setup-'));
  const previous = process.env.WEB3D_CONFIG_DIR;
  process.env.WEB3D_CONFIG_DIR = path.join(directory, 'user-settings');
  const requests: { url: string; authorization?: string }[] = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url!, authorization: request.headers.authorization });
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'mock-front' }, { id: 'mock-alt' }, { id: 'mock-front' }, { id: '\x1b[31munsafe' }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  return {
    directory, baseUrl, requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (previous === undefined) delete process.env.WEB3D_CONFIG_DIR;
      else process.env.WEB3D_CONFIG_DIR = previous;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function scriptedIO(answers: string[], key = '') {
  const prompts: string[] = [];
  const output: string[] = [];
  let secretQuestions = 0;
  const io: SetupIO = {
    async question(prompt) {
      prompts.push(prompt);
      assert.ok(answers.length, `意外的提问 ${prompt}`);
      return answers.shift()!;
    },
    async secret() { secretQuestions++; return key; },
    write(text) { output.push(text); },
  };
  return { io, prompts, output, secretQuestions: () => secretQuestions };
}

test('模型向导发现模型、保存用户默认和地址绑定密钥，其他项目可直接读取', async () => {
  const f = await fixture();
  try {
    const key = 'fake-onboarding-key-for-local-test';
    const ui = scriptedIO(['1', f.baseUrl, '2'], key);
    const selected = await configureModel({ current: { ...DEFAULT_CONFIG }, io: ui.io, signal: new AbortController().signal });
    assert.equal(selected.model, 'mock-alt');
    assert.equal(selected.apiKey, key);
    assert.deepEqual(f.requests, [{ url: '/v1/models', authorization: `Bearer ${key}` }]);
    assert.equal((await readUserConfig()).model, 'mock-alt');
    assert.equal((await loadConfig(f.directory)).baseUrl, f.baseUrl);
    assert.equal(await loadApiKey(f.baseUrl), key);
    assert.equal(await loadApiKey(`${f.baseUrl}/other`), undefined);
    const publicConfig = await readFile(path.join(process.env.WEB3D_CONFIG_DIR!, 'config.json'), 'utf8');
    assert.ok(!publicConfig.includes(key));
    assert.ok(!ui.output.join('').includes(key));
    assert.ok(!ui.output.join('').includes('unsafe'));
    assert.equal(ui.secretQuestions(), 1);
  } finally { await f.close(); }
});

test('聊天内仅切换模型时复用接口和凭据，只询问一次模型选择', async () => {
  const f = await fixture();
  try {
    const ui = scriptedIO(['1']);
    const selected = await configureModel({
      current: { ...DEFAULT_CONFIG, baseUrl: f.baseUrl, model: 'mock-alt' }, apiKey: 'fake-existing-key',
      io: ui.io, signal: new AbortController().signal, modelsOnly: true,
    });
    assert.equal(selected.model, 'mock-front');
    assert.equal(ui.prompts.length, 1);
    assert.equal(ui.secretQuestions(), 0);
    assert.equal(f.requests[0]!.authorization, 'Bearer fake-existing-key');
  } finally { await f.close(); }
});

test('接口不提供模型列表时允许手动输入 ID，免认证接口可以保存空密钥', async () => {
  const f = await fixture(404);
  try {
    const ui = scriptedIO(['1', f.baseUrl, 'my-custom-model']);
    const selected = await configureModel({ current: { ...DEFAULT_CONFIG }, io: ui.io, signal: new AbortController().signal });
    assert.equal(selected.model, 'my-custom-model');
    assert.equal(selected.apiKey, undefined);
    assert.equal(await loadApiKey(f.baseUrl), undefined);
    assert.match(ui.output.join(''), /直接输入模型 ID/);
  } finally { await f.close(); }
});

test('更换接口地址后模型发现不会携带上一接口的密钥', async () => {
  const f = await fixture();
  try {
    const ui = scriptedIO(['1', f.baseUrl, '1']);
    await configureModel({ current: { ...DEFAULT_CONFIG }, apiKey: 'fake-other-endpoint-key', io: ui.io, signal: new AbortController().signal });
    assert.equal(f.requests[0]!.authorization, undefined);
  } finally { await f.close(); }
});

test('向导取消不会保存半份配置或将密钥写入普通配置', async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    const ui = scriptedIO(['1', f.baseUrl]);
    ui.io.secret = async () => { controller.abort(); return 'fake-cancelled-key'; };
    await assert.rejects(configureModel({ current: { ...DEFAULT_CONFIG }, io: ui.io, signal: controller.signal }), error => error instanceof Error && error.name === 'AbortError');
    assert.deepEqual(await readUserConfig(), {});
    assert.equal(await loadApiKey(f.baseUrl), undefined);
    assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

test('模型发现兼容完整chat/completions地址并去重过滤控制字符', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await listModels(`${f.baseUrl}/chat/completions`, undefined, new AbortController().signal), ['mock-front', 'mock-alt']);
    assert.equal(f.requests[0]!.url, '/v1/models');
  } finally { await f.close(); }
});
