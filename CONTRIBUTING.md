# 参与开发

欢迎修复 bug、改进交互、补充模型兼容性测试和文档。扩展与 Webview 以 TypeScript 编写，使用标准 ACP v1 stdio；两个生产常驻服务（会话服务、Telegram 接入）使用 `rust/` 下的 Rust 实现。渲染组件与 VS Code 扩展宿主分开构建。

## 准备开发环境

- Node.js 22+、npm、Git；VS Code 1.96+。
- 构建服务和运行完整测试需要 Rust 工具链（cargo）；只构建 VSIX 不需要 Rust。
- 使用 rust-analyzer 编辑 Rust 时，还需要与编译器匹配的标准库源码 `rust-src`：rustup 用户运行 `rustup component add rust-src`；Fedora 系统工具链用户运行 `sudo dnf install rust-src`。安装后执行 VS Code 的 **rust-analyzer: Restart server**。缺失源码可能导致 `!bool` 等合法表达式出现分析误报，即使 `cargo check` 通过。仓库的 VS Code 配置已将 Rust 工作区指向 `rust/Cargo.toml`。
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

`npm run format` 使用 Prettier 格式化 TS/JS、CSS、JSON、YAML 与 Markdown，并用 `cargo fmt` 格式化 Rust。`npm run format:check` 只检查，CI 会强制执行。Rust 工具链须包含 rustfmt 和 clippy（rustup 用户运行 `rustup component add rustfmt clippy`；Fedora 系统工具链运行 `sudo dnf install rustfmt clippy`）。`npm run verify` 会执行 clippy，并将 warning 视为失败。配置见 `.prettierrc.json`、`.prettierignore` 和 `.editorconfig`。

构建产物、依赖、锁文件、生成许可证通知以及字节级 golden fixtures 不参与格式化；不要为了通过检查重写 `test/fixtures/` 的协议数据。

## 不连接真实模型的调试方式

仓库提供模拟 ACP 进程 `test/mock-agent.mjs`。输入 `wait` 模拟长时间运行，`permission` 模拟授权，`crash` 模拟进程退出；`context-images` 模式声明图片能力，`context-legacy` 使用旧版 modes 思考选项。两种接入方式：

- Codex / Claude：在 `sessions.json` 的 `harnesses.codex` / `harnesses.claude` 中将 `command` 设为 Node 可执行文件，`args` 设为 `["/absolute/path/to/test/mock-agent.mjs", "<mode>"]`，重启 `pi-sessions`。
- Pi：临时修改会话服务 `sessions.json` 的 `command` / `args` 为同样的 Node + 脚本路径，重启 `pi-sessions`。

点击新建后可验证模型/thinking 切换和流式输出。模拟 Agent 不保存真实原生上下文，不能代替 Pi 持久化或供应商兼容性测试。

只验证渲染可执行 `Pi: Preview Markdown & Math`。日志通过 `Pi: Show Agent Logs` 查看；不要把包含私人代码或凭据的日志提交到 issue。

## 从哪里开始

完整导航见 [文档索引](docs/README.md)。

- [架构与会话生命周期](docs/architecture.md)：数据流、状态、缓存、存储、协议边界与 Rust 生产服务。
- [测试与发布](docs/testing.md)：测试分层、复现用例、VSIX 构建和发布检查。
- [README](README.md)：用户可见行为、安装、配置及当前限制。
- [CHANGELOG](CHANGELOG.md)：已发布变更。

典型修改路径：

| 需求                      | 主要入口                                                                  | 对应验证                             |
| ------------------------- | ------------------------------------------------------------------------- | ------------------------------------ |
| 会话创建、重连、切换      | `src/extension.ts`                                                        | `test/controller.test.ts`            |
| 模型与思考选项            | `rust/crates/pi-acp-session-daemon/src/prefs.rs`、`webview/selectors.ts`  | selectors / controller 测试          |
| ACP 传输与进程管理        | `rust/crates/pi-acp-session-daemon/src/agent.rs`                          | agent 测试、NDJSON mock              |
| Markdown / 数学 / Mermaid | `webview/markdown.ts`、`webview/diagrams.ts`                              | markdown / diagrams 测试、浏览器冒烟 |
| 原生会话分支              | `src/native-branch.ts`、`src/pi-native-fork.ts`、`src/pi-enhancements.ts` | native-branch / bundled-adapter 测试 |
| 消费统计与价格            | telemetry / prices、Webview statistics 模块                               | telemetry / statistics / prices 测试 |

## Rust 服务维护

生产 TS daemon 入口已删除，不要重新增加 TS 服务构建或隐式回退。完整服务验收使用 `npm run test:full`；`TEST_JOBS=1` 顺序排障，默认有界并行，日志在 `.test-results/`。服务修改应首先补 Rust 单测或黑盒契约；`npm run test:integration:rust` 使用两个真实 Rust daemon 与模拟 Bot API/ACP worker。TS 会话服务、队列/收据/socket 服务端及 Telegram 内部实现已删除；现有覆盖与运行入口见 [测试指南](docs/testing.md)。

Telegram 修改按 `bridge/` 职责定位：接收与恢复走 `inbox.rs`，命令走 `commands.rs`，同步走 `history.rs`，投递走 `delivery.rs`，授权走 `permissions.rs`。持久化字段放在 `state.rs`，所有修改通过 `StateStore::update`；不要重新暴露可写的共享状态锁。命令分类/排队规则集中在 `routing.rs`，可用纯单测验证。新增后台消息处理任务应交给 `TaskScope`，轮次内监听应由 `OwnedTask` 持有。

## 提交与评审

1. 从当前 main 建立聚焦主题的分支；先描述可复现的问题或期望行为。
2. 保持 `src/shared.ts` 中宿主和 Webview 消息类型一致。在宿主再次验证消息、会话 ID 和附件；不要把 Webview 当可信授权源。
3. 为生命周期、协议、上下文和数据持久化变更添加行为回归测试。UI 变更检查窄侧栏、暗色/浅色主题、键盘操作和流式输出。
4. 日常执行 `npm test`；提交前执行 `npm run verify`，一次完成 clippy、完整服务验收、构建和浏览器验证。只需完整非浏览器验收时用 `npm run test:full`。默认 `npm test` 在干净工作区不会运行完整回归。
5. 更新 README/架构说明及 CHANGELOG。不要提交密钥、Pi 会话文件、node_modules、dist 或本地 VSIX。
6. PR 写明问题、改变后的行为、验证命令和限制；UI 变更附截图。避免将无关格式化或依赖升级混在同一修复中。

关键约束：不要把“连接”改回隐式新建；不要重放历史工具调用；不要在上下文失败时静默截断；不要使用 CDN 或放宽 Webview 脚本策略来绕过渲染问题。扩展不提供 Pi 工具沙箱，协议授权只在 Agent 请求时生效。

## 依赖与许可证

使用 `npm ci` 保持 lockfile 可复现。更改依赖时提交 package.json 和 package-lock.json。内置适配器固定 pi-acp 版本，升级前阅读 `scripts/build-adapter.mjs` 的源码替换断言并运行 bundled-adapter 测试；不能只更新版本号。

构建按固定顺序生成 `THIRD_PARTY_NOTICES.txt` 并收集实际随包分发的许可证；统一换行且内容变化时才写入，避免目录遍历顺序造成无意义 diff。发布前检查该文件的变更。项目采用 MIT 许可证，贡献内容应允许按项目许可证分发。

Rust 依赖漏洞检查：安装 `cargo install cargo-audit --locked --version 0.22.2` 后执行 `cargo audit --file rust/Cargo.lock`。CI 使用固定 SHA 的 taiki-e/install-action 下载同版本预编译工具（禁止源码安装回退），再审计锁文件，发现漏洞时失败，不默认忽略通告。

## 升级内置 pi-acp

当前固定为 `pi-acp@0.0.34`，`scripts/build-adapter.mjs` 通过严格断言扩展上游 bundle。升级时：

1. 阅读上游 release / 源码变化，更新 package.json 的精确版本与 package-lock.json；不要使用浮动版本。
2. 对照旧、新 `node_modules/pi-acp/dist/index.js`，逐项审查 `replaceExactlyOnce` 和 `assertRequestErrorBinding`：Agent/RPC 构造、原生分支隔离、注册表锁、错误传播、超时、取消及上下文统计都必须保持原有语义。对应最小 RPC 契约在 `src/pi-rpc-types.ts`。
3. 运行 `npm run build`。替换目标缺失、重复或 RequestError 绑定变化必须使构建失败；确认新的上游语义后才能调整断言，不能改成宽松替换或吞掉错误。
4. 运行 `npx vitest run test/build-adapter.test.ts test/bundled-adapter.test.ts test/native-branch.test.ts test/native-fixtures.test.ts test/usage-cache.test.ts`，验证真实 bundle、错误/取消、注册表并发、原生分支哈希和用量分页。只有有意修改数据格式时才执行 `npm run fixtures`，并检查 TS 冻结输出、Rust 切点绑定及磁盘 / wire 契约的一致性；不要用重生成 fixture 来掩盖兼容性失败。
5. 运行 `npm run verify`、`npm audit --omit=dev` 和 Rust audit；检查许可证通知、更新 CHANGELOG，并在 PR 中列出每个变更的补丁入口和行为验证。

优先向上游提出正式扩展点（Agent 子类工厂、RPC 进程参数、持久化 store 与上下文/取消回调）。扩展点可覆盖行为且测试通过后，再逐项删除本地字符串补丁。

CI Actions 固定到官方仓库的 commit SHA；更新时核对 release/tag 对应 SHA，并保持版本注释。JS 依赖与 dist 在 javascript job 准备一次，通过同次 workflow 的 tar artifact 共享给三个 Linux x64 job，保留可执行权限；Rust 测试与 musl 生产构建分别缓存。

维护者发布时先更新版本与 CHANGELOG，推送提交并确认 CI 通过，再推送同版本标签。标签 CI 自动生成并验证 VSIX / musl 附件，下载复核后发布 GitHub Release；详见 [发布步骤](docs/testing.md#发布步骤)。不要把本地历史 service-dist 当作新版本附件。

## 本地缓存与测试日志

`test:full` 默认只保留最近 5 次 `.test-results/run-*`，可用 `TEST_KEEP_RUNS=10 npm run test:full` 调整。运行中的目录带 `.active` PID 标记，不会被清理；进程已退出的标记可在下次运行时回收。其他文件与目录链接不参与清理。

需要回收 Rust 构建磁盘时，先停止正在使用这些 target 的构建/测试，再按需执行：

```bash
cargo clean --manifest-path rust/Cargo.toml
cargo clean --manifest-path rust/Cargo.toml --target-dir rust/target/contract
cargo clean --manifest-path rust/Cargo.toml --target-dir rust/target/portable
```

第一条清理整个 rust/target，包含 contract、portable 和 rust-analyzer 的 flycheck0；后两条用于只清理独立测试或 musl 缓存。flycheck0 可能没有 Cargo 的 CACHEDIR.TAG，较新 Cargo 会拒绝把它单独当作 target 清理，应通过父 target 清理。清理后下次构建会重新编译，不要删除 ~/.cargo 的下载缓存或正在使用的 service-dist。

Tokio 显式声明各 crate 用到的 feature，不使用 `full`。重复依赖用 `cargo tree --manifest-path rust/Cargo.toml -d` 定位：base64、getrandom、syn 的不同主版本来自上游约束，应随兼容的上游升级消除，不强行 override 或只编辑锁文件。

已完成的迁移计划从当前文档移除，历史选型可通过 Git 历史查看；生产职责、兼容边界及验收分别维护在架构、协议和测试文档。构建脚本入口与注入引用（adapter-store、pi-native-fork、webview/main、pi-acp、proper-lockfile）不属于未使用代码。
