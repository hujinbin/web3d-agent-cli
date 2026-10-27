#!/usr/bin/env node
import { realpath } from 'node:fs/promises';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { runAgent } from './agent.js';
import { loadConfig } from './config.js';
import { DemoProvider } from './providers/demo.js';
import { OpenAICompatibleProvider } from './providers/openai.js';
import { buildSystemPrompt, initializeProject, loadRules } from './rules/index.js';
import { createSession, listSessions, readSession, saveSession } from './session.js';
import { createTools } from './tools/index.js';
import type { AgentConfig, AgentEvent, ApprovalRequest, PermissionMode } from './types.js';

const HELP = `
web3d-agent 0.1.0 · Three.js / Python 编程智能体

用法：
  web3d-agent init                         初始化项目配置与规则
  web3d-agent chat                         交互式对话（默认）
  web3d-agent run "修复场景销毁时的内存泄漏"  执行单次任务
  web3d-agent rules                        查看当前加载的规则
  web3d-agent sessions                     列出工作区会话
  web3d-agent doctor                       检查配置与运行环境

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
      --json                 单次运行输出 JSONL；不会交互询问，未授权操作自动拒绝
  -h, --help                 显示帮助
  -v, --version              显示版本

模型密钥通过 WEB3D_API_KEY（或配置的 apiKeyEnv）传入，也兼容 OPENAI_API_KEY。
配置优先级：命令行 > WEB3D_MODEL/WEB3D_BASE_URL > web3d-agent.json > 默认值。
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
  if (values.version) { stdout.write('0.1.0\n'); return; }
  const cwd = await realpath(values.cwd ?? process.cwd());
  const command = positionals[0] ?? 'chat';
  if (!['init', 'chat', 'run', 'rules', 'sessions', 'doctor'].includes(command)) throw new Error(`未知命令 ${command}。请使用 run "任务" 或 --help`);
  if (command !== 'run' && positionals.length > 1) throw new Error(`${command} 不接受额外参数`);
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
  const config = await loadConfig(cwd, overrides);
  const apiKey = process.env[config.apiKeyEnv] || process.env.OPENAI_API_KEY;
  // 配置校验不会发起网络连接，也不会输出环境变量中的密钥。
  if (command === 'doctor') {
    new OpenAICompatibleProvider(config, apiKey);
    stdout.write(`Node: ${process.version}\n工作目录: ${cwd}\nAPI: ${config.baseUrl}\n模型: ${config.model || '未配置'}\n密钥: ${apiKey ? '已设置' : '未设置（本地免认证服务可省略）'}\n流式: ${config.stream}\n规则: ${loaded.rules.length} 条\n`);
    for (const warning of loaded.warnings) stdout.write(`提示: ${warning}\n`);
    stdout.write('未调用模型；真实连通性请执行一个小任务验证。\n');
    return;
  }
  let mode = values.mode ?? 'ask';
  if (!['ask', 'auto-edit', 'plan'].includes(mode)) throw new Error('mode 必须是 ask、auto-edit 或 plan');
  if (values.json && command !== 'run') throw new Error('--json 仅支持 run 单次任务');
  if (command === 'run' && !positionals.slice(1).join(' ').trim()) throw new Error('run 后需要提供任务文本');
  if (command === 'chat' && !stdin.isTTY) throw new Error('非交互终端请使用 run "任务"；运行离线演示可加 --demo');
  if (!values.demo) {
    if (!config.model) throw new Error('请先通过 --model、WEB3D_MODEL 或 web3d-agent.json 设置模型名；离线体验使用 --demo');
    const host = new URL(config.baseUrl).hostname;
    if (!apiKey && !['localhost', '127.0.0.1', '[::1]'].includes(host)) throw new Error(`未设置 ${config.apiKeyEnv}（或 OPENAI_API_KEY）。本地免认证服务可省略密钥`);
  }
  const provider = values.demo ? new DemoProvider() : new OpenAICompatibleProvider(config, apiKey);
  let session = createSession(cwd);
  if (values.resume) {
    const id = values.resume === 'latest' ? (await listSessions(cwd))[0]?.id : values.resume;
    if (!id) throw new Error('没有可恢复的会话');
    session = await readSession(cwd, id);
  }
  const rl = stdin.isTTY && !values.json ? createInterface({ input: stdin, output: stdout }) : undefined;
  let active: AbortController | undefined;
  const cancel = () => {
    if (active) active.abort(new Error('用户取消任务'));
    else rl?.close();
  };
  process.on('SIGINT', cancel);
  rl?.on('SIGINT', cancel);
  const clean = (value: string) => stripVTControlCharacters(value).replace(/\r/g, '');
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
      const result = await runAgent({
        provider, tools: createTools(), session, prompt,
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
    if (!values.json) {
      stdout.write(`\nWEB3D AGENT · ${values.demo ? '离线演示脚本' : config.model}\n${cwd}\n模式 ${mode} · 规则 ${loaded.rules.length} · /help 查看命令\n`);
      for (const warning of loaded.warnings) process.stderr.write(`规则提示：${warning}\n`);
    }
    if (command === 'run') { await execute(positionals.slice(1).join(' ')); return; }
    while (rl) {
      let prompt: string;
      try { prompt = (await rl.question('\nweb3d › ')).trim(); } catch { break; }
      if (!prompt) continue;
      if (prompt === '/exit' || prompt === '/quit') break;
      if (prompt === '/help') { stdout.write('/help /rules /status /sessions /resume <ID|latest> /new /mode <ask|auto-edit|plan> /exit\n'); continue; }
      if (prompt === '/rules') { stdout.write(loaded.rules.map(rule => `• ${rule.name} (${rule.source})`).join('\n') + '\n'); continue; }
      if (prompt === '/status') { stdout.write(`会话 ${session.id}\n消息 ${session.messages.length} · 模式 ${mode} · 模型 ${values.demo ? '离线脚本' : config.model}\n`); continue; }
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
