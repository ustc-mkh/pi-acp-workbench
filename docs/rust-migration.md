# Rust 契约单实现迁移进度

## 已选定的目标

生产会话服务和 Telegram relay 仅使用 Rust；扩展宿主、Webview、协议客户端与 Pi 适配器保留 TS/JS。Node.js 仍是 Pi worker 的运行依赖。

本轮完成的是第一阶段：**生产入口收敛 + 真实 Rust 集成基线**，不是已经删除全部 TS 服务代码。

## 已完成

- 删除 `src/session-daemon.ts`、`src/telegram-daemon.ts` 及 TS relay 契约入口；`npm run build` 不再构建或打包 TS daemon。
- `npm run sessions` / `telegram` 只启动 `service-dist/` 的 Rust 二进制，缺失产物时明确报错，不自动回退 TS。
- `npm run build:services` 生成两个生产二进制、JS 适配器与 native-fork 扩展、平台/架构/SHA-256 清单；生产构建不启用 `contract-test`，原生产物与 VSIX 分开。
- 两套黑盒契约默认仅测试 Rust；CI 移除双实现重复执行，加入 Rust 双服务集成与生产产物构建。
- 桌面控制器的真实远程 Pi 用例连接 Rust 子进程，不再以内嵌 TS 服务代替生产执行边界。
- 新增 Rust queue 测试：取消旧代请求但允许后续请求、全局容量限制、关闭期间拒绝新请求、清理队列与取消状态。
- 新增 Rust journal 测试：in-flight 去重与异参数拒绝、重启结果复用、损坏收据保留、初始落盘失败不执行、失败请求不重放。
- 新增真实会话服务 + relay + mock Bot HTTP + mock ACP worker 集成，覆盖共享会话、授权、取消及离线 outbox 重启投递。
- 集成发现并修复 Rust relay 重启校验错误：可选的 `historySent` 缺失被误判为损坏；增加保存/重读与非法类型回归。

## 尚未完成：覆盖迁移后再删除旧内部模块

以下文件当前只用于迁移期间的旧故障测试，不再发布 TS 服务，不得增加新的 TS daemon 或第二套生产路径。不能将这些用例删除后，仅凭契约总数宣布行为等价。

| 旧测试                        | 已有 Rust 覆盖                                        | 待迁移                                                   |
| ----------------------------- | ----------------------------------------------------- | -------------------------------------------------------- |
| `task-queue.test.ts`          | 取消代、容量、关闭/清理                               | 队列上限和取消边界扩展                                   |
| `request-journal.test.ts`     | 去重、持久化复用、损坏拒绝、初始失败、错误墓碑        | 落盘成功后/执行前取消的故障注入                          |
| `telegram-sessions.test.ts`   | 现有契约 + 真正的桌面/手机授权取消集成                | 原生分支/偏好、回收、更多写入失败时的 worker 边界        |
| `telegram.test.ts`            | 身份隔离、话题绑定、通知开关、权限、停止、重启 outbox | history sync、静音、磁盘失败事务、失败投递重试和票据过期 |
| `long-running.test.ts`        | 服务大帧/分块/订阅等契约                              | 超限资源、慢磁盘合并、资源释放与长时间浸泡               |
| `memory-soak.ts`              | 尚无 Rust RSS 等价验收                                | 外部 RSS/FD/子进程检查，替换 JS 私有字段断言             |
| `session-preferences.test.ts` | Rust prefs 单测及格式规范                             | 完整黑盒跨目录/重启/恢复偏好                             |

剩余旧内部模块包括 `session-service.ts`、`SessionServer`、服务端命令校验、`request-journal.ts`、`task-queue.ts` 与 Telegram 内部模块。迁移完对应测试后删除；保留 `SessionClient`、`ServiceState` 等客户端类型，以及扩展/其他 harness 仍使用的共享历史、状态、偏好和适配器模块。

## 后续阶段

1. 将外部可观察语义迁为 Rust 黑盒契约，磁盘/队列故障点迁为 Rust 单测；建立逐项覆盖映射。
2. 移除旧 TS 内部实现和已迁移测试，拆分 `session-wire.ts` 为纯客户端，协议类型与服务校验分离。
3. 增加 Rust RSS/FD 浸泡、原生适配器 smoke、旧→新→旧的隔离数据回滚测试。
4. 完善 Linux x86_64 / aarch64 发布与 ABI/TLS 兼容说明；当前 `build:services` 只构建本机 Linux 架构，不宣称已有多架构预编译发布。

## 验证命令

```bash
npm run test:all
cargo test --manifest-path rust/Cargo.toml
npm run test:contract
npm run test:contract:telegram
npm run test:integration:rust
npm run build:services
npm run sessions -- --help
npm run format:check
```

生产升级先结束任务，停止 relay 和会话服务，备份数据，更新 `service-dist/` 与 systemd 入口，再依次启动。旧版本只从历史 release/commit 回滚，不恢复主分支上的双服务默认实现。
