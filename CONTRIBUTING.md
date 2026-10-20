# 参与开发

## 架构与入口

生产只有 `pi-acp-workbenchd` 控制进程，workspace 包含它及小型公共 `pi-acp-core`。ACP provider 是外部子进程，不是第二个控制 daemon。

- `rust/crates/pi-acp-workbenchd/src/domain/`：验证后的 ID、命令/事件、纯 reducer、交互、transcript、fork/image/tool metadata。
- `actor*.rs`、`worker.rs`、`task_scope.rs`：唯一状态 owner、bounded routing/I/O、worker epoch、supervision 与 joined cleanup。
- `acp/`：强类型 ACP DTO/client/adapter；JSON 只可停留在 codec 和明确 opaque/extension 边界，不能进入业务存储。
- `persistence/`：version/checksum/revision、durable journal、immutable archive、outbox、Telegram inbox，以及持有 host lease 的显式离线维护。
- `telegram/`、`transport/vscode.rs`：分别直接调用同一 app/domain，不通过内部 socket 或 ACP-shaped compatibility facade。
- `src/workbench-*.ts`：typed IPC decoder/client、cold authoritative view、controller、VS Code entry。TS UI 不是第二套领域 reducer。
- `webview/workbench-main.ts`：生产 browser bundle；Markdown renderer 只提供显示，不授权文件/URL/terminal 执行。

后续功能差异、架构调整和验收要求只维护在[下一版重构计划](docs/workbench-next-rewrite-plan.md)。当前行为维护在 `docs/` 对应使用/协议说明，原始运行日志放 `.test-results/`，不再新增阶段 checkpoint 或执行流水。不要重建旧 daemon/client/readers 来恢复 UI 功能。

## 本地验证

```sh
npm ci
npm run check
npm run build
cargo fmt --manifest-path rust/Cargo.toml --all -- --check
npm run clippy
cargo test --manifest-path rust/Cargo.toml --workspace
npm run test:workbench:storage
npm run test:rewrite
```

`audit:workbench` 同时检查实际 esbuild runtime graph 与包括 erased type-only import、inline import type、alias/extended tsconfig 的 source graph，不能用“打包时被 tree-shake”保留旧 UI 契约。Rust 非测试源码的 raw JSON 仅允许在四个明确 ACP codec/opaque 转换文件：`acp.rs`、`acp/{codec,content,client}.rs`；其余 runtime/actor/worker/transport/domain/persistence/Telegram 也纳入扫描。

`test:rewrite` 运行完整门禁，包括实际新 host 的 IPC/Telegram contracts、生产 Chromium、`test:full`、single-binary packaging/artifact smoke。默认外部 peers 是 synthetic/mock；它们不证明 live provider/Bot 支持。真实本地 Pi SDK/native-file 另用 `test:native-fork:offline`，必须显式指定本地 SDK 路径，不应把默认 ignored case 计为已执行。

## 变更约束

- 保留用户现有工作，不 reset/rebase，不擅自 commit、部署或操作真实存储。
- fixtures 用临时 HOME/storage 和公开 dummy keys，不继承真实账户或 Bot 配置；独立 ACP test helper 默认仅继承 PATH/locale，创建自己的私有 HOME，physical child join 后只删除该目录。手动 opt-in SDK/live smoke 必须显式提供环境（离线 SDK wrapper 提供隔离环境与 network guard），不能将其默认继承行为复制回普通 tests；不要输出敏感 token、provider error descriptions 或凭据 URL。
- 不隐式迁移/清理旧格式。GC 必须证明 typed reachability、offset/dedup/high-water 与 crash 安全；字符串包含、mtime 和缺锁文件不是删除授权。
- observer 取消只丢 observer，不等于撤销已接受副作用；文件事务必须有外部 owner 并 physical join，lease 最后释放。
- native restore/fork 保持真实 identity/context；不以文本重播、摘要、silent new session 或 timestamp 猜测替代。
- mutations 检查当前 workspace trust/canonical containment；路径、URI、terminal metadata 不授权读取或执行。
- 同步变更后的 schema、contracts、文档与 evidence。历史测试通过、短 regression 或本地打包不等于长期 soak、真实服务部署或最终验收。
