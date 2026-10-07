# 常驻服务单实现收敛研究

## 结论与范围

本研究只提出方案，不删除代码、不切换默认部署。

如果首要目标是减少维护成本和迁移风险，建议保留 **TS 会话服务 + TS Telegram relay**，淘汰 Rust 两套 daemon。当前 npm 命令、systemd 示例、VSIX 构建和大量单测已经以 TS 为主，实施成本最低。

如果首要目标是降低服务器常驻内存，建议最终保留 **Rust 会话服务 + Rust Telegram relay**，但必须先完成测试迁移、发布产物和端到端验证，再删除 TS 服务实现。当前不宜直接删除 TS。

不建议长期保留“另一套实验实现但继续同步新协议”：这仍然是双实现维护。过渡期之外，旧实现应只保留在历史 tag / release，不留在主分支构建或测试路径。

“单实现”指每个常驻服务只有一套生产实现，不是整个仓库只用一种语言。即使保留 Rust，扩展、Webview、适配器、Pi 工作进程仍依赖 JS/TS 和 Node.js。

## 当前依赖与事实

- 默认部署：`package.json` 的 `sessions` / `telegram`、`examples/pi-*.service` 均启动 TS 构建产物。
- `scripts/build.mjs` 将两个 TS daemon 与扩展、Webview 一起构建；`.vscodeignore` 的 `!dist/**` 会打包其产物。
- `src/extension.ts` / `src/remote-agent.ts` 通过 `SessionClient` 访问服务，对服务的实现语言无要求；但依赖 `session-protocol.ts` 中的类型。
- `src/session-wire.ts` 同时包含客户端与服务端。淘汰 TS 服务时必须保留客户端，不能整文件删除。
- `SharedHistoryStore` 仍供扩展的共享历史、租约及本地回退使用；Codex / Claude 也需要这些逻辑。Rust 成为唯一 daemon 不意味着它成为所有历史文件的唯一写入者。
- `agent.ts`、`state.ts`、`native-branch.ts`、`workspace-diff.ts`、`session-preferences.ts` 等也被扩展或适配器使用，不属于可整体淘汰的 TS 服务副本。
- `scripts/build-adapter.mjs` 将上游 `pi-acp` 与本仓库增强模块打包成 `pi-adapter.mjs`；Rust 会话服务仍启动这个 Node 适配器。
- Rust 默认适配器发现方式与 TS 不同：依赖 `PI_ADAPTER` 或可执行文件旁的 `pi-adapter.mjs`，否则须显式设置 `command` / `args`。

### 一次本机空闲测量

相同显式 worker 配置、隔离临时数据目录，不创建会话或启动 Pi worker；服务 ready 后等待 3 秒，从 `/proc/<pid>/status` 读取 RSS：

| 实现          | 产物                           | ready 耗时 | 空闲 RSS                  |
| ------------- | ------------------------------ | ---------- | ------------------------- |
| TS 会话服务   | 当前 `dist/session-daemon.mjs` | 138 ms     | 78,520 KiB（约 76.7 MiB） |
| Rust 会话服务 | 当前 debug 二进制              | 3 ms       | 9,372 KiB（约 9.2 MiB）   |

这是单次样本，不是正式性能基准。未测 Telegram RSS、满载 CPU、工作进程总内存或长时间稳定性。只能支持“Rust 会话服务空闲占用明显较低”，不能据此宣称总系统内存下降相同比例。

## 方案 A：保留 TS，淘汰 Rust（低风险推荐）

### 实施顺序

1. 补充旧 Rust 部署切换到 TS 的说明，冻结最终 Rust 版本的 tag / release；先收敛默认入口和 CI。
2. 将 `test:contract:telegram` 改为构建 TS 后测试 `test/telegram-contract-entry.mjs`；脚本的默认被测实现也改为 TS，避免仅修改 npm 命令。
3. 删除 `rust/` 源码和 Cargo 文件，从 CI 移除 Rust 构建、单测及第二轮契约测试。
4. 更新 README、CONTRIBUTING、服务/Telegram/架构/测试文档，移除 Rust 安装和双实现说明；保留历史 CHANGELOG 的历史事实。
5. 从干净构建目录验证 `test:all`、两套服务契约、浏览器和内存检查。

### 必须保留

- `scripts/service-contract.mjs`、`scripts/telegram-contract.mjs`：仍验证生产边界，不是双实现专用资产。
- `test/fixtures/` 和 `scripts/export-fixtures.mjs`：原生分支、磁盘格式和协议回归仍有价值。
- `docs/service-protocol.md`、`docs/data-formats.md`：服务实现虽单一，客户端兼容和升级回滚仍需要契约。
- TS 契约测试的显式模拟传输入口，不能恢复生产环境变量测试钩子。

### 部署切换

暂停新任务，停止 Telegram relay，再停止会话服务；备份数据目录，并确认 Pi 子进程已退出。更新 systemd `ExecStart` 为 Node + `dist/*.mjs`，启动会话服务并验证历史/配置，再启动 relay。

数据格式目前设计为兼容，不预先进行数据转换；但必须先完成实际双向切换测试。不得同时启动新旧服务，也不要在旧进程仍运行时删除锁。

## 方案 B：保留 Rust，淘汰 TS 服务（内存优先）

### 阶段 1：补足删除门槛，暂时维持双实现

不能把现有 TS 单测删除后，以“Rust 契约全过”替代原有覆盖。当前服务契约 22 项、Telegram 契约 10 项覆盖的是部分黑盒行为；不少故障场景只在 TS 单测中验证。

迁移重点：

| 现有测试资产                                      | Rust 收敛前需要的替代验证                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `test/telegram-sessions.test.ts`                  | 多窗口/手机共用任务、取消、队列/容量/回收、幂等、原生分支、磁盘失败不执行/不重试            |
| `test/session-preferences.test.ts` 的服务相关用例 | 跨目录/重启偏好、新建使用默认值时恢复偏好、不可用值不损坏原文件                             |
| `test/telegram.test.ts`                           | 游标持久化失败禁止执行、绑定/通知事务失败、终态投递重试、history sync、去重、静音、权限隔离 |
| `test/long-running.test.ts`                       | 背压、队列上限、断线分块、超大响应隔离、超时不重放                                          |
| `test/memory-soak.ts`                             | 外部 daemon RSS/资源数量稳定性；不能继续读取已删 TS 实现的私有字段                          |
| `test/controller.test.ts` 的真实服务用例          | 扩展通过真实 `SessionClient` / `RemoteAgent` 连接 Rust 子进程                               |

优先将外部可观察行为提升为共享黑盒契约；故障注入、事务细节和资源释放则补 Rust 单测。不要为了测试保留一整套可运行 TS 服务。测试专用 mock socket server / mock agent 不属于第二套生产实现。

新增端到端检查：真正的 Rust 会话服务 + 真正的 Rust relay + mock Bot API + mock ACP worker。现有 Telegram 契约使用 mock session server，不能证明两个真实服务集成无误。

### 阶段 2：切换部署与发布

- 提供 Linux x86_64 / aarch64 的生产二进制、校验和、明确的 libc / TLS 兼容要求；生产产物不得开启 `contract-test` feature。
- 发布完整运行目录：两个二进制 + `pi-adapter.mjs` + `pi-native-fork.mjs`；适配器会依赖后者，不能只发布 Rust 可执行文件。
- 明确 Node 22+ / Pi 的安装依赖，固定 worker 命令或适配器发现规则，不再依赖当前工作目录碰巧正确。
- 将 systemd、npm 入口、README 和默认契约目标统一切到 Rust。不要引入“Rust 启动失败自动退回 TS”的隐式双实现路径。
- 建议服务产物与 VSIX 分开发布：扩展只提供客户端与 Webview，不在宿主启动时下载/编译未知架构二进制。
- 在独立数据目录完成真实适配器集成与多窗口 smoke，且不调用付费模型；再进行生产小范围切换。

### 阶段 3：删除 TS daemon，而不是删除 TS 公共模块

可删除的生产实现候选：

```
src/session-daemon.ts
src/session-service.ts
src/request-journal.ts
src/task-queue.ts
src/telegram-daemon.ts
src/telegram-bridge.ts
src/telegram-stream.ts
src/telegram-sessions.ts
src/telegram-api.ts
src/telegram-config.ts
src/telegram-events.ts
```

删除前逐个确认没有存活的测试、脚本或客户端 import。两处特殊拆分：

- `src/session-wire.ts`：保留 `SessionClient` 和响应解析/客户端限制，删除 `SessionServer` 及服务端缓冲、订阅实现。
- `src/session-protocol.ts`：保留/抽取客户端响应类型（尤其 `ServiceState`），删除服务端命令执行校验；可使用 schema 或 Rust 类型导出生成 DTO，但不要把运行语义隐藏到代码生成里。

继续保留 `shared-history.ts` 及本地回退和租约语义。是否取消旧服务回退、是否让 Rust 接管 Codex / Claude 历史，是另外两项协议/架构改造，不应混入本次淘汰。

移除 `scripts/build.mjs` 中两个 TS daemon 构建目标、TS Telegram 测试入口及测试脚本中的 TS 选择适配逻辑。构建脚本当前不会清空 `dist/`，删除入口后旧产物仍可能被 `!dist/**` 打包，必须增加 clean 或使用全新产物目录，并检查 VSIX 文件清单。

## 两条方案共同的验收与回滚

### 删除前的硬门槛

1. 所有保留功能均有单测/契约/集成覆盖；建立原 TS 用例到新测试的映射，不以测试总数作等价证明。
2. 同一份真实格式 fixture / 隔离数据目录完成旧 → 新 → 旧切换，验证历史、revision、墓碑、偏好、请求收据和 Telegram 游标/绑定不损坏。
3. 服务重启时未完成请求标记 interrupted，不重放任务；SIGTERM 清理 Pi 进程组，断开桌面客户端不取消任务。
4. 保持 mkdir/proper-lockfile 的锁兼容及 UTF-16/hash 语义。即使服务只剩 Rust，JS 客户端和适配器仍参与这些边界。
5. 长时间 RSS/FD/worker 数量不持续增长；不只比较空闲 RSS。
6. 干净检出可构建和打包，VSIX 不含过时 daemon、测试二进制、source map 或 `contract-test` 产物。

### 回滚窗口

建议默认切换后保留至少一个稳定版本的旧 release 和配置模板，但不继续在主分支维护旧源码。回滚时先停止新服务，检查子进程，再恢复旧程序；如果新程序已写入不能向后兼容的格式，必须恢复切换前备份，不能让旧程序强读。

### 建议拆分的提交

1. 补齐黑盒契约/故障测试与迁移 smoke（不切换默认）。
2. 发布/部署入口、CI 和文档切换（明确选定实现）。
3. 删除旧实现并迁移/清理内部单测。
4. 清理依赖、产物与残留引用，验证干净构建。

## 决策建议

本仓库当前应以 **TS-only 作为最低风险收敛方案**。若 60–100 MiB 级别的每服务常驻开销确实影响目标部署，则选择 **Rust-only**，把阶段 1 的测试迁移视为必做工程，而不是单纯删除文件。

TS 会话服务 + Rust Telegram relay 也能做到“每服务单实现”，但继续需要双语言工具链；它适合渐进迁移，不是最大化维护简化的终点。最终选择应由实际内存预算与维护者语言能力决定，而非仅凭“Rust 更快”或“TS 测试更多”。
