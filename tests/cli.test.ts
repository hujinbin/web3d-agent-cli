import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('CLI 初始化、JSONL 离线演示和会话恢复贯通', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'web3d-cli-'));
  try {
    const launch = (...args: string[]) => exec(process.execPath, [cli, '-C', root, ...args], { timeout: 20_000, encoding: 'utf8' });
    await launch('init');
    await writeFile(path.join(root, 'README.md'), '# Three.js / Python 项目');
    const config = JSON.parse(await readFile(path.join(root, 'web3d-agent.json'), 'utf8'));
    assert.equal(config.model, '');
    const result = await launch('run', '检查项目', '--demo', '--json');
    const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events.at(-1).reason, 'completed');
    assert.deepEqual(events.filter(event => event.type === 'tool_start').map(event => event.name), ['list_files', 'check_project']);
    const id = events.at(-1).sessionId;
    const second = await launch('run', '再检查一次', '--demo', '--json', '--resume', id);
    const nextEvents = second.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(nextEvents.at(-1).sessionId, id);
    assert.equal(nextEvents.filter(event => event.type === 'tool_start').length, 2);
    const session = JSON.parse(await readFile(path.join(root, '.web3d-agent', 'sessions', `${id}.json`), 'utf8'));
    assert.equal(session.messages.filter((message: { role: string }) => message.role === 'user').length, 2);
    assert.match((await launch('rules')).stdout, /Three.js 场景开发规则/);
    assert.match((await launch('doctor')).stdout, /未调用模型/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI 没有模型配置时明确失败，不假装执行；帮助不需要配置', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'web3d-cli-invalid-'));
  try {
    assert.match((await exec(process.execPath, [cli, '--help'], { cwd: root, encoding: 'utf8' })).stdout, /--base-url/);
    const env = { ...process.env }; delete env.WEB3D_MODEL;
    await assert.rejects(exec(process.execPath, [cli, '-C', root, 'run', '测试', '--json'], { env, encoding: 'utf8' }), (error: unknown) => {
      const failure = error as { code: number; stdout: string };
      assert.equal(failure.code, 1);
      assert.match(JSON.parse(failure.stdout).message, /模型名/);
      return true;
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('真实 CLI 经本机模型接口读取并编辑 Three.js 和 Python 文件', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'web3d-cli-api-'));
  let step = 0;
  const requests: { messages: { role: string; content: string }[]; tools: unknown[] }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const files = ['scene.ts', 'api.py'];
    let message: unknown;
    if (step < 2) {
      const tool = step === 0 ? 'read_file' : 'edit_file';
      message = { role: 'assistant', content: null, tool_calls: files.map((file, index) => ({
        // 模拟每轮重复使用 ID 的兼容网关。
        id: `call_${index}`, type: 'function', function: { name: tool, arguments: JSON.stringify(step === 0 ? { path: file } : {
          path: file, old_text: index === 0 ? 'const pixelRatio = 4;' : 'timeout = None',
          new_text: index === 0 ? 'const pixelRatio = 2;' : 'timeout = 30',
        }) },
      })) };
    } else message = { role: 'assistant', content: '已调整像素比和后端超时，尚未运行浏览器或 Python 测试。' };
    step++;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ index: 0, message, finish_reason: step <= 2 ? 'tool_calls' : 'stop' }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await writeFile(path.join(root, 'scene.ts'), "import * as THREE from 'three';\nconst pixelRatio = 4;\n");
    await writeFile(path.join(root, 'api.py'), 'timeout = None\n');
    const address = server.address() as { port: number };
    const result = await exec(process.execPath, [cli, '-C', root, 'run', '调整场景与接口', '--json', '--mode', 'auto-edit', '--no-stream', '--model', 'test-model', '--base-url', `http://127.0.0.1:${address.port}/v1`], { timeout: 20_000, encoding: 'utf8' });
    assert.match(await readFile(path.join(root, 'scene.ts'), 'utf8'), /pixelRatio = 2/);
    assert.match(await readFile(path.join(root, 'api.py'), 'utf8'), /timeout = 30/);
    assert.equal(requests.length, 3);
    assert.equal(requests[0]!.tools.length, 7);
    assert.match(requests[0]!.messages[0]!.content, /Three.js 场景开发规则/);
    assert.equal(JSON.parse(result.stdout.trim().split('\n').at(-1)!).reason, 'completed');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
