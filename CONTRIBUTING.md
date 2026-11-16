# 参与开发

## 架构与入口

领域状态由 Rust 宿主 `pi-acp-workbenchd` 统一管理，客户端不维护第二套领域状态。ACP provider 是独立子进程。

- `rust/crates/pi-acp-workbenchd/src/domain/`：领域类型、命令、事件与纯 reducer。
- `actor*.rs`、`worker.rs`、`task_scope.rs`：状态所有权、进程预算与生命周期。
- `acp/`：外部协议转换；动态 JSON 限于明确标注的 codec 或不透明扩展边界。
- `persistence/`：SQLite 事务、历史归档、收发队列与离线维护。
- `telegram/`、`transport/vscode.rs`：接入同一 app/domain。
- `src/workbench-*.ts`、`webview/`：IPC 客户端、VS Code 集成与界面。

提交语义和生命周期约束见[架构说明](docs/workbench-architecture.md)，功能说明见[文档索引](docs/README.md)。变更记录进入 CHANGELOG，测试日志放 `.test-results/`。

## 本地验证

首次安装或依赖变更后运行 `npm ci`。日常开发按变更选择检查：

- TypeScript：`npm run check` 和相关 Vitest 用例。
- Rust：`npm run clippy` 和相关 Cargo 测试。
- 界面：`npm run test:browser`。
- 架构边界：`npm run audit:workbench`。
- 提交前检查格式：`npm run format:check`。

需要完整回归时运行 `npm run test:full`；发布候选运行 `npm run test:rewrite`，它包含完整回归及额外的故障、构建和制品检查，无需先逐项重复运行。各测试入口保留独立运行能力。

架构审计检查运行时和类型导入关系，并扫描动态 JSON 边界。新增或拆分协议转换文件时，使用 `//! Raw JSON boundary: 原因` 明确标注；审计只接受 ACP 层的该标注，业务层仍禁止动态 JSON。

默认集成测试使用模拟 provider/Bot，不代表真实服务通过。真实 Pi SDK 离线测试使用 `test:native-fork:offline`，显式指定 SDK 路径。测试隔离要求见[测试说明](test/fixtures/README.md)。

## 变更约束

- 保留用户现有工作；未经授权不重写其提交历史，不提交、部署或操作真实存储。
- 测试使用隔离的 HOME/storage 和假凭据；真实集成环境须显式启用，不记录敏感信息。
- 不隐式迁移或清空真实数据。GC 需验证引用、去重和恢复边界，不能仅凭时间戳、字符串匹配或缺少锁文件删除数据。
- 遵守架构说明中的提交、取消、进程回收、原生会话身份及文件访问约束。
- 更新本次变更影响的 schema、contracts 和文档，运行相应测试并记录实际结果；涉及生命周期或外部副作用时覆盖故障路径。
