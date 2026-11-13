#!/usr/bin/env node
import { realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { stdin, stdout } from 'node:process';
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { runDshAgent } from './runtime/dsh.js';
import { getUserConfigDir, loadConfigWithSource, saveUserConfig } from './config.js';
import { loadApiKey } from './credentials.js';
import { configureModel } from './setup.js';
import { createTerminal } from './terminal.js';
import { DemoProvider } from './providers/demo.js';
import { OpenAICompatibleProvider } from './providers/openai.js';
import { buildSystemPrompt, initializeProject, loadRules } from './rules/index.js';
import { createSession, listSessions, readSession, saveSession } from './session.js';
import { createTools } from './tools/index.js';
import { inspectProject } from './tools/project.js';
import type { AgentConfig, AgentEvent, ApprovalRequest, PermissionMode } from './types.js';

declare const __WEB3D_DSH_VERSION__: string | undefined;
declare const __WEB3D_VERSION__: string | undefined;
const version = typeof __WEB3D_VERSION__ === 'string'
  ? __WEB3D_VERSION__
  : String(createRequire(import.meta.url)('../package.json').version);
const harness = {
  name: 'DeepSeek Harness',
  version: typeof __WEB3D_DSH_VERSION__ === 'string'
    ? __WEB3D_DSH_VERSION__
    : String(createRequire(import.meta.url)('@deepseek-ai/dsh-agent-loop/package.json').version),
};
const clean = (value: string) => stripVTControlCharacters(value).replace(/\r/g, '');

const HELP = `
web3d-agent ${version} · DSH / Three.js / Python 编程智能体

用法：
  web3d-agent init                         初始化项目配置与规则
  web3d-agent chat                         交互式对话（默认）
  web3d-agent run "修复场景销毁时的内存泄漏"  执行单次任务
  web3d-agent rules                        查看当前加载的规则
  web3d-agent sessions                     列出工作区会话
  web3d-agent doctor                       检查配置与运行环境
  web3d-agent check                        本地检查 Three.js / Python 项目
  web3d-agent setup                        配置模型接口并保存为用户默认设置

选项：
  -C, --cwd <目录>           目标项目，默认当前目录
  -m, --model <模型名>       覆盖 WEB3D_MODEL 和项目配置
      --base-url <URL>       兼容 OpenAI 的 API 根地址，例如 http://localhost:11434/v1
      --mode <模式>          ask（默认）/ auto-edit / plan
      --allow-run            本次会话允许模型执行外部命令（拥有当前用户权限）
      --max-steps <数量>      每次输入的最大模型调用次数，默认 20
      --resume <ID|latest>   恢复同一工作区的会话，文件覆盖前仍需重新读取
      --demo                 使用离线演示脚本，无网络请求
      --no-stream            使用非流式 JSON，供不支持 SSE 的服务使用
      --json                 run 输出 JSONL，check / doctor 输出 JSON
  -h, --help                 显示帮助
  -v, --version              显示版本

首次交互启动会引导配置模型。聊天中输入 /model 切换模型，/setup 修改接口和密钥。
模型密钥也支持 WEB3D_API_KEY（或配置的 apiKeyEnv）及 OPENAI_API_KEY。
配置优先级：命令行 > 环境变量 > 项目配置 > 用户默认设置 > 内置默认值。
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      cwd: { type: 'string', short: 'C' }, model: { type: 'string', short: 'm' },
      'base-url': { type: 'string' }, mode: { type: 'string' },
      'allow-run': { type: 'boolean' }, 'max-steps': { type: 'string' },
      resume: { type: 'string' }, demo: { type: 'boolean' },
      'no-stream': { type: 'boolean' }, json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    },
  });
  if (values.help) { stdout.write(HELP); return; }
  if (values.version) { stdout.write(`${version}\n`); return; }
  const cwd = await realpath(values.cwd ?? process.cwd());
  const command = positionals[0] ?? 'chat';
  if (!['init', 'chat', 'run', 'rules', 'sessions', 'doctor', 'check', 'setup'].includes(command)) throw new Error(`未知命令 ${command}。请使用 run "任务" 或 --help`);
  if (command !== 'run' && positionals.length > 1) throw new Error(`${command} 不接受额外参数`);
  if (values.json && !['run', 'check', 'doctor'].includes(command)) throw new Error('--json 支持 run、check 和 doctor');
  if (command === 'check') {
    const report = await inspectProject({ cwd, signal: new AbortController().signal, readState: new Map() });
    if (values.json) stdout.write(JSON.stringify(report) + '\n');
    else {
      stdout.write(clean(`项目检查 · ${cwd}\n读取源码 ${report.summary.scannedFiles} · 跳过 ${report.summary.skippedFiles} · 检查建议 ${report.summary.diagnosticsReturned}/${report.summary.diagnosticsTotal}\n`));
      stdout.write(`扫描范围 深度 ${report.limits.maxDepth} · 枚举上限 ${report.limits.maxListedFiles} · 每类源码上限 ${report.limits.maxFilesPerDomain}\n截断 ${report.truncated ? '是，请查看 --json 中的 coverage' : '否'}\n`);
      if (report.summary.skippedFiles) stdout.write(`跳过统计 ${JSON.stringify(report.summary.skippedByReason)}\n`);
      for (const item of report.diagnostics) stdout.write(clean(`\n[${item.code}] ${item.file}:${item.line}\n${item.message}\n${item.evidence}\n`));
      stdout.write(`\n${report.scope}\n`);
    }
    return;
  }
  if (command === 'init') {
    const files = await initializeProject(cwd);
    stdout.write(files.length ? `已创建：\n${files.map(file => `  ${file}`).join('\n')}\n` : '配置和规则已存在，未覆盖文件。\n');
    return;
  }
  if (command === 'sessions') {
    const sessions = await listSessions(cwd);
    stdout.write(sessions.length ? sessions.map(item => `${item.id}  ${item.updatedAt}  ${item.messages.length} 条消息`).join('\n') + '\n' : '尚无会话。\n');
    return;
  }
  const loaded = await loadRules(cwd);
  if (command === 'rules') {
    for (const rule of loaded.rules) stdout.write(`\n# ${rule.name} [${rule.source}]\n${rule.content}\n`);
    for (const warning of loaded.warnings) process.stderr.write(`规则提示：${warning}\n`);
    return;
  }
  const overrides: Partial<AgentConfig> = {};
  if (values.model !== undefined) overrides.model = values.model;
  if (values['base-url'] !== undefined) overrides.baseUrl = values['base-url'];
  if (values['max-steps'] !== undefined) overrides.maxSteps = Number(values['max-steps']);
  if (values['no-stream']) overrides.stream = false;
  const loadedConfig = await loadConfigWithSource(cwd, overrides);
  let config = loadedConfig.config;
  let apiKey = process.env[config.apiKeyEnv] || process.env.OPENAI_API_KEY;
  let credentialError = false;
  if (!apiKey && !values.demo) {
    try { apiKey = await loadApiKey(config.baseUrl); }
    catch { credentialError = true; }
  }
  // 配置校验不会发起网络连接，也不会输出环境变量中的密钥。
  if (command === 'doctor') {
    new OpenAICompatibleProvider(config, apiKey);
    const report = {
      runtime: harness, node: process.version, cwd, baseUrl: config.baseUrl,
      model: config.model || null, apiKeyConfigured: Boolean(apiKey), stream: config.stream,
      rules: { count: loaded.rules.length, sources: loaded.rules.map(rule => rule.source), warnings: loaded.warnings },
      configuration: { directory: getUserConfigDir(), modelSource: loadedConfig.sources.model, baseUrlSource: loadedConfig.sources.baseUrl, credentialError },
      modelRequestPerformed: false,
    };
    if (values.json) stdout.write(JSON.stringify(report) + '\n');
    else {
      stdout.write(`运行时 ${harness.name} ${harness.version}\nNode ${report.node}\n工作目录 ${cwd}\nAPI ${config.baseUrl}\n模型 ${config.model || '未配置'}\n密钥 ${apiKey ? '已设置' : '未设置（本地免认证服务可省略）'}\n流式 ${config.stream}\n规则 ${loaded.rules.length} 条\n`);
      for (const warning of loaded.warnings) stdout.write(`提示 ${warning}\n`);
      stdout.write(`用户配置 ${getUserConfigDir()}\n配置模型来源 ${loadedConfig.sources.model}\n`);
      if (credentialError) stdout.write('保存的密钥暂不可用，可通过 setup 重新设置。\n');
      stdout.write('配置检查完成。模型连通性可通过 run 执行一个小任务验证。\n');
    }
    return;
  }
  let mode = values.mode ?? 'ask';
  if (!['ask', 'auto-edit', 'plan'].includes(mode)) throw new Error('mode 必须是 ask、auto-edit 或 plan');
  if (command === 'run' && !positionals.slice(1).join(' ').trim()) throw new Error('run 后需要提供任务文本');
  if (command === 'chat' && !stdin.isTTY) throw new Error('非交互终端请使用 run "任务"；运行离线演示可加 --demo');
  let demo = Boolean(values.demo);
  let provider = demo ? new DemoProvider() : new OpenAICompatibleProvider(config, apiKey);
  let session = createSession(cwd);
  if (values.resume) {
    const id = values.resume === 'latest' ? (await listSessions(cwd))[0]?.id : values.resume;
    if (!id) throw new Error('没有可恢复的会话');
    session = await readSession(cwd, id);
  }
  const terminal = stdin.isTTY && stdout.isTTY && !values.json ? createTerminal() : undefined;
  const rl = terminal?.readline;
  let active: AbortController | undefined;
  const cancel = () => {
    if (active) active.abort(new Error('用户取消任务'));
    else rl?.close();
  };
  process.on('SIGINT', cancel);
  rl?.on('SIGINT', cancel);
  const setup = async (modelsOnly = false): Promise<'completed' | 'cancelled' | 'failed'> => {
    if (!terminal) throw new Error('模型配置需要交互终端。请在终端运行 web3d-agent setup，或通过 --model 与环境变量提供模型配置');
    active = new AbortController();
    try {
      const selected = await configureModel({ current: config, apiKey, io: terminal, signal: active.signal, modelsOnly });
      config = { ...config, baseUrl: selected.baseUrl, model: selected.model };
      apiKey = selected.apiKey;
      provider = new OpenAICompatibleProvider(config, apiKey);
      demo = false;
      return 'completed';
    } catch (error) {
      if (active.signal.aborted || (error as Error).name === 'AbortError') {
        stdout.write('\n已取消模型配置。\n');
        return 'cancelled';
      }
      process.stderr.write(`模型配置失败 ${(error as Error).message}\n`);
      return 'failed';
    } finally { active = undefined; }
  };
  let lineOpen = false;
  const newline = () => { if (lineOpen) { stdout.write('\n'); lineOpen = false; } };
  const onEvent = (event: AgentEvent) => {
    if (values.json) { stdout.write(JSON.stringify(event) + '\n'); return; }
    if (event.type === 'text') { stdout.write(clean(event.text)); lineOpen = true; }
    else if (event.type === 'tool_start') {
      newline();
      stdout.write(`\n› ${event.name} ${clean(JSON.stringify(event.input)).slice(0, 220)}\n`);
    } else if (event.type === 'tool_end') {
      stdout.write(`${event.isError ? '✗' : '✓'} ${clean(event.result).slice(0, 650)}${event.result.length > 650 ? ' …' : ''}\n`);
    } else if (event.type === 'context_trimmed') { newline(); stdout.write(`历史预算：本次请求移出 ${event.removed} 条旧消息；本地会话仍保留。\n`); }
    else if (event.type === 'status') { newline(); stdout.write(`\n· ${event.text}\n`); }
  };
  const approve = async (request: ApprovalRequest): Promise<boolean> => {
    if (!rl || values.json || active?.signal.aborted) return false;
    newline();
    stdout.write(`\n待批准 ${request.tool}（${request.kind === 'command' ? '命令可访问当前用户能访问的文件和网络' : '文件修改'}）：\n${clean(JSON.stringify(request.input, null, 2)).slice(0, 6000)}\n`);
    try { return /^(y|yes|是)$/i.test((await rl.question('允许本次操作？[y/N] ', { signal: active?.signal })).trim()); }
    catch { return false; }
  };
  const readState = new Map<string, string>();
  const execute = async (prompt: string) => {
    active = new AbortController();
    try {
      const result = await runDshAgent({
        provider, model: demo ? 'demo' : config.model, tools: createTools(), session, prompt,
        systemPrompt: buildSystemPrompt({ cwd, mode: mode as PermissionMode, rules: loaded.rules }),
        mode: mode as PermissionMode, maxSteps: config.maxSteps, contextChars: config.contextChars,
        allowRun: values['allow-run'] ?? false, signal: active.signal, approve, onEvent,
        onSave: () => saveSession(session), readState,
      });
      newline();
      if (values.json) stdout.write(JSON.stringify({ type: 'done', reason: result, sessionId: session.id }) + '\n');
      else stdout.write(`\n[${result === 'completed' ? '本轮结束' : result === 'aborted' ? '已取消' : '达到轮次上限，任务可能尚未完成'}] 会话 ${session.id}\n`);
      if (result !== 'completed' && command === 'run') process.exitCode = result === 'aborted' ? 130 : 2;
    } catch (error) {
      newline();
      const aborted = active.signal.aborted;
      const message = aborted ? '已取消任务，已完成的修改仍保留' : (error as Error).message;
      if (values.json) stdout.write(JSON.stringify({ type: 'error', message, sessionId: session.id }) + '\n');
      else process.stderr.write(`错误：${message}\n会话 ${session.id}，可用 --resume 恢复。\n`);
      if (command === 'run') process.exitCode = aborted ? 130 : 1;
    } finally { active = undefined; }
  };
  try {
    if (command === 'setup') {
      const outcome = await setup();
      if (outcome !== 'completed') process.exitCode = outcome === 'cancelled' ? 130 : 1;
      return;
    }
    if (!demo && (!config.model || credentialError)) {
      if (!terminal) throw new Error('尚未设置模型名或可用凭据。请先在终端运行 web3d-agent setup，自动化调用也支持 --model、WEB3D_MODEL 和项目配置');
      stdout.write('\n欢迎使用 Web3D Agent，先配置一个模型即可开始。\n');
      const outcome = await setup();
      if (outcome !== 'completed') { process.exitCode = outcome === 'cancelled' ? 130 : 1; return; }
    }
    if (!values.json) {
      stdout.write(clean(`\nWEB3D AGENT · DSH ${harness.version}\n模型 ${demo ? '离线演示脚本' : config.model} · 模式 ${mode}\n接口 ${config.baseUrl}\n${cwd}\n/model 切换模型 · /setup 配置接口 · /help 查看命令\n`));
      for (const warning of loaded.warnings) process.stderr.write(`规则提示：${warning}\n`);
    }
    if (command === 'run') { await execute(positionals.slice(1).join(' ')); return; }
    while (rl) {
      let prompt: string;
      try { prompt = (await terminal!.question('\nweb3d › ')).trim(); } catch { break; }
      if (!prompt) continue;
      if (prompt === '/exit' || prompt === '/quit') break;
      if (prompt === '/help') { stdout.write('/help /model [模型ID] /setup /rules /status /sessions /resume <ID|latest> /new /mode <ask|auto-edit|plan> /exit\n'); continue; }
      if (prompt === '/setup' || prompt === '/model') { await setup(prompt === '/model' && !demo); continue; }
      if (prompt.startsWith('/model ')) {
        const model = prompt.slice(7).trim();
        if (!model || model.length > 200 || /[\x00-\x1f\x7f]/.test(model)) { stdout.write('请输入有效模型 ID。\n'); continue; }
        try {
          await saveUserConfig({ model, baseUrl: config.baseUrl });
          config = { ...config, model };
          provider = new OpenAICompatibleProvider(config, apiKey);
          demo = false;
          stdout.write(clean(`已切换并保存默认模型 ${model}\n`));
        } catch (error) { process.stderr.write(`保存模型失败 ${(error as Error).message}\n`); }
        continue;
      }
      if (prompt === '/rules') { stdout.write(loaded.rules.map(rule => `• ${rule.name} (${rule.source})`).join('\n') + '\n'); continue; }
      if (prompt === '/status') { stdout.write(clean(`会话 ${session.id}\n运行时 ${harness.name} ${harness.version}\n消息 ${session.messages.length} · 模式 ${mode} · 模型 ${demo ? '离线脚本' : config.model}\n接口 ${config.baseUrl}\n`)); continue; }
      if (prompt === '/sessions') { stdout.write((await listSessions(cwd)).map(item => `${item.id} ${item.updatedAt}`).join('\n') + '\n'); continue; }
      if (prompt === '/new') { session = createSession(cwd); readState.clear(); stdout.write('已开始新会话。\n'); continue; }
      if (prompt.startsWith('/mode ')) {
        const next = prompt.slice(6).trim();
        if (['ask', 'auto-edit', 'plan'].includes(next)) { mode = next; stdout.write(`模式已切换为 ${mode}\n`); }
        else stdout.write('可用模式：ask / auto-edit / plan\n');
        continue;
      }
      if (prompt.startsWith('/resume ')) {
        const target = prompt.slice(8).trim();
        try {
          const id = target === 'latest' ? (await listSessions(cwd))[0]?.id : target;
          if (!id) throw new Error('尚无会话');
          session = await readSession(cwd, id); readState.clear(); stdout.write(`已恢复 ${session.id}\n`);
        } catch (error) { process.stderr.write(`无法恢复：${(error as Error).message}\n`); }
        continue;
      }
      if (prompt.startsWith('/')) { stdout.write('未知会话命令，请输入 /help。\n'); continue; }
      await execute(prompt);
    }
  } finally {
    process.off('SIGINT', cancel);
    rl?.close();
  }
}

main().catch(error => {
  const json = process.argv.includes('--json');
  if (json) stdout.write(JSON.stringify({ type: 'error', message: (error as Error).message }) + '\n');
  else process.stderr.write(`错误：${(error as Error).message}\n`);
  process.exitCode = 1;
});
