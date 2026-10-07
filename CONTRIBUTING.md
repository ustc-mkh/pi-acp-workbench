# 参与开发

欢迎修复 bug、改进交互、补充模型兼容性测试和文档。扩展与 Webview 以 TypeScript 编写，使用标准 ACP v1 stdio；两个生产常驻服务（会话服务、Telegram 接入）使用 `rust/` 下的 Rust 实现。渲染组件与 VS Code 扩展宿主分开构建。

## 准备开发环境

- Node.js 22+、npm、Git；VS Code 1.96+。
- 构建服务和运行完整测试需要 Rust 工具链（cargo）；只构建 VSIX 不需要 Rust。
- 浏览器冒烟测试需要本地 Chrome / Chromium。
- 单元与协议测试不需要 Pi、模型账户或 API key。真实模型调试才需要安装、配置 Pi。

```bash
git clone https://github.com/ustc-mkh/pi-acp-workbench.git
cd pi-acp-workbench
npm ci
npm test             # 类型检查 + 与未提交改动相关的测试
npm run build        # 启动调试前构建
```

用 VS Code 打开仓库根目录，按 F5 选择 **Run Pi ACP Extension**。启动配置会先构建，再打开 Extension Development Host；在新窗口打开并信任一个测试项目，点击 π。首次使用点击“新建会话”；已有历史时恢复上次活动会话。

修改 TypeScript 或 Webview 后重新 `npm run build`，再重启调试窗口以加载最新产物。本仓库没有自动 watch / 热更新。`dist/` 为 VSIX 构建结果；`npm run build:services` 另生成含 Rust 二进制和 JS 适配器的 `service-dist/`，两者都不应手工编辑或提交。

## 格式化

`npm run format` 使用 Prettier 格式化 TS/JS、CSS、JSON、YAML 与 Markdown，并用 `cargo fmt` 格式化 Rust。`npm run format:check` 只检查，CI 会强制执行。Rust 工具链须包含 rustfmt（rustup 用户运行 `rustup component add rustfmt`；系统工具链安装对应 rustfmt 包）。配置见 `.prettierrc.json`、`.prettierignore` 和 `.editorconfig`。

构建产物、依赖、锁文件、生成许可证通知以及字节级 golden fixtures 不参与格式化；不要为了通过检查重写 `test/fixtures/` 的协议数据。

## 不连接真实模型的调试方式

仓库提供模拟 ACP 进程 `test/mock-agent.mjs`。输入 `wait` 模拟长时间运行，`permission` 模拟授权，`crash` 模拟进程退出；`context-images` 模式声明图片能力，`context-legacy` 使用旧版 modes 思考选项。两种接入方式：

- Codex / Claude：在 Development Host 的用户设置中把 `piAcp.codex.command`（或 `claude`）指向 Node 可执行文件，对应 `.args` 设为 `["/absolute/path/to/test/mock-agent.mjs", "<mode>"]`。
- Pi：临时修改会话服务 `sessions.json` 的 `command` / `args` 为同样的 Node + 脚本路径，重启 `pi-sessions`。

点击新建后可验证模型/thinking 切换和流式输出。模拟 Agent 不保存真实原生上下文，不能代替 Pi 持久化或供应商兼容性测试。

只验证渲染可执行 `Pi: Preview Markdown & Math`。日志通过 `Pi: Show Agent Logs` 查看；不要把包含私人代码或凭据的日志提交到 issue。

## 从哪里开始

- [架构与会话生命周期](docs/architecture.md)：数据流、状态、缓存、存储、协议边界与 Rust 生产服务。
- [测试与发布](docs/testing.md)：测试分层、复现用例、VSIX 构建和发布检查。
- [README](README.md)：用户可见行为、安装、配置及当前限制。
- [CHANGELOG](CHANGELOG.md)：已发布变更。

典型修改路径：

| 需求                      | 主要入口                                                                  | 对应验证                             |
| ------------------------- | ------------------------------------------------------------------------- | ------------------------------------ |
| 会话创建、重连、切换      | `src/extension.ts`                                                        | `test/controller.test.ts`            |
| 模型与思考选项            | `src/session-settings.ts`、`webview/selectors.ts`                         | selectors / controller 测试          |
| ACP 传输与进程管理        | `src/agent.ts`                                                            | agent 测试、NDJSON mock              |
| Markdown / 数学 / Mermaid | `webview/markdown.ts`、`webview/diagrams.ts`                              | markdown / diagrams 测试、浏览器冒烟 |
| 原生会话分支              | `src/native-branch.ts`、`src/pi-native-fork.ts`、`src/pi-enhancements.ts` | native-branch / bundled-adapter 测试 |
| 消费统计与价格            | telemetry / prices、Webview statistics 模块                               | telemetry / statistics / prices 测试 |

## Rust 单实现迁移

生产 TS daemon 入口已删除，不要重新增加 TS 服务构建或隐式回退。服务修改应首先补 Rust 单测或黑盒契约；`npm run test:integration:rust` 使用两个真实 Rust daemon 与模拟 Bot API/ACP worker。旧 TS 内部故障测试暂留，在覆盖迁移后逐项删除，清单见 [迁移进度](docs/rust-migration.md)。

## 提交与评审

1. 从当前 main 建立聚焦主题的分支；先描述可复现的问题或期望行为。
2. 保持 `src/shared.ts` 中宿主和 Webview 消息类型一致。在宿主再次验证消息、会话 ID 和附件；不要把 Webview 当可信授权源。
3. 为生命周期、协议、上下文和数据持久化变更添加行为回归测试。UI 变更检查窄侧栏、暗色/浅色主题、键盘操作和流式输出。
4. 日常执行 `npm test`；提交前执行 `npm run verify`，一次完成完整测试、构建和浏览器验证。只需完整非浏览器测试时用 `npm run test:all`。默认 `npm test` 在干净工作区不会运行完整回归。
5. 更新 README/架构说明及 CHANGELOG。不要提交密钥、Pi 会话文件、node_modules、dist 或本地 VSIX。
6. PR 写明问题、改变后的行为、验证命令和限制；UI 变更附截图。避免将无关格式化或依赖升级混在同一修复中。

关键约束：不要把“连接”改回隐式新建；不要重放历史工具调用；不要在上下文失败时静默截断；不要使用 CDN 或放宽 Webview 脚本策略来绕过渲染问题。扩展不提供 Pi 工具沙箱，协议授权只在 Agent 请求时生效。

## 依赖与许可证

使用 `npm ci` 保持 lockfile 可复现。更改依赖时提交 package.json 和 package-lock.json。内置适配器固定 pi-acp 版本，升级前阅读 `scripts/build-adapter.mjs` 的源码替换断言并运行 bundled-adapter 测试；不能只更新版本号。

构建生成 `THIRD_PARTY_NOTICES.txt` 并收集实际随包分发的许可证。发布前检查该文件的变更。项目采用 MIT 许可证，贡献内容应允许按项目许可证分发。
