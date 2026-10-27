import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { createSession, listSessions, readSession, saveSession, validateMessages } from '../src/session.js';

test('会话保存、列出与恢复，目录和 ID 都需一致', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'web3d-session-'));
  try {
    const session = createSession(root);
    session.messages.push({ role: 'user', content: '场景如何销毁' });
    await saveSession(session);
    await saveSession(session);
    assert.equal((await listSessions(root))[0]?.id, session.id);
    assert.deepEqual((await readSession(root, session.id)).messages, session.messages);
    await assert.rejects(readSession(root, '../other'), /无效/);
    const file = path.join(root, '.web3d-agent', 'sessions', `${session.id}.json`);
    const raw = JSON.parse(await readFile(file, 'utf8'));
    raw.cwd = path.dirname(root);
    await writeFile(file, JSON.stringify(raw));
    await assert.rejects(readSession(root, session.id), /不匹配/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('拒绝未配对工具调用及无对应调用的结果', () => {
  assert.throws(() => validateMessages([{ role: 'tool', content: 'bad', tool_call_id: 'missing' }]), /对应调用/);
  assert.throws(() => validateMessages([{ role: 'assistant', content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'test', arguments: '{}' } }] }]), /未完成/);
});

test('配置遵循环境与显式覆盖顺序，拒绝非法数值和未知字段', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'web3d-config-'));
  const previous = process.env.WEB3D_MODEL;
  try {
    await writeFile(path.join(root, 'web3d-agent.json'), JSON.stringify({ model: 'project-model', maxSteps: 3 }));
    process.env.WEB3D_MODEL = 'env-model';
    assert.equal((await loadConfig(root)).model, 'env-model');
    assert.equal((await loadConfig(root, { model: 'flag-model' })).model, 'flag-model');
    await assert.rejects(loadConfig(root, { maxSteps: 0 }), /maxSteps/);
    await writeFile(path.join(root, 'web3d-agent.json'), '{"apiKey":"never-save-secrets"}');
    await assert.rejects(loadConfig(root), /未知配置/);
  } finally {
    if (previous === undefined) delete process.env.WEB3D_MODEL; else process.env.WEB3D_MODEL = previous;
    await rm(root, { recursive: true, force: true });
  }
});
