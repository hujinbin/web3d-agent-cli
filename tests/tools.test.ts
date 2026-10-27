import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTools } from '../src/tools/index.js';
import type { ToolContext } from '../src/types.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))); });

async function setup(): Promise<ToolContext> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'web3d-tools-'));
  temporary.push(cwd);
  return { cwd, signal: new AbortController().signal, readState: new Map() };
}

async function call(name: string, input: Record<string, unknown>, context: ToolContext): Promise<any> {
  const tool = createTools().find(candidate => candidate.name === name);
  assert.ok(tool);
  return tool.execute(input, context);
}

test('文件工具拒绝越界路径与凭据，允许示例环境文件', async () => {
  const context = await setup();
  await assert.rejects(call('read_file', { path: '../outside.txt' }, context), /路径/);
  await assert.rejects(call('write_file', { path: path.resolve(context.cwd, '..', 'outside.txt'), content: 'x' }, context), /工作区/);
  for (const file of ['.env', '.env.production', 'secret.pem', '.git/config', '.web3d-agent/sessions/demo.json']) {
    await assert.rejects(call('write_file', { path: file, content: 'x' }, context), /禁止访问/);
  }
  await call('write_file', { path: '.env.example', content: 'KEY=' }, context);
  assert.equal(await fs.readFile(path.join(context.cwd, '.env.example'), 'utf8'), 'KEY=');
});

test('已有文件必须完整读取，修改后需要重新读取', async () => {
  const context = await setup();
  const target = path.join(context.cwd, 'scene.ts');
  await fs.writeFile(target, 'const size = 1;');
  await assert.rejects(call('write_file', { path: 'scene.ts', content: 'x' }, context), /未完整读取/);
  await call('read_file', { path: 'scene.ts' }, context);
  await fs.writeFile(target, 'const size = 2;');
  await assert.rejects(call('edit_file', { path: 'scene.ts', old_text: '2', new_text: '3' }, context), /内容已变化/);
  await call('read_file', { path: 'scene.ts' }, context);
  await call('edit_file', { path: 'scene.ts', old_text: '2', new_text: '3' }, context);
  assert.equal(await fs.readFile(target, 'utf8'), 'const size = 3;');
});

test('尚未覆盖全部行的读取不能用于覆盖，超长单行明确报受限', async () => {
  const context = await setup();
  await fs.writeFile(path.join(context.cwd, 'app.py'), 'first\nsecond\nthird');
  const part = await call('read_file', { path: 'app.py', offset: 2, limit: 1 }, context);
  assert.equal(part.content, 'second');
  assert.equal(part.partial, true);
  await assert.rejects(call('write_file', { path: 'app.py', content: 'x' }, context), /未完整读取/);
  await fs.writeFile(path.join(context.cwd, 'large.txt'), 'a'.repeat(25_000));
  await assert.rejects(call('read_file', { path: 'large.txt' }, context), /单行文本.*上限/);
  await assert.rejects(call('write_file', { path: 'large.txt', content: 'x' }, context), /未完整读取/);
});

test('大文件可通过完整行分页累计覆盖后进行精确编辑', async () => {
  const context = await setup();
  const lines = Array.from({ length: 500 }, (_, index) => `line-${index}: ${'a'.repeat(80)}`);
  const content = lines.join('\n');
  await fs.writeFile(path.join(context.cwd, 'scene.ts'), content);
  let page = await call('read_file', { path: 'scene.ts' }, context);
  assert.equal(page.fullyRead, false);
  assert.equal(page.truncated, true);
  assert.ok(JSON.stringify(page).length <= 24_000);
  await assert.rejects(call('edit_file', { path: 'scene.ts', old_text: 'line-0:', new_text: 'edited:' }, context), /未完整读取/);
  let totalReturned = page.returnedLines;
  while (page.nextOffset !== null) {
    page = await call('read_file', { path: 'scene.ts', offset: page.nextOffset, limit: 2000 }, context);
    totalReturned += page.returnedLines;
    assert.ok(JSON.stringify(page).length <= 24_000);
  }
  assert.equal(totalReturned, lines.length);
  assert.equal(page.fullyRead, true);
  await call('edit_file', { path: 'scene.ts', old_text: 'line-0:', new_text: 'edited:' }, context);
  assert.equal(await fs.readFile(path.join(context.cwd, 'scene.ts'), 'utf8'), content.replace('line-0:', 'edited:'));
});

test('JSON 转义后的 24k 上限决定返回范围，不能错误授权未返回内容', async () => {
  const context = await setup();
  await fs.writeFile(path.join(context.cwd, 'single.txt'), '\\"'.repeat(6500));
  await assert.rejects(call('read_file', { path: 'single.txt' }, context), /单行文本.*上限/);
  await assert.rejects(call('write_file', { path: 'single.txt', content: 'x' }, context), /未完整读取/);

  const lines = Array.from({ length: 100 }, (_, index) => `${index}: ${'\\"'.repeat(65)}`);
  await fs.writeFile(path.join(context.cwd, 'escaped.txt'), lines.join('\n'));
  const first = await call('read_file', { path: 'escaped.txt' }, context);
  assert.ok(JSON.stringify(first).length <= 24_000);
  assert.equal(first.content, lines.slice(0, first.returnedLines).join('\n'));
  assert.equal(first.fullyRead, false);
  assert.equal(first.partial, true);
  await assert.rejects(call('write_file', { path: 'escaped.txt', content: 'x' }, context), /未完整读取/);
  const last = await call('read_file', { path: 'escaped.txt', offset: first.nextOffset }, context);
  assert.ok(JSON.stringify(last).length <= 24_000);
  assert.equal(last.fullyRead, true);
  await call('write_file', { path: 'escaped.txt', content: 'done' }, context);
});

test('文件版本变化会清除此前的分页覆盖证据', async () => {
  const context = await setup();
  const target = path.join(context.cwd, 'app.py');
  await fs.writeFile(target, 'first\nmiddle\nlast');
  await call('read_file', { path: 'app.py', offset: 1, limit: 1 }, context);
  await fs.writeFile(target, 'changed\nmiddle\nlast');
  const tail = await call('read_file', { path: 'app.py', offset: 2, limit: 2 }, context);
  assert.equal(tail.fullyRead, false);
  await assert.rejects(call('write_file', { path: 'app.py', content: 'x' }, context), /未完整读取/);
  const head = await call('read_file', { path: 'app.py', offset: 1, limit: 1 }, context);
  assert.equal(head.fullyRead, true);
  await call('edit_file', { path: 'app.py', old_text: 'changed', new_text: 'updated' }, context);
  assert.equal(await fs.readFile(target, 'utf8'), 'updated\nmiddle\nlast');
});

test('精确编辑拒绝空匹配、多处匹配，保留替换文本的字面值', async () => {
  const context = await setup();
  await fs.writeFile(path.join(context.cwd, 'scene.ts'), 'cube cube');
  await call('read_file', { path: 'scene.ts' }, context);
  await assert.rejects(call('edit_file', { path: 'scene.ts', old_text: '', new_text: 'x' }, context), /不能为空/);
  await assert.rejects(call('edit_file', { path: 'scene.ts', old_text: 'cube', new_text: 'sphere' }, context), /多个匹配/);
  await call('edit_file', { path: 'scene.ts', old_text: 'cube', new_text: '$&', replace_all: true }, context);
  assert.equal(await fs.readFile(path.join(context.cwd, 'scene.ts'), 'utf8'), '$& $&');
});

test('符号链接与目录链接不能逃出工作区', async t => {
  const context = await setup();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'web3d-outside-'));
  temporary.push(outside);
  await fs.writeFile(path.join(outside, 'data.txt'), 'private');
  try { await fs.symlink(outside, path.join(context.cwd, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('当前账户不能创建符号链接'); return; }
    throw error;
  }
  await assert.rejects(call('read_file', { path: 'linked/data.txt' }, context), /符号链接/);
  await assert.rejects(call('write_file', { path: 'linked/new.txt', content: 'x' }, context), /符号链接/);
});

test('文件符号链接明确拒绝，不能在编辑时悄悄替换链接', async t => {
  const context = await setup();
  const target = path.join(context.cwd, 'real.ts');
  const alias = path.join(context.cwd, 'alias.ts');
  await fs.writeFile(target, 'const cube = 1;');
  try { await fs.symlink(target, alias, 'file'); }
  catch (error) {
    if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('当前账户不能创建文件符号链接'); return; }
    throw error;
  }
  await assert.rejects(call('read_file', { path: 'alias.ts' }, context), /文件符号链接/);
  await assert.rejects(call('write_file', { path: 'alias.ts', content: 'x' }, context), /文件符号链接/);
  assert.equal((await fs.lstat(alias)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(target, 'utf8'), 'const cube = 1;');
});

test('带 BOM 的 UTF-8 文件可以完整读取和编辑且保留 BOM', async () => {
  const context = await setup();
  const target = path.join(context.cwd, 'scene.ts');
  await fs.writeFile(target, '\uFEFFconst cube = 1;');
  const read = await call('read_file', { path: 'scene.ts' }, context);
  assert.equal(read.fullyRead, true);
  assert.equal(read.content.charCodeAt(0), 0xFEFF);
  await call('edit_file', { path: 'scene.ts', old_text: 'cube', new_text: 'sphere' }, context);
  const result = await fs.readFile(target);
  assert.deepEqual([...result.subarray(0, 3)], [0xEF, 0xBB, 0xBF]);
  assert.equal(result.toString('utf8'), '\uFEFFconst sphere = 1;');
});

test('目录和文字搜索跳过依赖、凭据，按字面量匹配', async () => {
  const context = await setup();
  await fs.mkdir(path.join(context.cwd, 'node_modules'));
  await fs.writeFile(path.join(context.cwd, 'node_modules', 'hidden.txt'), '[a-z]');
  await fs.writeFile(path.join(context.cwd, '.env'), '[a-z]');
  await fs.writeFile(path.join(context.cwd, 'scene.ts'), 'cube\n[a-z]\n[a-z]');
  const list = await call('list_files', {}, context);
  assert.deepEqual(list.files, ['scene.ts']);
  const search = await call('search_text', { query: '[a-z]', limit: 1 }, context);
  assert.deepEqual(search.matches, [{ path: 'scene.ts', line: 2, text: '[a-z]' }]);
  assert.equal(search.truncated, true);
});

test('文件大小、二进制与错误参数受到约束', async () => {
  const context = await setup();
  await fs.writeFile(path.join(context.cwd, 'large.txt'), Buffer.alloc(1024 * 1024 + 1, 'a'));
  await fs.writeFile(path.join(context.cwd, 'binary.bin'), Buffer.from([0, 1, 2]));
  await assert.rejects(call('read_file', { path: 'large.txt' }, context), /1 MiB/);
  await assert.rejects(call('read_file', { path: 'binary.bin' }, context), /二进制/);
  await assert.rejects(call('list_files', { max_depth: 99 }, context), /max_depth/);
  await assert.rejects(call('read_file', { path: 'binary.bin', extra: 1 }, context), /未知参数/);
});

test('命令按 argv 执行并报告非零退出，输出有界', async () => {
  const context = await setup();
  const result = await call('run_command', { command: process.execPath, args: ['-e', 'process.stdout.write(process.argv[1]); process.exitCode = 3', 'a;echo injected'] }, context);
  assert.equal(result.exitCode, 3);
  assert.equal(result.isError, true);
  assert.equal(result.output, 'a;echo injected');
  const long = await call('run_command', { command: process.execPath, args: ['-e', 'process.stdout.write("a".repeat(50000))'] }, context);
  assert.equal(long.output.length, 24_000);
  assert.equal(long.truncated, true);
});

test('命令超时和取消终止进程', async () => {
  const context = await setup();
  const timed = await call('run_command', { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], timeout_ms: 150 }, context);
  assert.equal(timed.timedOut, true);
  assert.equal(timed.isError, true);
  const controller = new AbortController();
  const pending = call('run_command', { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }, { ...context, signal: controller.signal });
  setTimeout(() => controller.abort(), 150);
  const aborted = await pending;
  assert.equal(aborted.aborted, true);
});

test('项目检查输出启发式证据而非虚假的通过结论', async () => {
  const context = await setup();
  await fs.writeFile(path.join(context.cwd, 'scene.ts'), 'import * as THREE from "three"; requestAnimationFrame(render);');
  await fs.writeFile(path.join(context.cwd, 'app.py'), 'async def route():\n    time.sleep(1)');
  const result = await call('check_project', {}, context);
  assert.equal(result.frontend.threeDetected, true);
  assert.equal(result.backend.pythonFiles, 1);
  assert.equal(result.diagnostics.length, 2);
  assert.match(result.scope, /启发式/);
});
