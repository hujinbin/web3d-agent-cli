# Web3D Agent CLI 架构

CLI 基于 DeepSeek Harness 的核心插件组合，使用兼容 OpenAI 的 Chat Completions 协议接入模型。固定依赖 DSH `0.2.1-rc.5` 与 Cordis `4.0.5`，版本通过 `package-lock.json` 锁定。

```text
cli.ts
  ├─ config.ts             配置优先级与参数校验
  ├─ rules/index.ts        内置规则 + 项目规则 → system prompt
  ├─ session.ts            用户轮次与配对工具消息的本地存储
  ├─ tools/project.ts      本地 check 与 check_project 的共享诊断
  └─ runtime/dsh.ts        DSH 运行时与接口桥接
       ├─ Cordis Context
       ├─ DSH AgentRegistry / AgentLoop
       ├─ DSH LlmRuntime → providers/openai.ts 或 DemoProvider
       ├─ DSH SessionStore / SessionProjectionRegistry
       ├─ DSH SystemPrompt
       └─ DSH ToolRuntime → 审批与 tools/index.ts
                                └─ tools/workspace.ts
```

## 一次任务如何执行

1. 创建本次任务的 Cordis Context，挂载 DSH 的模型、会话、投影、系统提示词、工具和 AgentLoop 服务。
2. 将既有 Session v1 历史保留为请求前缀，当前任务通过 DSH 的 `followup()` 提交。
3. DSH AgentLoop 生成模型请求，适配层按完整用户轮次应用字符预算，并交给既有 Provider。
4. Provider 完整校验工具调用和结束原因后，映射为 DSH 的文本、思考和工具调用内容块。
5. DSH ToolRuntime 按顺序调度工具，工作区工具的执行入口检查模式和审批，并使用原有文件读取证据与路径检查。
6. 将 DSH 当前任务的消息投影到 Session v1，保留思考协议字段、原始工具参数和配对结果，保存后进入下一步。
7. 达到模型调用轮次限制、取消或发生错误时，等待 DSH 执行收敛，补齐工具结果并保存，随后释放 Context。

`maxParallelToolCalls` 设置为 `1`，保持编辑顺序与文件状态一致。流式输出期间只显示普通文本，工具参数在完整响应通过校验后进入 DSH。`src/agent.ts` 的 `runAgent()` 保留原有接口并委托 DSH 运行时，预算和结果大小处理在此共享。

## 规则与权限

领域规则描述质量要求：Three.js 资源所有权、动画、相机与性能，以及 Python API 契约、异步边界、持久化与验证。规则不会自动把项目改造成特定框架。

运行时权限独立于自然语言规则。修改与命令分别决策；`plan` 拒绝任何写入与命令。文件工具拒绝常见私密路径与工作区外访问。命令工具需要单独授权，批准后没有操作系统层面的隔离。

## 状态与恢复

会话位于目标项目的 `.web3d-agent/sessions/<UUID>.json`。每次保存使用临时文件和替换，恢复时验证版本、工作目录及工具调用配对。既有 v1 文件可以继续加载，历史中已保存的 `reasoning_content` 会在后续模型请求中回传。用户主动输入和命令输出也属于会话正文。

每个用户任务创建一份进程内 DSH 会话，使用 DSH 的消息投影更新已有会话文件。持久化格式继续采用本项目的 Session v1。下一用户任务从这些历史消息恢复模型上下文，DSH 运行时重新建立。这一实现面向当前文本与工具调用协议。DSH 的其他插件和原生日志扩展需要各自的接入与持久化处理。

文件读取证据仅驻留当前进程。较大文件按完整行分页，最终序列化大小也计入输出预算；同一版本的全部行都被返回后才获得完整读取状态。覆盖前验证当前内容与读取版本的 SHA-256 一致；恢复历史不恢复读取授权。写入保护减少覆盖较新修改的风险，但不提供跨进程锁或完整事务。文件符号链接明确拒绝编辑，避免把重命名写入误用于替换链接本身。

当前版本根据字符数约束请求，移出旧轮次时通知模型和用户；本地历史仍保留。当前轮次超出预算会停止，不假造摘要，不拆散工具调用与结果。

## 本地项目诊断

`inspectProject()` 同时服务 `check_project` 模型工具与 `web3d-agent check` 命令。检查使用有界文件枚举、源码采样和文本匹配。Three.js 清理线索按文件计算，Python 线索记录匹配行，读取失败与采样限制进入跳过统计。

报告中的 `schemaVersion` 为 `1`，`summary` 提供实际读取数量，`limits` 与 `coverage` 提供覆盖范围，诊断包含稳定代码、路径、行号、证据和 `review` 级别。命令和工具共享现有路径过滤与输出预算。

## 验证分层

- Provider 测试使用本机 HTTP 服务，检查实际请求映射、SSE 分片与错误边界。
- 工具测试使用临时目录，检查路径、过期写入、文字替换、进程超时和取消。
- Agent 测试挂载真实 DSH 核心服务，使用可控模型响应检查审批、结果配对、投影、预算和循环停止。
- CLI 测试启动真实 Node 子进程，贯通初始化、离线工具执行与会话恢复。

离线演示只模拟模型决策，目录检查等工具真实执行。它不证明某个商业模型或网关可以连通。`check_project` 的启发式观察也不等同于 Python 测试、前端构建或 Three.js 实际渲染结果。

DSH 预览包固定的 Zod 版本通过本项目 `overrides` 覆盖为 `4.6.7`。构建先执行 TypeScript 编译，再通过 `scripts/build-cli.mjs` 将 DSH 和 Zod 编入 CLI 入口。DSH 相关包作为构建依赖维护，发布包中的命令使用已构建的运行时。

构建脚本固化 CLI 与 DSH 内部的版本元数据，并验证产物的外部引用全部属于 Node 内建模块。DSH `dsh-llm` 读取版本元数据的位置按固定版本匹配，升级上游包时需重新核对该构建适配。独立目录测试确认入口文件可以单独启动 DSH、模型适配和工具执行。

相关接口见 [DSH 官方源码](https://github.com/deepseek-ai/deepseek-harness) 与 [固定版本 AgentLoop 包](https://www.npmjs.com/package/@deepseek-ai/dsh-agent-loop/v/0.2.1-rc.5)。
