# Rust 契约单实现迁移进度

## 目标与当前边界

生产会话服务和 Telegram relay 仅使用 Rust；扩展宿主、Webview、协议客户端与 Pi 适配器保留 TS/JS。Node.js 仍是 Pi worker 的依赖。

第一阶段已完成生产入口收敛；第二阶段已完成 **TS 会话服务内部实现淘汰**。Telegram 的旧内部参考模块仍在测试中，尚未完成所有源码的单实现收敛，不以测试总数替代覆盖映射。

## 已完成：生产入口

- 删除 TS daemon 入口和构建目标；npm/systemd 只启动 Rust，缺失产物明确报错，不自动回退 TS。
- `npm run build:services` 生成两个生产二进制、JS 适配器/native-fork、平台/架构/SHA-256 清单；生产不开启 `contract-test`，服务产物与 VSIX 分开。
- 服务/Telegram 契约默认只测试 Rust；CI 加入真实双服务集成、生产构建与 Rust RSS/FD 检查。
- 真实桌面 RemoteAgent 用例与双服务集成覆盖共享会话、订阅、授权、取消及 relay 重启后的离线 outbox。
- 修复 Rust relay 错误要求可选 `historySent` 存在的问题；保存/重读与非法类型均有回归。

## 已完成：TS 会话服务淘汰与覆盖迁移

已删除：

```
src/session-service.ts
src/request-journal.ts
src/task-queue.ts
SessionServer（原 src/session-wire.ts 内）
TS 服务端命令校验（原 src/session-protocol.ts 内）
test/request-journal.test.ts
test/task-queue.test.ts
test/session-wire-permissions.test.ts
```

`session-wire.ts` 现在只有 TS 客户端及客户端安全边界；`session-protocol.ts` 只保留 DTO。共享历史/租约、其他 harness 状态和适配器模块继续由扩展使用，不属于可淘汰的服务副本。

| 原测试资产                  | 当前覆盖                                                                                                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TS queue                    | Rust queue：取消代、后续请求、全局容量、关闭拒绝/清理、队列溢出无泄漏                                                                                                              |
| TS journal                  | Rust journal：并发去重、重启复用、损坏收据保留、初始写失败不执行/可重试、错误墓碑不重放；落盘成功后/执行前取消的确定性测试                                                         |
| `telegram-sessions.test.ts` | 改名 `rust-sessions.test.ts`，13 项直接启动真实 Rust：跨端任务、并发去重、实际 worker PID 上限/回收、授权、重启恢复、原生分支、真实文件系统失败不执行/不重放、三种终态 Diff/outbox |
| service preferences         | `session-preferences.test.ts` 的服务用例直接连接 Rust，覆盖跨目录/重启、恢复旧会话、不覆盖偏好和不可用值保留                                                                       |
| TS socket service/limits    | Rust PrivateSocket 测试验证权限/原子发布与失败清理；Rust server 测试验证超限隔离、订阅、32 连接/128 请求、字节与队列回收                                                           |
| Unicode history/transport   | `long-running.test.ts` 用真实 Rust 读取/广播 >16 MiB Unicode；TS 客户端的 transport-only mock 测试超时、晚到结果、序列化/并发上限、断线分块清理                                    |
| JS service memory soak      | 替换为真实 Rust 的 1024 份/64 MiB 收据、1200 次复用、150 次连接、RSS/FD/worker 观测；预览源缓冲所有权另有 Rust 单测                                                                |

Rust 的写故障、落盘后取消和响应阈值注入仅编译于 `cfg(test)`，不存在于生产或契约 daemon 二进制中，不新增生产环境变量后门。TS transport-only mock 不包含会话/磁盘/worker 执行逻辑，不是另一套服务。

## 待完成：Telegram 内部覆盖迁移

暂留 `src/telegram-*` 内部参考模块及 `test/telegram.test.ts`、`long-running.test.ts` 的两个 relay/outbox 用例。它们不发布，不新增第二条生产路径，不能将其测试删除后声称 Rust 行为等价。

主要剩余项：

1. history sync、静音切换、票据过期、权限隔离的完整 Rust 黑盒/单元覆盖。
2. 游标、绑定、通知开关、发送确认在磁盘失败时的事务边界，以及失败投递重试。
3. Rust outbox 的慢磁盘合并与终态错误传播，与 TS 参考用例建立完整逐项映射。
4. 覆盖后删除旧 Telegram bridge/API/stream/events/config/sessions 及参考测试；测试中的纯协议客户端/文件观察器应独立保留，不混入生产服务逻辑。

## 后续生产验收

- 原生适配器 smoke、旧→新→旧的隔离数据回滚及长时间浸泡。
- Linux x86_64 / aarch64 发布与 ABI/TLS 说明；当前 `build:services` 只构建本机 Linux 架构，不宣称已有多架构预编译发布。

```bash
npm run test:all
cargo test --manifest-path rust/Cargo.toml
npm run test:contract
npm run test:contract:telegram
npm run test:integration:rust
npm run test:memory
npm run build:services
npm run format:check
```

生产升级先结束任务，停止 relay 和会话服务，备份数据，更新产物和 unit，再依次启动。旧实现只从历史 release/commit 回滚，不恢复主分支上的双服务入口。
