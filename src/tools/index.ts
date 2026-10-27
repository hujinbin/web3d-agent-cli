import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ToolContext, ToolDefinition } from '../types.js';
import {
  checkAbort, checkedWrite, fingerprint, inputKeys, integerArg, MAX_OUTPUT_CHARS,
  readText, textArg, walkFiles, workspacePath,
} from './workspace.js';
import { readFile } from './readFile.js';

const str = { type: 'string' };
const schema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({ type: 'object', properties, required, additionalProperties: false });

async function runCommand(input: Record<string, unknown>, context: ToolContext): Promise<unknown> {
  inputKeys(input, ['command', 'args', 'timeout_ms']);
  checkAbort(context);
  const command = textArg(input, 'command');
  if (!command.trim()) throw new Error('command 不能为空');
  const args = input.args;
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('args 必须为字符串数组');
  const timeout = integerArg(input, 'timeout_ms', 30_000, 1, 120_000);
  if (process.platform === 'win32' && (/\.(cmd|bat)$/i.test(command) || /^(npm|npx|pnpm|yarn)$/i.test(command))) {
    throw new Error('Windows 下不隐式执行 .cmd/.bat。请用 node 执行包管理器的真实 JS 入口，或明确使用 PowerShell 作为 command。');
  }
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args as string[], { cwd: context.cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    const collect = (text: string): void => {
      const remaining = MAX_OUTPUT_CHARS - output.length;
      output += text.slice(0, Math.max(remaining, 0));
      if (text.length > remaining) truncated = true;
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const terminate = (): void => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        // 只终止本次创建的进程树，不按进程名称批量操作。
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    const onAbort = (): void => { aborted = true; terminate(); };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeout);
    context.signal.addEventListener('abort', onAbort, { once: true });
    const cleanup = (): void => { clearTimeout(timer); context.signal.removeEventListener('abort', onAbort); };
    child.on('error', error => { cleanup(); reject(new Error(`命令无法启动：${error.message}`)); });
    child.on('close', (code, signal) => {
      cleanup();
      resolve({ exitCode: code, signal, timedOut, aborted, truncated, output, isError: timedOut || aborted || code !== 0 });
    });
    if (context.signal.aborted) onAbort();
  });
}

async function checkProject(context: ToolContext): Promise<unknown> {
  const listing = await walkFiles(context, await workspacePath(context, '.'), 5, 1500);
  const diagnostics: { level: string; file: string; message: string }[] = [];
  const front = listing.files.filter(file => /\.(tsx?|jsx?|vue)$/.test(file));
  const python = listing.files.filter(file => file.endsWith('.py'));
  let three = false;
  let cleanup = false;
  let animation = false;
  for (const file of front.slice(0, 60)) {
    checkAbort(context);
    try {
      const content = await readText(await workspacePath(context, file));
      if (/from\s*['"](?:three|@react-three\/fiber)|THREE\./.test(content)) three = true;
      if (/\.dispose\s*\(/.test(content)) cleanup = true;
      if (/requestAnimationFrame|setAnimationLoop|useFrame/.test(content)) animation = true;
    } catch { /* 扫描跳过过大或非文本文件，保留其余诊断。 */ }
  }
  if (three && animation && !cleanup) diagnostics.push({ level: 'review', file: '(已扫描的前端文件)', message: '发现 Three.js 与动画调用，未发现显式 dispose；请检查生命周期清理或由框架管理的资源释放，不能据此断定内存泄漏。' });
  for (const file of python.slice(0, 60)) {
    checkAbort(context);
    try {
      const content = await readText(await workspacePath(context, file));
      if (/async def/.test(content) && /time\.sleep\s*\(|requests\.(get|post|put|delete)\s*\(/.test(content)) {
        diagnostics.push({ level: 'review', file, message: '同一文件中出现 async def 和同步阻塞调用；请人工确认是否位于异步请求路径。' });
      }
      if (/CORSMiddleware/.test(content) && /allow_origins\s*=\s*\[\s*['"]\*['"]/.test(content)) {
        diagnostics.push({ level: 'review', file, message: '发现通配 CORS 来源，请检查部署环境与凭据策略。' });
      }
    } catch { /* 不让单个文件失败中断整个项目的启发式检查。 */ }
  }
  const contracts = listing.files.filter(file => /(?:openapi|schema|contract|pydantic)/i.test(file));
  return {
    scope: '启发式文件检查，不替代类型检查、运行测试或浏览器渲染验证',
    filesScanned: listing.files.length, truncated: listing.truncated,
    frontend: { files: front.length, sampled: Math.min(front.length, 60), threeDetected: three },
    backend: { pythonFiles: python.length, sampled: Math.min(python.length, 60) },
    contractFiles: contracts.slice(0, 20), diagnostics: diagnostics.slice(0, 30),
    suggestedChecks: [
      ...(front.length ? ['在项目既有脚本中运行 TypeScript 类型检查和前端构建；人工确认相机、尺寸、动画与清理。'] : []),
      ...(python.length ? ['使用项目指定的 Python 环境运行 pytest 与类型/格式检查；验证 API 请求与响应契约。'] : []),
    ],
  };
}

export function createTools(): ToolDefinition[] {
  return [
    {
      name: 'list_files', kind: 'read', description: '列出工作区内文件，跳过依赖目录、凭据、版本库内部和符号链接；不是完整 gitignore 解析器。',
      parameters: schema({ path: str, max_depth: { type: 'integer', minimum: 0, maximum: 5 } }),
      async execute(input, context) {
        inputKeys(input, ['path', 'max_depth']);
        const start = await workspacePath(context, textArg(input, 'path', '.'));
        return await walkFiles(context, start, integerArg(input, 'max_depth', 2, 0, 5));
      },
    },
    {
      name: 'read_file', kind: 'read', description: '读取 UTF-8 文本，最多 1 MiB。offset 为从 1 开始的行号，按 nextOffset 继续分页；同版本全部行已返回后 fullyRead 为 true，才允许覆盖。超长单行可能无法返回。',
      parameters: schema({ path: str, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 2000 } }, ['path']),
      async execute(input, context) {
        inputKeys(input, ['path', 'offset', 'limit']);
        return readFile(input, context);
      },
    },
    {
      name: 'search_text', kind: 'read', description: '按文字搜索工作区文本，不执行正则表达式。结果有数量及长度上限。',
      parameters: schema({ query: str, path: str, limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['query']),
      async execute(input, context) {
        inputKeys(input, ['query', 'path', 'limit']);
        const query = textArg(input, 'query');
        if (!query || query.length > 1000) throw new Error('query 长度必须为 1 到 1000');
        const limit = integerArg(input, 'limit', 30, 1, 100);
        const listing = await walkFiles(context, await workspacePath(context, textArg(input, 'path', '.')), 5);
        const matches: { path: string; line: number; text: string }[] = [];
        let outputSize = 0;
        let truncated = listing.truncated;
        for (const file of listing.files) {
          checkAbort(context);
          let content: string;
          try { content = await readText(await workspacePath(context, file)); } catch { continue; }
          for (const [index, line] of content.split('\n').entries()) {
            if (!line.includes(query)) continue;
            const text = line.slice(0, 500);
            if (matches.length >= limit || outputSize + text.length + file.length > MAX_OUTPUT_CHARS) { truncated = true; break; }
            matches.push({ path: file, line: index + 1, text });
            outputSize += text.length + file.length;
          }
          if (truncated && (matches.length >= limit || outputSize >= MAX_OUTPUT_CHARS - 1000)) break;
        }
        return { matches, truncated };
      },
    },
    {
      name: 'write_file', kind: 'write', description: '创建或完整覆盖 UTF-8 文件。覆盖前必须在当前会话完整读取且文件哈希未变化。',
      parameters: schema({ path: str, content: str }, ['path', 'content']),
      async execute(input, context) {
        inputKeys(input, ['path', 'content']);
        const target = await workspacePath(context, textArg(input, 'path'));
        return checkedWrite(context, target, textArg(input, 'content'));
      },
    },
    {
      name: 'edit_file', kind: 'write', description: '用精确字符串替换已完整读取的文件内容，拒绝过期内容、空匹配和未经指定的多处替换。',
      parameters: schema({ path: str, old_text: str, new_text: str, replace_all: { type: 'boolean' } }, ['path', 'old_text', 'new_text']),
      async execute(input, context) {
        inputKeys(input, ['path', 'old_text', 'new_text', 'replace_all']);
        const target = await workspacePath(context, textArg(input, 'path'));
        const oldText = textArg(input, 'old_text');
        const newText = textArg(input, 'new_text');
        if (!oldText) throw new Error('old_text 不能为空');
        if (oldText === newText) throw new Error('新旧内容相同，无需修改');
        if (input.replace_all !== undefined && typeof input.replace_all !== 'boolean') throw new Error('replace_all 必须为布尔值');
        const content = await readText(target);
        const occurrences = content.split(oldText).length - 1;
        if (!occurrences) throw new Error('未找到 old_text，请重新读取文件');
        if (occurrences > 1 && input.replace_all !== true) throw new Error('old_text 存在多个匹配，请提供更明确的上下文或启用 replace_all');
        return checkedWrite(context, target, input.replace_all === true ? content.split(oldText).join(newText) : content.replace(oldText, () => newText), true);
      },
    },
    {
      name: 'run_command', kind: 'command', description: '按 argv 执行命令，不隐式调用 shell。命令需要单独授权；不提供操作系统沙箱，最多运行 120 秒并截断输出。',
      parameters: schema({ command: str, args: { type: 'array', items: str }, timeout_ms: { type: 'integer', minimum: 1, maximum: 120000 } }, ['command', 'args']),
      execute: runCommand,
    },
    {
      name: 'check_project', kind: 'read', description: '启发式检查 Three.js 资源生命周期、Python 异步阻塞线索与前后端契约文件，不运行命令且不保证通过检查即正确。',
      parameters: schema({}),
      async execute(input, context) { inputKeys(input, []); return await checkProject(context); },
    },
  ];
}
