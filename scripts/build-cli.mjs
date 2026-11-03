import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const harnessVersion = require('@deepseek-ai/dsh-agent-loop/package.json').version;
const llmVersion = require('@deepseek-ai/dsh-llm/package.json').version;
const llmVersionLookup = 'createRequire(import.meta.url)("../package.json")';
let patchedModules = 0;

const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/src/cli.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  minify: false,
  write: false,
  metafile: true,
  define: { __WEB3D_DSH_VERSION__: JSON.stringify(harnessVersion) },
  banner: {
    js: "import { createRequire as __web3dCreateRequire } from 'node:module';\nconst require = __web3dCreateRequire(import.meta.url);",
  },
  plugins: [{
    name: 'freeze-dsh-package-version',
    setup(build) {
      build.onLoad({ filter: /[\\/]@deepseek-ai[\\/]dsh-llm[\\/]lib[\\/]index\.js$/ }, async args => {
        const source = await readFile(args.path, 'utf8');
        const matches = source.split(llmVersionLookup).length - 1;
        if (matches !== 1) {
          throw new Error(`DSH LLM ${llmVersion} 的包版本读取应匹配 1 次，实际匹配 ${matches} 次。请核查固定依赖后更新构建适配。`);
        }
        patchedModules++;
        // 固定 DSH 包通过自身 package.json 读取版本，单文件分发时将其固化为实际安装版本。
        return {
          contents: source.replace(llmVersionLookup, JSON.stringify({ version: llmVersion })),
          loader: 'js',
          resolveDir: path.dirname(args.path),
        };
      });
    },
  }],
});

if (patchedModules !== 1) {
  throw new Error(`DSH LLM 版本固化应处理 1 个模块，实际处理 ${patchedModules} 个。`);
}
const externalPackages = Object.values(result.metafile.outputs)
  .flatMap(output => output.imports)
  .filter(item => item.external && !isBuiltin(item.path));
if (externalPackages.length) {
  throw new Error(`CLI 存在未内嵌的运行时依赖：${[...new Set(externalPackages.map(item => item.path))].join(', ')}`);
}

for (const output of result.outputFiles) {
  await mkdir(path.dirname(output.path), { recursive: true });
  await writeFile(output.path, output.contents);
}
console.log(`已构建自包含 CLI dist/src/cli.js，DSH ${harnessVersion}。`);
