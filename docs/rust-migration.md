# Rust 契约单实现迁移进度

## 目标与当前边界

生产会话服务和 Telegram relay 仅使用 Rust；扩展宿主、Webview、协议客户端与 Pi 适配器保留 TS/JS。Node.js 仍是 Pi worker 的依赖。

生产入口、会话服务和 Telegram 内部实现的源码收敛已经完成：服务端仅有 Rust，TS/JS 仅保留扩展、客户端、共享文件格式支持与适配器。不以测试总数替代覆盖映射；下表记录淘汰参考资产的依据，真实适配器、多架构发布与长时间生产浸泡仍是后续验收。

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
| `telegram-sessions.test.ts` | 改名 `rust-sessions.test.ts`，14 项直接启动真实 Rust：跨端任务、并发去重、实际 worker PID 上限/回收、授权、重启恢复、原生分支、真实文件系统失败不执行/不重放、三种终态 Diff/outbox |
| service preferences         | `session-preferences.test.ts` 的服务用例直接连接 Rust，覆盖跨目录/重启、恢复旧会话、不覆盖偏好和不可用值保留                                                                       |
| TS socket service/limits    | Rust PrivateSocket 测试验证权限/原子发布与失败清理；Rust server 测试验证超限隔离、订阅、32 连接/128 请求、字节与队列回收                                                           |
| Unicode history/transport   | `long-running.test.ts` 用真实 Rust 读取/广播 >16 MiB Unicode；TS 客户端的 transport-only mock 测试超时、晚到结果、序列化/并发上限、断线分块清理                                    |
| JS service memory soak      | 替换为真实 Rust 的 1024 份/64 MiB 收据、1200 次复用、150 次连接、RSS/FD/worker 观测；预览源缓冲所有权另有 Rust 单测                                                                |

Rust 的写故障、落盘后取消和响应阈值注入仅编译于 `cfg(test)`，不存在于生产或契约 daemon 二进制中，不新增生产环境变量后门。TS transport-only mock 不包含会话/磁盘/worker 执行逻辑，不是另一套服务。

## 第三阶段：Telegram 故障覆盖迁移

Telegram 黑盒契约从 10 项扩展到 23 项，使用真实 Rust relay，只有 Bot HTTP 与会话 socket 使用外部 mock：

- 重复 update ID 只执行一次；实际排队消息在 /stop 后丢弃，后续新消息仍可执行。
- 默认有声推送、通知关闭后的终态确认、独立静音持久化、已有 stream 的实时静音切换。
- 桌面输入与回复、事件重复投递不重复发送；失败投递保留事件并重试，不重新运行 agent。
- 错误描述/token 脱敏，429 实际遵守整数 retry_after，Unicode 完整分块输出。
- history 100 条分批、再次同步不重复；发送失败不记确认，新话题失败后重试不重复建话题。
- 用户/话题/选项权限隔离、有效响应后票据退休；/help 与 /commands 的完整路由说明。
- 真实文件系统游标写失败时停止派发，重启保留最后持久化游标；已有 webhook 拒绝启动，不修改状态。

新增 Rust 单测验证：失败事务不发布游标/绑定/确认/history/通知/静音状态，成功后镜像与磁盘一致；并发事务不覆盖彼此；预览数量上限、弃置 stream 和票据清理；发送队列上限与停止后槽位回收；网络错误不泄露 token/URL；损坏/不匹配/过期/超大 outbox 的读取边界。

会话服务 outbox 的慢盘测试确定性暂停首个写入，驱动 50 次进度，只保留最新待写终态；真实文件系统故障验证最后写失败报告与 writer 排空。仅 cfg(test) 存在暂停器。原 `long-running.test.ts` 的两个参考用例据此删除，文件只保留真实 Rust Unicode/订阅测试。

同时修复 Rust relay 一次性载入所有 outbox 文件的问题：生产扫描改为逐条惰性消费，读取本身最多 MAX_SIZE+1 字节，防止 metadata 检查后文件变大突破上限。单测验证第二个文件在消费时才读取，不沿用预先载入的内容。

## 第四阶段：Telegram 参考实现淘汰

补齐 Rust 的 100 次增量合并、Unicode 完整终态/有声通知、建话题写失败后的缓存重试、发送确认失败后只补确认、开关派发失败无菜单副作用、过期票据不访问会话服务。HTTP unit fixture 仅 cfg(test)，每例独立 loopback 端口，不修改环境变量，不访问真实 Telegram。黑盒契约再补允许目录 symlink 的规范化与重复 /open 复用，当前 24 项。

覆盖迁移中发现并修复了一个真实差异：Rust outbox 原先只报告终态写失败却让 prompt 成功。现在终态 write 错误向调用方传播，真实 socket 用例验证 state.error、interrupted 收据和同 ID 不重放。成功的后续写入会清除中间写错误；故障报告与排空仍保留。

旧 `test/telegram.test.ts` 的 20 项覆盖映射：

| 旧参考场景                                | Rust 覆盖位置                                                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1. 生产环境覆盖隔离/目录限制配置          | api production_tests、config tests、Telegram 契约                                                    |
| 2. 配置拒绝、网络/描述脱敏、429           | config tests、api network_errors、契约脱敏/429                                                       |
| 3. 100 次增量、Unicode、完成有声          | stream coalesces_one_hundred_updates 单测                                                            |
| 4. 身份/话题隔离、重复 open               | 契约拒绝身份/话题、canonical alias/repeated open                                                     |
| 5. 持久游标/重复 update                   | 契约 duplicate update/cursor write failure                                                           |
| 6. webhook/落盘失败不派发                 | 契约 webhook/cursor write failure                                                                    |
| 7. 失败投递重试不重执行                   | 契约 failed outbox delivery                                                                          |
| 8. 用户/话题/选项/live 票据               | 契约 permission cards、bridge expired ticket 单测                                                    |
| 9. 离线桌面、损坏文件、cwd 隔离、确认去重 | 双服务集成、events 单测、bridge failed_delivery_ack                                                  |
| 10. 暂停、history 去重、开关授权          | 契约 notifications/history/identity，bridge dispatch failure                                         |
| 11. 排队、stop 丢弃与后续请求             | 契约 stop/new prompt after stop                                                                      |
| 12. 绑定/确认/开关写失败事务              | bridge failed_durable_transactions、topic_write_failure、failed_delivery_ack、failed_switch_dispatch |
| 13. 最后 outbox 写失败                    | outbox final_outbox_storage_failure、真实 Rust socket terminal-outbox-failure                        |
| 14. 预览容量/过期                         | bridge previews_are_bounded、stream owned buffer 单测                                                |
| 15. history 分批同步                      | 契约 100-entry batches/repeated sync                                                                 |
| 16. 新话题发送失败后重试                  | 契约 sync creates a topic once                                                                       |
| 17. help/commands                         | 契约 help/commands routes                                                                            |
| 18. 默认推送/独立静音                     | 契约 plain prompt/notifications/silence                                                              |
| 19. 已有 stream 实时静音                  | 契约 live stream silence                                                                             |
| 20. 桌面输入和重复事件                    | 契约 desktop input/idempotent event                                                                  |

据此删除 `src/telegram-{api,bridge,config,events,sessions,stream}.ts` 和 `test/telegram.test.ts`，不保留长期实验副本。`test/phone-client.ts` 只封装 socket 请求/订阅，不含目录策略、状态库、relay 或 worker 执行；文件观察器保留在 `test/rust-utils.ts`。旧 TS 私有类 API 不再作为支持接口；公开 wire/磁盘契约仍是兼容边界。覆盖映射并不证明所有未枚举输入或旧→新→旧生产回滚都已经验收。

## 并行验收

`npm run test:full` 每次仅构建 debug/contract 两套产物一次，然后有界并行运行 TS、Rust 单测、会话契约、Telegram 契约、双服务集成、RSS/FD 和 runner 单测。`TEST_JOBS=1` 可顺序复现，默认最多 3 个套件，支持 1–8；每个套件使用独立进程/临时目录/端口。共享状态的 Telegram 契约用例内部仍顺序执行。

日志保存 `.test-results/run-*/`；一个套件失败仍执行其余套件，退出码非零。CI 将服务验收、浏览器和生产打包拆成并行 job，服务 job 用 TEST_JOBS=2，失败时上传日志。

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
