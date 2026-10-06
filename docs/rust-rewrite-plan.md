# Rust 重构计划（长程任务锚点文档）

> **如何使用本文档**：任何一次恢复重构工作时，先读本文件的「进度状态」与「决策记录」，再对照 `service-protocol.md` / `data-formats.md` 两份冻结规范。偏离已冻结不变量的改动必须先更新规范文档并获得确认。每完成一项就更新对应 checkbox 并记录验证结果。

## 0. 动机与目标

**目的不是修 bug**（现有 TS 实现已通过 241 项测试与 contract 套件）。收益仅为：

- 常驻进程内存：Node daemon ~60–100MB RSS → 预期 Rust ~5–15MB；
- 部署形态：单静态二进制，服务器不再依赖 Node/Electron（`ELECTRON_RUN_AS_NODE` 技巧随之淘汰）；
- 冷启动与 systemd 重启恢复更快。

**非目标**：不改 webview/扩展/适配器行为；不引入新协议能力；不做"顺便清理"。

**量化前置**：动手前先跑 `npm run test:memory` 记录现状基线，重写后对比；若收益不达标应提前中止。

## 1. 模块最终归属

| 模块 | 归宿 | 理由 |
| --- | --- | --- |
| `webview/*` | 永远 TS | DOM/渲染生态无替代 |
| `extension.ts`、`remote-agent.ts`、`conversation-*`、`session-cache`、`workspace-documents`、`state-channel`、`images`、`demo`、`prices` | 永远 TS | VS Code 扩展宿主强制 JS |
| `agent.ts`（codex/claude 直启路径）、`harness.ts`、`shared.ts`、`state.ts`、`context.ts` | 两侧各一份 | 扩展侧必须用 TS；daemon 侧 Rust 需重实现 ACP client 子集 |
| `pi-adapter.mjs`、`pi-enhancements.ts`、`pi-native-fork.ts`、`adapter-*.ts` | 永远 JS | 运行在 pi 进程内部的扩展机制，无 Rust 通道 |
| `session-daemon`、`session-service`、`SessionServer`、`request-journal`、`task-queue`、`workspace-diff`/`turn-diff`、`telegram-*` | **Rust 重写** | 长驻独立进程、socket/文件/子进程边界 |
| `shared-history`、`snapshots`、`atomic-json`、`session-numbers`、`session-preferences`、`native-branch` | 格式不变量 | 双侧并发读写同一目录，Rust 侧必须逐字节兼容（见 data-formats.md） |

## 2. 冻结不变量（勿漂移）

以 `docs/service-protocol.md`（socket 协议）与 `docs/data-formats.md`（磁盘布局/锁/哈希）为准。最易踩坑的三点：

1. **锁是 proper-lockfile 的 mkdir-lock + mtime 心跳**，不能换 flock；`history/` 目录存在 TS 扩展与 daemon 双写者。
2. **分块响应按 UTF-16 code unit 切片，可切断代理对**；Rust 必须用 `Vec<u16>` 切片并手写孤立代理 `\uXXXX` 转义（serde_json 拒绝孤立代理）。
3. **收据指纹与 nativeForks 哈希按 UTF-16 序排键**的 canonical JSON；Rust 排序不能用 UTF-8 字节序。

CLI 兼容：Rust daemon 必须接受 `--config <path>` / `--data-dir <dir>` / `--help`，退出码与错误语义一致。

## 3. 阶段划分

### Phase 0 — 契约冻结（本阶段）

- [x] `docs/service-protocol.md`：wire 协议字节级规范
- [x] `docs/data-formats.md`：磁盘布局、锁、收据、outbox、preferences、fork 哈希
- [x] `scripts/service-contract.mjs` + `test/contract-agent.mjs`：15 项黑盒 contract 测试，`npm run test:contract` 全过
- [ ] native-fork fixtures 导出：把 `test/native-branch.test.ts` 的 entry 序列导出为 `test/fixtures/native-branch/*.json`（含期望 hash），供 Rust 断言
- [ ] 补充 contract 用例（可选）：`_watch` 32 订阅上限、`request` 白名单参数校验、收据损坏拒绝启动、`preferences` 双写原子性
- [ ] golden files：`index.json`/收据/outbox/preferences 的字节级样例入库 `test/fixtures/`

### Phase 1 — Rust telegram-daemon（最小风险先行）

范围：`telegram-api` / `telegram-bridge` / `telegram-stream` / `telegram-sessions` / `telegram-events`(reader)/ `atomic-json`(writer) 的 Rust 版 + socket **client**（含分块重组）。

- 验收：`PI_CONTRACT_DAEMON` 不适用（它是 client 侧）；新建 `scripts/telegram-contract.mjs`（模拟 Telegram HTTP + 模拟 session socket server）双实现跑通；`test/telegram.test.ts` 中 daemon 级用例可指向 Rust 二进制。
- 切换：systemd unit 只改 `ExecStart`；回滚 = 改回 `node dist/telegram-daemon.mjs`。
- 注意：outbox 读取规则（7 天清理、16 MiB、文件名↔id 哈希校验）逐条对齐 data-formats.md §5。

### Phase 2 — Rust session-daemon（核心）

范围：`SessionServer`（listener/背压/分块/订阅路由）、`serviceCommand` 校验、`SessionService`（runtime/worker/权限/取消）、`TaskQueue`、`RequestJournal`、`SharedHistoryStore`+`SnapshotStore`、`allocateSessionNumber`、`SessionPreferences` 读写、`TelegramEvents` 写入、`DesktopTelegramTurn` 发布器、`WorkspaceDiff`+`turnDiffText`、`native-branch` 哈希、ACP client 子集（见下）。

- **ACP client 子集**：`initialize`、`session/new`、`session/load`、`session/prompt`、`session/cancel`(notify)、`session/set_mode`、`session/set_config_option`、`_pi_workbench/{inspect,fork,cancel_fork}`；入站 `session/update` 通知、`session/request_permission` 请求；ndjson 帧、16 MiB 上限、20s initialize 超时。
- **进程管理**：`setsid` + `killpg(SIGTERM)` → 1.5s → `SIGKILL`；worker 退出检测走 `child.wait()`。
- **验收硬门槛**：`PI_CONTRACT_DAEMON=/path/to/rust-daemon npm run test:contract` 全过（必须先 `npm run build`，contract-agent 是 JS）。
- 灰度：Rust daemon 监听 `<data-dir>/service/sessions.sock`，扩展侧 `piAcp.serviceSocket` 切换即可回滚；**严禁新旧 daemon 同 data-dir 并行**。
- worker 仍是 `node dist/pi-adapter.mjs`（pi-adapter 永远 JS），Rust daemon 只是 spawn 它。

### Phase 3 — 扩展侧瘦身（推荐但可后置）

daemon 稳定后，把扩展端 `SharedHistoryStore` 的**写路径**收编为 socket 命令（新增 `historyWrite`/`historyRemove`），TS 侧保留只读。proper-lockfile 双实现收敛为 daemon 单侧，消除锁语义漂移风险。需协议小版本协商（`hello` 的 `_meta` 版本）。

### Phase 4 — 不做的事

- 不为共享 `workspace-diff`/`native-branch` 引入 N-API/WASM——冷路径双份实现比 FFI 便宜。
- 不迁移 pi-adapter；不改动 wire 之外任何协议面。

## 4. 技术选型

| 需求 | 选型 |
| --- | --- |
| 运行时 | `tokio`（signal/UnixListener/process/time 一套） |
| JSON | `serde_json` + 手写 canonical/UTF-16 序列化（见 §2 风险点） |
| HTTP | `reqwest`(rustls) 或 `ureq` |
| 进程组 | `nix::unistd::setsid` + `libc::killpg` |
| 锁 | 手写 mkdir-lock + `filetime` 心跳（对照 proper-lockfile@4.1.2） |
| fsync | `File::sync_all` + 目录 `sync_all` |

## 5. 风险登记册

| 风险 | 等级 | 缓解 |
| --- | --- | --- |
| mkdir-lock 心跳/stale/compromised 语义漂移 → 双写撕裂 index.json | 高 | contract 并发用例；Phase 3 收敛写路径；重写时逐行对照 proper-lockfile 源码 |
| UTF-16 分块/指纹排序差异 → 大响应或 fork 校验静默损坏 | 高 | `big` contract 用例 + native-branch fixtures |
| `_pi_workbench/*` 与回放时序隐性语义遗漏 | 中 | 逐条对照 `session-service.ts`；测试覆盖 replay 期通知过滤 |
| 重写期间 TS 侧继续演进 → 规范漂移 | 中 | 规范文档与 contract 先行；改动必须同步规范 |
| 工作量超估（Phase 2 ~3–4 周） | 中 | Phase 1 先行验证收益；不达标可中止于 telegram-daemon |

## 6. 决策记录（已拍板，勿重开）

- D1: 两个 daemon 逐个替换，不做 big-bang；webview/扩展/pi-adapter 永远 JS。
- D2: wire 协议与磁盘格式冻结为兼容契约；Rust 侧不得引入协议变更（Phase 3 的 historyWrite 是唯一例外，需版本协商）。
- D3: 锁必须兼容 proper-lockfile 语义，禁止 flock/flockfile。
- D4: 收据 30 天保留是现有行为（sweep 已合入），Rust 侧保持一致。
- D5: contract 测试不 import `src/`，永远只打 socket；它同时是规范的可执行形态。

## 7. 进度状态

| 阶段 | 状态 | 备注 |
| --- | --- | --- |
| Phase 0 | 🟡 进行中 | 规范与 contract 套件完成；fixtures 导出待做 |
| Phase 1 | ⬜ | |
| Phase 2 | ⬜ | |
| Phase 3 | ⬜ | |
