# 测试与发布

从仓库根目录执行。日常只需一个命令；所有自动单元、模拟协议与浏览器测试都不调用付费模型。

## 两个主要入口

| 场景          | 命令             | 执行内容                                        |
| ------------- | ---------------- | ----------------------------------------------- |
| 日常修改      | `npm test`       | 类型检查 + 受未提交改动影响的测试               |
| 提交 / 发布前 | `npm run verify` | 类型检查 + 全部自动测试 + 构建 + 真实浏览器冒烟 |

`npm test` 包含已暂存、未暂存及未跟踪文件，通过 Vitest 的依赖图选择测试。工作区没有相关改动时仅类型检查，不代表执行过完整回归。包配置、锁文件、构建脚本、模拟进程和原生适配器代码变更会自动触发全部测试，因为子进程加载不在普通导入图中。CSS / 布局变更应执行 `verify`。

只需要完整单元和模拟协议测试（不需要浏览器）时，用 `npm run test:all`。已有提交、干净检出或 CI 应使用 `test:all` / `verify`，不要依赖默认的改动筛选。

调试单个问题仍可直接指定：

```bash
npx vitest run test/controller.test.ts -t 'native branch'
```

## 浏览器与打包

`verify` 已包含构建和浏览器验证，无需再依次手动执行 check、test、build、test:browser。单独验证 UI 可运行 `npm run test:browser`。

浏览器依次使用 `CHROME_PATH`、系统 `/usr/bin/google-chrome`、Playwright 安装的 Chromium。未安装时执行一次 `npx playwright install chromium`，或指定已有浏览器：

```bash
CHROME_PATH=/absolute/path/to/chromium npm run test:browser
```

截图统一放在已忽略的 `test-results/browser/`。测试需要允许本地端口和子进程；包含 ESM 分块、Mermaid 按需加载和等价本地资源 CSP 下的渲染检查，但不等价于真实 VS Code Webview 的宿主集成验证。

验证后用 `npm run package` 打包。VSCE 的 prepublish 钩子执行一次类型检查与构建，输出父目录 `pi-acp-workbench-<version>.vsix`，不再重复构建。打包本身不运行完整测试。构建同时生成增强适配器、渲染资源与第三方许可证声明。

## 保留的关键自动覆盖

- 会话生命周期：显式新建、严格恢复（失败不替换 ID）、Harness 隔离、账户级偏好继承与暖缓存。
- 历史/统计协调：初始化期间关闭历史不复活列表，删除等待在途写入，用量请求合并、分页与归属，忽略旧会话迟到结果。
- 固定偏好文件：跨工作区/实例与服务重启，按 harness 隔离、整组原子写入，损坏文件保留；新建读取磁盘最新组合，恢复旧会话不覆盖，实际使用会更新，拒绝的设置不保存。
- 数据完整性：共享租约、版本冲突、删除防复活、关闭本机保存时保护共享记录。
- 原生分支：节点与工具边界、历史设置、继承用量排除、取消和断连恢复。
- 故障恢复：本地控制 UTF-8 分包、发送后断线禁止重放、通知收据落盘失败仍可重试、损坏 outbox 隔离。
- 协议与渲染：ACP 流式/权限/取消、图片限制、Markdown / 数学 / SVG 净化。
- 状态同步：消息对象替换、旧图片与统计不重复序列化、增量更新和丢包重同步。
- 每轮 Diff：轮前脏文件不重复归因、重复编辑合并、增删/权限变化、子目录与符号链接边界、体积限制；服务正常/取消/崩溃和 Codex/Claude 本地执行都保存末尾汇总。渲染测试验证总 Diff 不进入折叠过程、补丁只作为文本渲染，浏览器验证展开和编辑器消息。
- Telegram：群组 / 用户 / 话题隔离、游标防重放、增量消息与完成通知、远程授权、共享租约及并发停止；使用模拟 API 和 ACP，不需要 Bot token，也不向真实群组发消息。内置适配器索引覆盖多个真实子进程同时写入。

旧版历史迁移、文本上下文重建和摘要工作进程已删除，其专用测试也随功能移除；不保留只验证废弃实现的测试。当前原生分支、持久化和控制边界继续覆盖。

这些行为已由自动测试覆盖，不要求每次修改再手动遍历一份重复清单。新测试优先补现有文件中缺失的行为；不为同一行为重复增加单元、宿主与浏览器断言。浏览器只验证真实布局、交互及 DOM 环境无法代替的链路。

## 按需运行的外部集成验证

以下不放入日常或 `verify`，只在对应集成发生变化时运行：

- `npm run test:native-fork`：要求安装支持 `ctx.fork(...,{position:'at'})` 的 Pi，可用 `PI_ACP_PI_COMMAND` 指定路径。在临时目录验证原生图片/压缩前缀、历史设置、源文件不变、ACP fork/load 和继承用量，不提交模型请求；会读取已有 Pi 配置。
- `npm run test:harness`：要求安装 Codex / Claude ACP 适配器并准备凭据。通过 `CODEX_ACP_COMMAND` / `CLAUDE_ACP_COMMAND` 指定命令，`CODEX_ACP_ARGS` / `CLAUDE_ACP_ARGS` 传 JSON 参数数组。新建并恢复临时空会话，不调用 `session/prompt`，可能留下原生空会话元数据。
- 下方 Extension Host 测试：仅在 VS Code API、编辑器上下文或激活逻辑变化时需要。

上述验证都不代表真实付费模型、所有供应商或 Windows / Remote SSH 已验证。

## Extension Host 测试

先构建，然后用独立用户目录及临时测试工作区启动 VS Code。下面命令适用于 Bash；将 code 替换为可用的 VS Code CLI。测试会改动独立 profile 设置并在临时工作区写 context.ts，不要对真实项目执行此测试。

```bash
npm run build
PI_TEST_ROOT="$(mktemp -d)"
mkdir -p "$PI_TEST_ROOT/workspace" "$PI_TEST_ROOT/profile" "$PI_TEST_ROOT/extensions"
PI_HOST_TEST_RESULT="$PI_TEST_ROOT/result.json" code \
  --user-data-dir "$PI_TEST_ROOT/profile" \
  --extensions-dir "$PI_TEST_ROOT/extensions" \
  --extensionDevelopmentPath="$PWD" \
  --extensionTestsPath="$PWD/test/host.cjs" \
  --disable-workspace-trust --skip-welcome \
  "$PI_TEST_ROOT/workspace"
cat "$PI_TEST_ROOT/result.json"
```

需要桌面显示环境（Linux CI 通常使用虚拟显示器）。此测试故意设置工作区信任，以便启动 mock Agent。结果文件中的 passed=true 才表示执行完成；VS Code 启动成功不代表测试通过。

## 发布

1. 执行 `npm run verify`；涉及 VS Code API 时再执行 Extension Host 验证。
2. 更新 package.json.version、package-lock.json 中根版本、src/agent.ts 的 clientInfo.version、package 脚本的 VSIX 文件名；同步 README 安装示例和 CHANGELOG。
3. `npm run package`，检查 VSIX 内容包含 dist/pi-adapter.mjs、Webview/KaTeX 字体、许可证及 README；不包含密钥、测试历史和 node_modules。
4. 在干净测试 profile 通过 Install from VSIX 安装，检查欢迎/恢复、模型继承、数学、Mermaid、图片与统计基本行为。记录未覆盖的平台。
5. 提交源码，创建与 package 一致的 vX.Y.Z 标签，推送仓库；创建同名 GitHub Release，附上 VSIX、变更说明及 SHA-256。源码由标签关联。
6. 从 Release 下载 VSIX 并核对摘要，确认发布附件可用。不要用 Marketplace 发布命令代替 GitHub Release 附件上传。

示例摘要命令：`sha256sum ../pi-acp-workbench-0.8.2.vsix`。发布需要相应 GitHub 权限；普通贡献者提交 PR 即可，无须发布权限。

## 独立会话服务回归

`test/rust-sessions.test.ts` 直接启动真实 Rust 会话服务与 ACP mock，覆盖桌面断开后手机继续、并发去重、进程上限/回收、授权、真实文件系统存储失败不执行/不重放、重启收据恢复、原生分支和三种终态的 Diff/outbox。`session-preferences.test.ts` 的服务用例也连接真实 Rust，验证跨目录/重启/恢复偏好。已移除 TS 会话服务与其队列/收据单测，对应边界由 Rust queue/journal 测试验证，包括落盘成功后、执行前取消的确定性注入（仅 cfg(test)，不存在于服务二进制）。控制器真实 RemoteAgent 用例继续验证桌面订阅与手机任务。覆盖迁移依据见 [rust-migration.md](archive/rust-migration.md)，生产验收证据见 [Rust 验收记录](rust-acceptance.md)。

发布前执行 `npm run verify`，并执行 `npm run test:native-fork` 验证安装的 Pi 原生树接口；均不发送真实模型任务。

## 会话服务 Contract 测试

`npm run test:contract` 运行 `scripts/service-contract.mjs`：只通过 Unix socket 驱动 daemon 的黑盒协议验证（自带最小 wire 客户端，不 import 服务实现），覆盖方法/参数校验、违规连接隔离、大帧上限、会话编号、事件订阅与上限、授权流转、取消、同 ID 幂等、>512 KiB 分块响应、磁盘产物格式与损坏拒启动、重启中断防重放、数据目录单例锁与删除语义。`test/fixtures/` 存放 native-branch 哈希 fixtures（`scripts/export-fixtures.mjs` 生成）与磁盘格式 golden 样例，供替代实现逐比特断言。规范见 [service-protocol.md](service-protocol.md) 与 [data-formats.md](data-formats.md)；默认先构建并测试 Rust daemon；`PI_CONTRACT_DAEMON=/path/to/daemon` 可指定其他 Rust 构建产物。

`npm run test:contract:telegram` 运行 `scripts/telegram-contract.mjs`：模拟 Bot API HTTP + 模拟 session socket server 的 25 项黑盒测试（含 restrictToWorkspaces 符号链接越界拒绝）（启动/offset 检查点、陌生用户/群忽略、/new 话题绑定、prompt→outbox 投递、权限按钮、/stop、/notifications、/status、单例锁）；只测试 Rust；`PI_TG_DAEMON` 可指定另一个 Rust 测试构建产物（需支持隔离的模拟传输）。

Rust 侧单测：`cd rust && cargo test`（pi-acp-core 的 canonical UTF-16 键序对拍、wire 孤立代理分块重组；pi-acp-session-daemon 的 native-branch fixtures 9 例逐字节哈希、journal/queue/diff 等单测）。

## 真实 Rust 双服务集成

`npm run test:integration:rust` 同时启动真实 Rust 会话服务和 Rust relay，仅 Bot HTTP 与 ACP worker 使用 mock，不调用 Telegram 或付费模型。覆盖 `/new` 绑定、手机 prompt 与桌面订阅、授权回调、取消，以及 relay 重启后离线桌面 outbox 的单次投递和绑定/游标保持。持续负载与历史回滚的复现入口见 [服务发布说明](service-release.md)，实际执行结果见 [验收记录](rust-acceptance.md)。

Rust 服务仅支持 Linux x86_64，构建、测试与发布均使用该平台的本机产物。

Telegram 黑盒契约目前 25 项，覆盖真实 Rust relay 的游标磁盘失败、重复 update ID、投递与 history 重试、100 条 history 分批、通知/实时静音、权限隔离、Unicode/429、webhook 和重启。Rust bridge 单测补事务回滚/并发保存、弃置预览/票据；outbox 单测补慢盘最新状态合并和最后落盘失败。另补 100 次增量合并、话题缓存/确认/开关写失败调用路径及过期票据实际响应，完整覆盖映射见迁移文档；旧 `telegram.test.ts` 及 TS relay 内部模块已删除。真实 Rust socket 用例验证最后 outbox 写失败传播和 interrupted 收据，不自动重放。

Rust 会话服务通过 `events.next` 提供逐条 outbox 消费，每次读取有硬大小限制；惰性读取、损坏/身份不匹配、过期删除、超大文件跳过和陈旧版本确认均有单测。客户端回归覆盖 socket 消费、服务重启与重复确认；relay 契约覆盖确认失败后重试而不重复发送。双 Rust 服务集成使用不同数据目录，通过 `serviceSocket` 连接。worker 回调与持锁操作的 panic 回归验证故障隔离、已提交历史恢复及后续任务执行。ChatProvider 拆分后继续由控制器回归和浏览器冒烟覆盖会话选择、轮次及附件行为。

## 有界并行完整验收

`npm run test:full` 先构建一次 debug/contract 产物，再并行执行 TS、Rust 单测、两种契约、双服务集成、内存与 runner 测试。默认最多 3 个套件，可设 `TEST_JOBS=1` 顺序复现，或 2–8 调整；Vitest 最多 4 个 worker，避免套件并行叠加无限制内部并行。所有套件独立进程/数据目录/端口，Telegram 契约中依赖前序状态的用例不并行。

每次日志写 `.test-results/run-*/`，失败不跳过其余套件，最终退出码非零。本机不要并发运行 `test:browser` 和 `build:services` 两个 npm 包装命令：它们都重建 `dist/`。可先 `npm run build`，再并行运行 `node scripts/browser-smoke.mjs` 与 `node scripts/build-services.mjs`；CI 分 job 则工作目录天然隔离。CI 的浏览器/生产构建分别并行 job，服务 job 用 TEST_JOBS=2，失败上传日志。默认 `test:all` 仍为完整 TS 回归，不等于所有语言/契约验收。

## Rust 内存与资源增长检查

`npm run test:memory` 预置 1024 份约 64 MiB 的任务收据，启动真实 Rust 服务，执行 1200 次重复请求查询和 150 次 socket 连接/关闭，从 Linux `/proc` 采集服务 RSS、文件描述符与 worker 数量。断开后 FD 回到基线；收据复用和只读状态不启动 worker，后续批次 RSS 不持续增长。不需要真实 Pi、Bot token 或模型请求，CI 会执行。

Rust stream 单测独立验证 32 个预览处理共 128 MiB 源文本后只保留小容量自有缓冲，并验证 Unicode 和预先过量分配的小字符串。检查不等价于数周生产浸泡或第三方 Pi/模型 SDK 的全部内存行为。

`workspace-diff.test.ts` 使用临时 Git 仓库验证只读采集，不修改真实项目的 index/工作树；`messages.test.ts` 与浏览器冒烟覆盖末尾汇总渲染。

`long-running.test.ts` 通过真实 Rust 服务覆盖超过 16 MiB 的 Unicode 历史分块传输与订阅隔离；原两个 relay/outbox 参考用例已经迁移到 Rust outbox/API/stream 单测并删除。Rust server 单测验证超大响应隔离、32 连接/128 请求上限及字节/队列回收。`session-client.test.ts` 的 transport-only mock 只验证 TS 客户端超时不重放、晚到结果忽略、序列化/待处理上限与断线分块清理，不实现另一套会话服务。`atomic-json.test.ts` 验证 fsync/rename 顺序和同步失败时不发布文件；服务集成测试验证收据失败不启动 worker、创建/分支去重以及 ID 异内容冲突。这些测试不等价于真实掉电实验。功能回归继续使用 `npm run verify`。

## 本轮补充覆盖

`native-fixtures.test.ts` 运行十个冻结原生分支样例。`rust-sessions.test.ts` 同时让 SharedHistoryStore 与真实 Rust daemon 写入/删除同一目录，断言唯一编号、无丢失更新、tombstone 不复活和活跃租约互斥；另验证长任务 context/terminal 推送与冷重启。控制器验证模型可见性按 harness 保存、本地 context 重启恢复，以及发送前取消不触发 Pi 请求、远端 entry ID 不被本地替换。

`bundled-adapter.test.ts` 使用模拟 Pi RPC 验证长 prompt 期间 usage 更新、手动 /compact 成功与具体失败原因及恢复。Telegram 契约检查实际 Bot API entities（emoji 偏移、代码、链接、附件提示），Rust 单测覆盖长代码分块与不完整流式 Markdown。浏览器新增模型管理、Fast 控件、Diff 折叠说明和终端滚动断言。

Rust 协议生成使用 `npm run generate:protocol`，完整套件内有 `check:protocol` 漂移校验。CI 同时运行 Clippy，不能通过新增 dead_code 抑制来绕过检查。
