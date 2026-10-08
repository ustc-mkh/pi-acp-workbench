# 测试与发布

从仓库根目录执行。自动回归使用真实 Rust daemon 与模拟 ACP / Bot API，不调用付费模型，也不向真实 Telegram 群组发消息。完整检查需要 Linux x86_64、Node.js 22+、Rust/Cargo、rustfmt、clippy，以及可用的 Chromium；测试环境须允许本地 Unix socket、HTTP 监听和子进程。

## 测试入口

| 场景             | 命令                                                     | 执行范围                                                                        |
| ---------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 日常修改         | `npm test`                                               | 类型检查、构建 debug 服务、按未提交改动选择 TS 测试                             |
| 全量 TS 回归     | `npm run test:all`                                       | 类型检查、构建 debug 服务、全部 Vitest 测试                                     |
| 完整非浏览器验收 | `npm run test:full`                                      | 类型检查、debug / contract 构建、TS / Rust 单测、协议、集成、内存和 runner 检查 |
| 提交前完整验证   | `npm run verify`                                         | clippy → test:full → JS 构建与浏览器冒烟                                        |
| 格式检查         | `npm run format:check`                                   | Prettier 与 rustfmt                                                             |
| Rust lint        | `npm run clippy`                                         | workspace / all-targets，warning 作为失败                                       |
| Rust 单测        | `cargo test --manifest-path rust/Cargo.toml --workspace` | 三个 Rust crate 的单测                                                          |
| 会话契约         | `npm run test:contract`                                  | debug 构建与 session socket 黑盒协议                                            |
| Telegram 契约    | `npm run test:contract:telegram`                         | contract-test relay、模拟 Bot HTTP 与会话 socket                                |
| 双服务集成       | `npm run test:integration:rust`                          | 真实 session daemon / relay，模拟 ACP 与 Bot                                    |
| 内存 / 资源      | `npm run test:memory`                                    | 真正运行的 Rust 服务 RSS、FD、worker 回收                                       |
| runner 回归      | `npm run test:runner`                                    | 有界调度、日志保留与活动目录保护                                                |
| 浏览器冒烟       | `npm run test:browser`                                   | JS 构建与 Chromium 布局 / 交互检查                                              |
| 协议生成 / 校验  | `npm run generate:protocol` / `npm run check:protocol`   | Rust ts-rs 输出与客户端声明的漂移检查                                           |
| 原生分支样例导出 | `npm run fixtures`                                       | 有意改变算法时更新冻结样例                                                      |

`npm test` 通过 Vitest 的依赖图选择已暂存、未暂存和未跟踪改动影响的测试；干净工作区可能不运行测试。构建脚本、Rust、锁文件、模拟进程和注入适配器代码等由 forceRerunTriggers 触发完整 TS 回归。干净检出或发布验收使用 test:full / verify；test:all 不包含 Rust 单测、独立契约或浏览器。

单独定位 TS 用例时先构建服务：

```bash
npm run build:service:test
npx vitest run test/controller.test.ts -t 'concurrent'
```

## 自动覆盖与维护入口

| 领域                   | 主要覆盖                                                                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 生命周期与请求门控     | controller、conversation-coordinators、remote-agent；显式新建、恢复失败不换 ID、并发发送、历史初始化、取消 / 授权及门控失败后释放                                                       |
| 共享历史与偏好         | rust-sessions、shared-history、session-preferences、history；所有 harness 经 socket 读写、编号、revision、tombstone、损坏拒绝、跨目录及重启偏好                                         |
| 队列 / 收据 / 存储故障 | Rust queue / journal / history / outbox 单测与真实 daemon 回归；写失败不执行、去重、取消代际、中断不重放、终态 outbox 错误传播                                                          |
| 原生分支与增强适配器   | native-branch、native-fixtures、build-adapter、bundled-adapter、usage-cache；安全节点、前缀哈希、历史设置、继承用量、取消与并发 registry 写入                                           |
| 协议与资源限制         | service-contract、session-client、long-running 与 Rust server / wire；参数、订阅、Unicode 分块、半帧超时、连接满额、accept 退避、字节回收与锁中毒恢复                                   |
| 用量与状态同步         | telemetry、statistics、service-state-stream、state-channel 及 Rust usage；分页、缺失数据、上下文与计费分离、增量基线和迟到结果                                                          |
| Diff 与附件            | Rust diff、rust-sessions、images、image-paste、message-actions、messages；轮前脏文件、净变化、权限、子目录、符号链接、省略和三种终态                                                    |
| Telegram               | Rust bridge / api / stream / task_scope、telegram-contract、rust-integration；身份 / 目录限制、接收队列、持久游标、投递 / 确认重试、通知、实时静音、Markdown entities、授权、停止与重启 |
| 渲染与 UI              | markdown、diagrams、composer、selectors、models 与浏览器冒烟；净化、CSP、数学、Mermaid、窄侧栏、键盘、滚动、模型可见性与 Fast 控件                                                      |

故障注入只存在于 cfg(test) 或独立 contract-test 构建，不部署到生产。Rust 回归验证持锁 panic 后恢复已提交会话快照、终止对应 worker 并继续处理后续任务。TS 直接 ACP 客户端与 transport-only mock 只用于边界测试，不构成另一套生产服务。

Fixtures 的角色见 [样例说明](../test/fixtures/README.md)：原生树哈希由生产 TS 算法与冻结输出比较；Rust 绑定已经验证的切点，并测试 canonical 请求指纹、UTF-16 wire 和磁盘格式。不要通过重生成 fixture 掩盖兼容性失败。规范见 [Wire 协议](service-protocol.md) 与 [磁盘格式](data-formats.md)。

新增测试优先补现有文件中缺失的行为。浏览器验证真实布局和交互；进程 / 存储 / 协议边界用 Rust 单测、契约或服务集成验证。

## 有界并行与日志

test:full 先准备一次 debug 和 contract 产物，再有界并行运行独立套件。`TEST_JOBS` 支持 1–8，默认 min(3, availableParallelism)；Vitest 最多 4 个 worker。独立套件使用不同进程 / 临时目录 / 端口；依赖前序状态的 Telegram 契约内部保持顺序执行。一个套件失败后其余仍运行，最终退出码非零。

```bash
TEST_JOBS=1 npm run test:full
TEST_KEEP_RUNS=10 npm run test:full
npm run test:all -- --maxWorkers=4
```

单独运行 test:all 时可使用上述 worker 上限；核心很多的主机上默认并发可能使启动多个 daemon 的用例触发 5 秒超时。优先有界运行并定位慢步骤，不直接延长超时掩盖问题。

日志在 `.test-results/run-*/`，默认保留最近 5 次。活动运行的 `.active` PID 标记保护目录；失效标记可在后续运行回收，目录链接及其他目录不参与清理。长期验收证据请单独保存，避免引用已被清理的 run 目录。

不要并行运行两个重建 dist 的 npm 包装命令，例如 test:browser 与 build:services。可先 `npm run build`，再并行执行 `node scripts/browser-smoke.mjs` 和 `node scripts/build-services.mjs`。

## CI

[CI 配置](../.github/workflows/ci.yml) 使用固定 commit SHA 的 Actions：

- rust-audit 下载固定版本 cargo-audit，审计 Rust 锁文件，禁止源码安装回退。
- javascript 执行一次 npm ci、类型检查、JS 构建和生产 npm audit，通过 tar artifact 共享 node_modules / dist / 许可证，保留可执行权限。
- services、browser、production 依赖 javascript 后并行；services 使用 TEST_JOBS=2，执行格式、clippy 和 test:full，失败上传日志。
- Rust services 缓存 debug / contract，production 独立缓存 musl 构建；生产 job 运行产物 smoke、服务契约并归档包。

远端 CI 的运行状态以实际 workflow 结果为准；本地检查通过或配置完成不代表 workflow 已执行。

## 浏览器与 Extension Host

浏览器依次使用 CHROME_PATH、系统 `/usr/bin/google-chrome`、Playwright Chromium。首次安装运行 `npx playwright install chromium`；Linux CI 使用 `npx playwright install --with-deps chromium`。也可指定已有浏览器：

```bash
CHROME_PATH=/absolute/path/to/chromium npm run test:browser
```

截图位于 `test-results/browser/`。覆盖按需 ESM Mermaid、等价 CSP、数学、增量 / 重同步、暗亮主题、窄视口、发送 / 授权 / 取消等；不等价于实际 VS Code Webview 的宿主集成。

涉及 VS Code API、激活或编辑器上下文时，用仓库的 F5「Run Pi ACP Extension」启动独立 Extension Development Host，连接配置为 mock ACP worker 的会话 daemon，检查激活、预览、显式新建、选区附件、总 Diff 与链接打开。配置与 F5 步骤见 [贡献指南](../CONTRIBUTING.md)。

现有 `test/host.cjs` 仍使用已移除的插件 command / args 设置和宿主直启 ACP 路径，尚未适配 v3 socket 服务；不能将它作为当前自动验收入口。宿主检查采用上述实际调试路径，当前 verify 不包含它。

## 内存与长时间负载

test:memory 预置 1024 份约 64 MiB 收据，执行 1200 次重复查询和 150 次连接轮换，从 Linux /proc 观察 RSS、FD、worker。检查只读状态不启动 worker、重复查询不持续增长，断开后 FD 回到基线。

Rust stream 单测验证预览只保留小容量缓冲，Unicode 和过量容量字符串不保留整篇源文本。短检查不等价于数周运行或第三方 worker 的全部内存行为。

2 小时负载、历史回滚和生产包检查属于按需验收，入口见 [服务发布](service-release.md)，已执行范围见 [验收记录](rust-acceptance.md)。

## 按需外部集成

- `npm run test:native-fork`：需要安装 Pi，PI_ACP_PI_COMMAND 可指定路径；验证原生裁剪、图片 / 压缩前缀、历史设置、源文件不变、ACP fork/load 和继承计费，不提交模型任务。
- `npm run test:harness`：需要 Codex / Claude ACP 与既有凭据；CODEX_ACP_COMMAND / CLAUDE_ACP_COMMAND 及对应 \*\_ARGS 指定命令 / JSON 参数。新建并恢复临时空会话，不发送 session/prompt；可能留下原生会话元数据。

这些检查不纳入 verify，也不代表所有供应商、真实付费模型、真实 Telegram 或 Windows / Remote SSH 已验证。

## 发布步骤

1. 执行 verify、format:check；涉及上游适配器、宿主或服务包时执行对应按需检查。
2. 同步 package.json.version、package-lock.json 的根版本和 `rust/crates/pi-acp-session-daemon/src/agent.rs` 中 ACP clientInfo.version，更新 CHANGELOG；VSIX 文件名与服务 manifest 已从包版本生成。
3. 执行 `npm run package`。VSCE prepublish 会类型检查并构建，输出父目录 `pi-acp-workbench-<version>.vsix`；检查适配器、Webview / 字体、许可证和 README，排除 source map、测试、node_modules、服务二进制与私人配置。
4. 在独立 VS Code profile 安装 VSIX 验证；服务包同时按 [发布指南](service-release.md) 重新构建、检查和打包，插件与 v3 daemon 配套更新。
5. 先推送版本提交并确认 main 的 CI 通过，再创建与包版本一致的 vX.Y.Z 标签并推送。标签 CI 在审计、完整回归、浏览器和 musl 生产检查通过后打包 VSIX，核对版本、源码提交、包内容及内外摘要；先上传草稿 Release，下载所有附件复核 SHA-256，再正式发布并设为 latest。普通贡献者提交 PR 即可。

发布流程见 `.github/workflows/ci.yml` 的 release job 与 `scripts/prepare-release.mjs`。发布写权限只授予该 job；分支和 PR 不发布。若上传或下载校验失败，保留草稿供排查，不发布不完整附件；修复前不要复用或移动已发布标签。

使用实际版本替换摘要命令中的占位符：`sha256sum ../pi-acp-workbench-<version>.vsix`。打包本身不运行完整测试；已有历史候选包不能代替当前源码的发布验收。
