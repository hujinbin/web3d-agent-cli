import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectProject } from '../src/tools/project.js';
import { createTools } from '../src/tools/index.js';
import type { ToolContext } from '../src/types.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function workspace(): Promise<ToolContext> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'web3d-project-'));
  directories.push(cwd);
  return { cwd, signal: new AbortController().signal, readState: new Map() };
}

test('逐文件 Three.js 诊断保留行号，其他文件的 dispose 不会抑制提示', async () => {
  const context = await workspace();
  await writeFile(path.join(context.cwd, 'clean.ts'), "import * as THREE from 'three';\nrequestAnimationFrame(render);\ngeometry.dispose();\n");
  await writeFile(path.join(context.cwd, 'scene.ts'), "import * as THREE from 'three';\n\nrequestAnimationFrame(render);\n");
  const report = await inspectProject(context);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.frontend.threeDetected, true);
  assert.equal(report.frontend.sampled, 2);
  assert.equal(report.diagnostics.length, 1);
  assert.deepEqual(report.diagnostics[0], {
    code: 'threejs.cleanup-review', level: 'review', file: 'scene.ts', line: 3,
    evidence: 'requestAnimationFrame(render);',
    message: '该文件出现 Three.js 动画调用，未见显式 dispose。请结合框架及共享资源所有权核查清理路径。',
  });
  assert.equal(context.readState.size, 0);
});

test('Python 线索给出实际文件、行号及证据，复用现有只读工具入口', async () => {
  const context = await workspace();
  await writeFile(path.join(context.cwd, 'api.py'), [
    'from fastapi.middleware.cors import CORSMiddleware',
    'app.add_middleware(',
    '    CORSMiddleware,',
    '    allow_origins=["*"],',
    ')',
    'async def load():',
    '    time.sleep(1)',
  ].join('\n'));
  const tools = createTools();
  const tool = tools.find(item => item.name === 'check_project');
  assert.ok(tool);
  assert.equal(tools.length, 7);
  assert.equal(tool.kind, 'read');
  const report = await inspectProject(context);
  assert.equal(report.diagnostics.length, 2);
  assert.deepEqual(report.diagnostics.map(({ code, line, evidence }) => ({ code, line, evidence })), [
    { code: 'python.async-blocking-review', line: 7, evidence: 'time.sleep(1)' },
    { code: 'python.cors-wildcard-review', line: 4, evidence: 'allow_origins=["*"' },
  ]);
  assert.deepEqual(await tool.execute({}, context), report);
});

test('成功读取、失败原因与非候选文件的统计准确，沿用私密和依赖过滤', async () => {
  const context = await workspace();
  await writeFile(path.join(context.cwd, 'scene.ts'), 'const size = 1;');
  await writeFile(path.join(context.cwd, 'oversized.ts'), Buffer.alloc(1024 * 1024 + 1, 'a'));
  await writeFile(path.join(context.cwd, 'binary.py'), Buffer.from([0, 1, 2]));
  await writeFile(path.join(context.cwd, 'invalid.js'), Buffer.from([0xc3, 0x28]));
  await writeFile(path.join(context.cwd, 'README.md'), '# notes');
  await writeFile(path.join(context.cwd, '.env'), 'TOKEN=not-for-scanning');
  await mkdir(path.join(context.cwd, 'node_modules'));
  await writeFile(path.join(context.cwd, 'node_modules', 'hidden.ts'), 'ignored');
  const report = await inspectProject(context);
  assert.equal(report.summary.listedFiles, 5);
  assert.equal(report.summary.candidateFiles, 4);
  assert.equal(report.summary.scannedFiles, 1);
  assert.equal(report.filesScanned, 1);
  assert.equal(report.summary.skippedFiles, 3);
  assert.equal(report.summary.notApplicableFiles, 1);
  assert.deepEqual(report.summary.skippedByReason, { sample_limit: 0, too_large: 1, binary: 1, invalid_encoding: 1, read_error: 0 });
  assert.equal(report.frontend.sampled, 1);
  assert.equal(report.backend.sampled, 0);
  assert.equal(report.skipped.length, 3);
  assert.equal(report.truncated, false);
});

test('采样上限、诊断上限和明细截断均有可核对的总数', async () => {
  const context = await workspace();
  await Promise.all(Array.from({ length: 80 }, (_, index) => writeFile(
    path.join(context.cwd, `scene-${String(index).padStart(3, '0')}.ts`),
    "import * as THREE from 'three';\nrequestAnimationFrame(render);",
  )));
  const report = await inspectProject(context);
  assert.equal(report.summary.candidateFiles, 80);
  assert.equal(report.summary.scannedFiles, 60);
  assert.equal(report.summary.skippedFiles, 20);
  assert.equal(report.summary.skippedByReason.sample_limit, 20);
  assert.equal(report.summary.diagnosticsTotal, 60);
  assert.equal(report.summary.diagnosticsReturned, 30);
  assert.equal(report.coverage.samplingTruncated, true);
  assert.equal(report.coverage.diagnosticsTruncated, true);
  assert.equal(report.coverage.skippedDetailsTruncated, true);
  assert.equal(report.truncated, true);
  assert.ok(JSON.stringify(report).length <= 24_000);
});

test('共享诊断校验参数且遵循取消信号', async () => {
  const context = await workspace();
  await assert.rejects(inspectProject(context, { command: 'ignored' }), /未知参数/);
  const controller = new AbortController();
  controller.abort(new Error('取消诊断'));
  await assert.rejects(inspectProject({ ...context, signal: controller.signal }), /取消诊断/);
});
