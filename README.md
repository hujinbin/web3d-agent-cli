# Web3D Agent CLI

面向 **Three.js 3D 应用与 Python 后端**的编程智能体终端工具。使用 TypeScript 实现，自行维护模型调用、工具执行、项目规则和会话；参考 Claude Code 的执行循环思路，未复制其实现代码。

```text
web3d › 检查模型切换后 GPU 内存持续增长的问题，修复并运行现有检查

  模型 → 搜索/读取 → 工具结果 → 模型 → 编辑/验证 → 最终说明
                    ↑ 项目规则、执行权限与文件状态检查 ↑
```

## 开始使用

需要 **Node.js 22 或更新版本**。Python 只在目标项目的后端任务需要时使用，CLI 本身不依赖 Python。

```powershell
cd E:\github\web3d-agent-cli
npm install
npm run build

# 无密钥体验真实的工具执行闭环；模型部分是固定离线脚本
npm start -- run "检查项目结构" --demo

# 注册本机命令，之后可在其他项目使用 web3d-agent
npm link
```

连接兼容 OpenAI 的 Chat Completions 接口，模型必须支持 `tools` / `tool_calls`。Base URL 填 API 根地址，CLI 自动追加 `/chat/completions`，也接受已经带该后缀的地址。

```powershell
# 在你真正要开发的 Three.js / Python 项目中初始化
web3d-agent init -C E:\github\your-web3d-project

# 以下值替换成服务商提供的实际配置
$env:WEB3D_BASE_URL = "https://your-provider.example/v1"
$env:WEB3D_MODEL = "your-tool-calling-model"
$env:WEB3D_API_KEY = "your-api-key"

web3d-agent chat -C E:\github\your-web3d-project
```

本地免认证服务可以不设置密钥，例如 `--base-url http://localhost:11434/v1 --model <已安装且支持工具的模型>`。远程服务使用 HTTPS。CLI 不会自动读取 `.env`；密钥只从环境变量读取，不写进配置或会话。

## 已实现的能力

- 交互式对话和单次任务；流式文本输出，工具参数完整组装后才执行。
- 自定义模型、Base URL、密钥环境变量；可切换非流式 JSON。
- 7 个内置工具：列目录、读文件、文字搜索、写文件、精确编辑、命令执行、项目启发式检查。
- Three.js、Python 后端和通用工程三组内置规则，加上目标项目的 `AGENTS.md` 与补充规则。
- `ask`、`auto-edit`、`plan` 模式，文件编辑和命令执行分别授权。
- 文件读取状态与 SHA-256 检查，防止覆盖读取后已变化的内容。
- 项目内会话持久化、恢复与取消，工具调用和结果配对保存。
- 请求超时、命令超时、输出大小、模型调用轮次和上下文字符预算。
- 不需要模型或网络的演示模式，以及本地 HTTP 模拟服务测试。

## 任务示例

```powershell
# 先只读分析场景与后端架构
web3d-agent run "梳理场景对象和 Python API 的数据流，列出改进计划" --mode plan

# 允许文件修改；每条命令仍单独询问
web3d-agent run "修复 Three.js resize 和资源销毁逻辑，补充相关测试" --mode auto-edit

# 明确允许本次运行中的命令，适合已信任项目的自动验证
web3d-agent run "为模型列表 API 补充输入验证，运行已有测试" --mode auto-edit --allow-run

# 让模型维护前后端契约
web3d-agent run "检查场景模型字段与 Python 响应模型是否一致，修复类型和空值处理"

# 自动化集成：每行一个 JSON 事件，无法询问时拒绝未授权动作
web3d-agent run "检查当前项目" --mode plan --json

# 接口不支持 SSE 时
web3d-agent run "解释场景初始化流程" --no-stream
```

`run_command` 使用独立的 `command` 与 `args` 数组，不自动解释管道、重定向或 shell 字符串。Windows 下拒绝隐式执行 `.cmd/.bat` 和 npm 包装命令：可以明确调用 `powershell.exe`，或用 `node` 运行包管理器的实际 JS 入口。显式 shell 命令同样需要命令授权。

## 项目规则

`web3d-agent init` 创建以下两个文件，**保留已有内容**：

```text
your-project/
├── web3d-agent.json
├── AGENTS.md                       # 可选，加载根目录文件
└── .web3d-agent/
    ├── rules/
    │   ├── project.md              # 初始化创建的补充规则
    │   └── api-contract.md         # 可以自行增加
    └── sessions/                   # 本地历史，建议加入 .gitignore
```

内置规则与项目补充规则一起提供给模型。项目规则用于表达开发约束，不能撤销运行时的路径、审批和只读模式限制。规则在进程启动时加载；修改后重新启动 CLI。

可以把实际项目约定写进 `project.md`：

```markdown
# 项目规则

- 前端沿用现有 Vue 3 与 Three.js，后端沿用 FastAPI，不迁移框架。
- 世界坐标使用米，Y 轴朝上；场景元数据存储在既有数据库。
- 贴图和 GLB 统一经过现有资源服务加载，不硬编码本机路径。
- 前端和后端分别使用现有 API 类型与 Pydantic 模型，字段调整要同步。
- 场景卸载必须清理事件和非共享 GPU 资源。
- Python 路由声明旁添加中文用途说明，异步请求中不直接使用阻塞客户端。
- 验证使用项目已有的构建与测试脚本；未执行 WebGL 验证时明确说明。
```

规则是模型的开发指引；路径检查、审批和文件状态检查由代码强制执行。`check_project` 只对有限文件给出线索，例如“同一 Python 文件中出现 async 与同步请求”。它不运行类型检查、不能证明存在漏洞或内存泄漏，也不能代替浏览器与 GPU 验证。

## 配置

`web3d-agent.json` 的完整格式：

```json
{
  "baseUrl": "https://your-provider.example/v1",
  "model": "your-tool-calling-model",
  "apiKeyEnv": "WEB3D_API_KEY",
  "maxSteps": 20,
  "contextChars": 100000,
  "maxOutputTokens": 4096,
  "requestTimeoutMs": 120000,
  "stream": true
}
```

优先级为 **命令行 > `WEB3D_MODEL` / `WEB3D_BASE_URL` > 项目配置 > 默认值**。密钥优先读取 `apiKeyEnv` 指定变量，未设置时兼容 `OPENAI_API_KEY`。默认不选择付费模型；模型名需要自己配置。

`contextChars` 是当前请求的字符预算，不是精确 token 数。超过预算时，只移出较早的完整用户轮次，并保留本地原始历史；不会使用模型摘要。当前单个任务也超过预算时会停止，避免破坏工具调用配对。可缩小任务、开始新会话或调整预算。

规则读取限制为单文件 16 KiB、项目规则总计 64 KiB、最多 32 个项目文件。文件工具处理 UTF-8 文本，单文件最多 1 MiB，单次输出最多约 24,000 字符；目录和搜索也有范围上限。

大文件可以根据 `read_file` 返回的 `nextOffset` 继续分页。`partial` 表示当前返回值不是全文件，`fullyRead` 表示当前进程已累计观察到同一版本的全部行；只有 `fullyRead` 才允许覆盖。文件变化会清空分页证据。单行内容若无法放入输出预算会明确报错，不能通过截断读取取得覆盖权限；大量分页仍受当前任务的上下文预算限制。

## 模式与执行边界

| 模式 | 读取和检查 | 文件修改 | 执行命令 |
| --- | --- | --- | --- |
| `ask`（默认） | 直接执行 | 每次询问 | 每次询问 |
| `auto-edit` | 直接执行 | 自动批准 | 每次询问 |
| `plan` | 直接执行 | 拒绝 | 拒绝 |

`--allow-run` 允许当前进程中的命令调用，仍不能覆盖 `plan`。非交互环境和 `--json` 模式不会阻塞等待输入，未授权动作作为工具错误返回模型。

文件工具限制在目标工作区内，拒绝越界和指向工作区外的链接，过滤 `.git`、会话目录和常见凭据文件；允许 `.env.example` 等示例文件。固定跳过依赖、构建目录，不完整解析项目 `.gitignore`。

**外部命令不是操作系统沙箱**：批准后的程序拥有当前用户的文件和网络权限。文件工具的路径过滤不能限制该程序。工具也不提供跨进程文件锁；其他程序同时改动文件时仍需检查最终差异。

会话可能包含项目代码、用户输入和命令输出，应按项目敏感资料处理。建议在目标项目的 `.gitignore` 中加入 `.web3d-agent/sessions/`。CLI 不会自动修改目标项目的 Git 配置。

## 会话命令

```text
/help                       查看会话命令
/rules                      查看已加载规则来源
/status                     查看模型、模式和会话 ID
/sessions                   列出本工作区会话
/resume <ID|latest>          恢复会话
/new                        开始新会话
/mode <ask|auto-edit|plan>   切换模式
/exit                       退出
```

也可以用 `web3d-agent chat --resume latest` 或 `web3d-agent run "继续任务" --resume <ID>`。恢复后文件读取缓存不会沿用，覆盖前需要重新读取。Ctrl+C 取消当前任务；已经完成的文件修改保留，不自动回滚。

退出码：`0` 表示循环正常结束，`1` 表示配置或运行错误，`2` 表示达到轮次上限，`130` 表示取消。正常结束只代表执行循环结束，是否通过测试应以实际工具输出为准。

## 开发与验证

```powershell
npm run dev -- --help
npm run typecheck
npm test
npm pack --dry-run
```

测试覆盖工具调用配对、审批、取消、上下文边界、SSE 工具参数分片、接口截断、路径边界、文件过期、规则加载、会话恢复与 CLI 离线贯通。API 测试使用本机 HTTP 假服务，不需要真实密钥。Windows 中创建文件符号链接需要权限，相应测试无法创建时明确跳过；目录 junction 边界另有测试。

当前版本未包含浏览器控制、3D 画面预览、MCP、子代理调度和自动摘要。它可以借助已批准命令运行目标项目自己的测试，但不会自动获得视觉验证能力。

架构说明见 [docs/architecture.md](docs/architecture.md)。

协议与领域规则参考：[Chat Completions API](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[Three.js 资源清理](https://threejs.org/manual/#en/cleanup)、[FastAPI 异步边界](https://fastapi.tiangolo.com/async/)。
