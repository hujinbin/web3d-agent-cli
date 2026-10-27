# Web3D Agent CLI 开发约定

- CLI 使用 TypeScript 和 Node.js 22+，运行时依赖优先采用 Node 内建模块。
- 核心接口位于 `src/types.ts`，新增 Provider 和工具沿用这些接口。
- 新增注释使用中文。领域规则不能撤销代码实现的权限、工作区和审批边界。
- 不在仓库、配置、日志和测试夹具中放入真实 API 密钥。
- 工具调用与工具结果必须配对，取消和错误路径同样需要可恢复的消息状态。
- 使用 `npm run typecheck` 和 `npm test` 验证修改；API 测试使用本机假服务。
- 文档中区分离线演示、接口集成测试和真实模型验证，不虚构 Three.js 渲染结果。
