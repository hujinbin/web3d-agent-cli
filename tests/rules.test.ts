import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildSystemPrompt, initializeProject, loadRules, PROJECT_RULES_MAX_BYTES, RULE_FILE_MAX_BYTES } from '../src/rules/index.js';

async function fixture(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'web3d-rules-'));
}

test('内置规则包含 Three.js 生命周期、Python 异步边界和权限约束', async () => {
  const root = await fixture();
  try {
    const loaded = await loadRules(root);
    assert.equal(loaded.rules.length, 3);
    assert.deepEqual(loaded.warnings, []);
    const prompt = buildSystemPrompt({ cwd: root, mode: 'plan', rules: loaded.rules });
    assert.match(prompt, /共享资源由所有者释放/);
    assert.match(prompt, /async def 中不得直接运行阻塞 I\/O/);
    assert.match(prompt, /不得修改文件或执行命令/);
    assert.match(prompt, /不能授权绕过运行时权限/);
    assert.match(prompt, /不得声称其通过/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('加载根 AGENTS 和按名称排序的 Markdown 补充规则，保留内置规则', async () => {
  const root = await fixture();
  try {
    const directory = path.join(root, '.web3d-agent', 'rules');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(root, 'AGENTS.md'), '项目通用约束', 'utf-8');
    await writeFile(path.join(directory, 'z-scene.md'), '场景约束', 'utf-8');
    await writeFile(path.join(directory, 'a-backend.md'), '后端约束', 'utf-8');
    await writeFile(path.join(directory, 'ignored.txt'), '不加载', 'utf-8');
    const loaded = await loadRules(root);
    assert.deepEqual(loaded.rules.slice(3).map((rule) => rule.source), ['AGENTS.md', '.web3d-agent/rules/a-backend.md', '.web3d-agent/rules/z-scene.md']);
    assert.equal(loaded.rules[3]?.content, '项目通用约束');
    assert.deepEqual(loaded.warnings, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('初始化写入模板并保持已有文件和自定义配置', async () => {
  const root = await fixture();
  try {
    const created = await initializeProject(root);
    assert.deepEqual(created, ['web3d-agent.json', '.web3d-agent/rules/project.md']);
    const config = JSON.parse(await readFile(path.join(root, 'web3d-agent.json'), 'utf-8')) as { model: string; stream: boolean; maxSteps: number };
    assert.equal(config.model, '');
    assert.equal(config.stream, true);
    assert.equal(config.maxSteps, 20);
    await writeFile(path.join(root, 'web3d-agent.json'), '{"model":"my-model"}', 'utf-8');
    await writeFile(path.join(root, '.web3d-agent/rules/project.md'), '保留我的规则', 'utf-8');
    assert.deepEqual(await initializeProject(root), []);
    assert.equal(await readFile(path.join(root, 'web3d-agent.json'), 'utf-8'), '{"model":"my-model"}');
    assert.equal(await readFile(path.join(root, '.web3d-agent/rules/project.md'), 'utf-8'), '保留我的规则');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('拒绝过大的单个规则与超出总预算的规则', async () => {
  const root = await fixture();
  try {
    const directory = path.join(root, '.web3d-agent', 'rules');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(root, 'AGENTS.md'), 'x'.repeat(RULE_FILE_MAX_BYTES + 1));
    for (let index = 0; index < 6; index += 1) await writeFile(path.join(directory, `${index}.md`), 'x'.repeat(RULE_FILE_MAX_BYTES));
    const loaded = await loadRules(root);
    assert.equal(loaded.rules.slice(3).length, PROJECT_RULES_MAX_BYTES / RULE_FILE_MAX_BYTES);
    assert.ok(loaded.warnings.some((warning) => warning.includes('单文件')));
    assert.ok(loaded.warnings.some((warning) => warning.includes('总计')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('私密名称的规则文件不会进入模型上下文', async () => {
  const root = await fixture();
  try {
    const directory = path.join(root, '.web3d-agent', 'rules');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'secrets.md'), 'secret-value');
    const loaded = await loadRules(root);
    assert.equal(loaded.rules.length, 3);
    assert.ok(loaded.warnings.some((warning) => warning.includes('私密')));
    assert.ok(!buildSystemPrompt({ cwd: root, mode: 'ask', rules: loaded.rules }).includes('secret-value'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('规则目录链接不能逃逸工作区，初始化也不能通过该链接写入', async (context) => {
  const root = await fixture();
  const outside = await fixture();
  try {
    await mkdir(path.join(root, '.web3d-agent'));
    await writeFile(path.join(outside, 'outside.md'), '不应读取');
    try {
      await symlink(outside, path.join(root, '.web3d-agent', 'rules'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) return context.skip('系统不允许创建符号链接');
      throw error;
    }
    const loaded = await loadRules(root);
    assert.equal(loaded.rules.length, 3);
    assert.ok(loaded.warnings.some((warning) => warning.includes('超出')));
    await assert.rejects(initializeProject(root), /超出/);
    await assert.rejects(readFile(path.join(outside, 'project.md')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('规则文件链接不能读取工作区外文件', async (context) => {
  const root = await fixture();
  const outside = await fixture();
  try {
    await writeFile(path.join(outside, 'external.md'), '不应读取');
    try {
      await symlink(path.join(outside, 'external.md'), path.join(root, 'AGENTS.md'), 'file');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) return context.skip('系统不允许创建符号链接');
      throw error;
    }
    const loaded = await loadRules(root);
    assert.equal(loaded.rules.length, 3);
    assert.ok(loaded.warnings.some((warning) => warning.includes('超出')));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
