# 架构与会话生命周期

## 统一运行路径

```text
VS Code Webview → ChatProvider → RemoteAgent / SessionClient ─┐
                                                            ├→ Unix socket → Rust SessionService → ACP worker
Telegram → Rust relay / WireClient ──────────────────────────┘                      ├→ Pi 增强适配器
                                                                                   ├→ codex-acp
                                                                                   └→ claude-agent-acp
```

Rust daemon 是所有 harness 的进程、队列、历史、偏好和本轮 Diff 的唯一所有者。插件只负责 webview 接线、附件、文档预览、客户端统计和活动会话指针。没有扩展宿主直接启动 ACP worker 的路径，没有 v1/v2 文件写降级路径。插件要求 `session-service.version=3`；升级必须同时更新插件和 daemon。

`ChatProvider` 使用同一个 `RemoteAgent` 接口，所有会话状态来自服务。原来的 `ConversationBackend`、本地 `AgentProcess`、`SessionCache`、共享历史事务/租约、客户端 Diff 和快照写入已移除。测试中的直接 ACP 客户端及离线数据 fixture 仅用于上游协议与损坏数据测试，不属于生产入口。

## 职责

Rust 模块位于 `rust/crates/pi-acp-session-daemon/src/`，客户端模块位于 `src/`；Telegram 模块位于 `rust/crates/pi-acp-telegram-daemon/src/`。

| 模块                                                                               | 职责                                                     |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `server.rs`                                                                        | Unix socket 接入、帧限制、背压、订阅与连接回收           |
| `pi-acp-core/src/protocol.rs` / `session-protocol.generated.ts`                    | serde 边界与 ts-rs 生成的客户端协议                      |
| `service/worker_pool.rs`                                                           | 按 harness 选择 worker、能力协商、原生加载、闲置回收     |
| `service/session_ops.rs`                                                           | 创建、状态、设置、删除                                   |
| `service/turn.rs` / `phase.rs`                                                     | 轮次执行、授权、取消、分支、终态保存                     |
| `queue.rs` / `journal.rs`                                                          | 会话串行、全局容量、取消代际、持久化防重放收据           |
| `history.rs` / `prefs.rs` / `diff.rs`                                              | 服务独占历史、按 harness 偏好、工作区净变化              |
| `conversation-session.ts` / `conversation-turn.ts` / `conversation-attachments.ts` | 会话选择与启动、轮次操作、附件与导出；依赖本地 Host 接口 |
| `bridge/commands.rs`                                                               | Telegram 命令解析、分发与会话权限检查                    |
| `outbox.rs` / `outbox_reader.rs`                                                   | 持久化事件、socket 分页读取与版本确认                    |
| `conversation-history.ts`                                                          | socket 历史读取、轮询、删除、失效代际；无磁盘事务        |
| `conversation-statistics.ts`                                                       | 客户端用量分页、价格、标题与迟到结果过滤                 |
| `workspace-documents.ts`                                                           | Diff 预览、文档缓存、链接真实路径校验                    |

## Telegram 中继的内部边界

`bridge.rs` 是组装入口：持有运行时资源、启动检查、持久化入口和关闭顺序。业务操作按职责放在 `bridge/` 下，仍共用一个 Bridge，不增加进程或服务之间的网络调用。

| 模块             | 职责                                                               |
| ---------------- | ------------------------------------------------------------------ |
| `state.rs`       | 磁盘 DTO 和格式校验；不包含网络、文件读写或任务调度                |
| `store.rs`       | 唯一状态写入入口；串行事务、durable 写入后才发布内存快照和通知开关 |
| `routing.rs`     | 纯命令分类及排队策略；普通提示词和控制操作各自保持话题内顺序       |
| `inbox.rs`       | 接收游标、持久化入队、恢复和有界调度                               |
| `commands.rs`    | 消息/按钮分发与命令处理                                            |
| `turns.rs`       | 提示词执行、会话队列与取消代际                                     |
| `delivery.rs`    | 消息投递、预览缓存、outbox 消费和确认                              |
| `history.rs`     | 话题绑定和显式历史同步                                             |
| `permissions.rs` | 授权票据及通知菜单                                                 |
| `task_scope.rs`  | 本地观察任务和消息处理任务的所有权与关闭                           |

状态读取只取得不可变视图；业务模块不能直接写入底层 RwLock。修改经 `StateStore::update` 完成，磁盘写失败时内存快照和通知开关保持原值。持久化模型和线协议沿用已有格式。

`OwnedTask` 在所有者释放时取消本地监听；`TaskScope` 跟踪已接收的处理任务，关闭后拒绝新任务。关闭顺序为停止接收 → 断开会话客户端以唤醒等待 → 等待处理任务退出（最多 5 秒，超时回收本地任务）→ 清理缓存。服务端已经提交的模型任务仍由会话 daemon 持有；接收记录继续遵守“未完成记录不自动重放”的规则。

## Harness 与能力边界

worker 配置统一放在 `sessions.json`，可用 `harnesses.pi/codex/claude` 分别覆盖 command/args/env。顶层 command/args/env 为 Pi 配置；未配置的 Codex/Claude 分别从服务 PATH 启动 `codex-acp` / `claude-agent-acp`。不自动安装适配器，也不继承 Pi 专属环境覆盖。凭据归上游工具管理，登录按钮仅打开登录终端。

每个 harness 的 `hello` 返回实际 ACP `initialize` 结果，并添加 `agentCapabilities._meta['session-service']={version:3,authoritative:true,usageInspection:<boolean>}`。能力首次探测会短暂启动 worker，后续在服务生命周期内缓存；配置更新需重启服务。图片、配置选择器、原生加载按上游声明处理。Pi 的 inspect/nativeFork 扩展只在适配器实际声明时开放；Codex/Claude 不伪造 Pi 原生扩展能力；服务通过 `session-service.usageInspection` 单独声明 Codex / Claude 用量查询支持。Codex collaboration mode 保持 default，fast mode 按上游能力提供。

Codex/Claude 每轮 `session/prompt` 返回的用量由 `usage.rs` 规范化并随完整历史快照持久化。优先读取 `_meta.quota.model_usage`，否则读取 `usage` 或 `_meta.quota.token_count`，两者不累加；输入已排除缓存读取，推理 token 已包含在输出中。Claude 按模型明细可包含子任务，统计范围可能大于主会话汇总。按服务请求 ID 生成稳定记录 ID，重复刷新不重复计数。未知模型标为 `unknown`，非法计数不转为零记录。

用量记录不进入历史索引和高频状态广播。Codex/Claude 的 `_pi_workbench/inspect` 在服务端读取已保存记录，每页最多 500 条，不调用上游 Pi 扩展，不为冷会话启动 worker；兼容既有查询路径。Pi 仍由原有增强适配器提供统计。上下文占用来自 `usage_update.used/size`，与累计 token 消耗分开，不能据此还原系统提示词、工具定义或完整模型上下文。旧适配器不返回用量时显示缺失说明，不自动扫描供应商的私有历史文件。

Pi 使用原生 ID；其他 harness 使用 `workbench:<harness>:<encodeURIComponent(nativeId)>`。Rust ACP 请求边界统一还原出站 ID、为通知和授权加入命名空间。快照必须显式记录匹配的 harness，不通过 ID 推断缺失元数据。编号、队列、删除和收据使用本地 ID。

## 会话生命周期

首次打开无历史时仅显示欢迎页；显式新建才调用 create。活动指针触发恢复，浏览已有历史读取服务状态，不为浏览启动工作进程。冷会话在发送、修改设置或分支时请求上游 session/load；加载失败保留原 ID 和快照，不重放提示词、不自动新建。无 loadSession 能力的历史只读展示。

多个桌面/Telegram 客户端可以附着同一个会话，没有客户端独占文件租约。服务队列按会话串行执行，授权可在任一端处理。关闭窗口、断开连接或切换 harness 只移除客户端连接，已经提交的任务继续运行。服务空闲回收 worker，下一次操作原生加载。

客户端取消代际防止迟到结果覆盖新会话；服务取消使当时排队的请求失效。服务保存轮次正文、授权状态与 Diff，客户端重新附着可以获得一致状态。桌面通过可选增量订阅复用未变化条目；Telegram 权限订阅只传授权信息。增量基线失效时重新订阅获得全量状态，不重放任务。删除会话由 daemon 处置运行时并提交 tombstone；清空会停止全部 harness 的任务。关闭 persistHistory 只隐藏这个客户端的历史和活动指针，服务仍持久化。

selectedHarness 和活动指针按工作区保存；非 Pi 指针使用 `harness.<id>.*`。草稿和附件按 harness 暂存，切换时不跨供应商搬运。生成、连接或分支期间拒绝切换。`ActiveConversation` 集中持有 UI state、agent、cwd、conversationId、contextWindow、generation 和 contextAbort；会话身份通过 reset / replace 更新，统一清理连接和取消资源；迟到的启动 / 分支失败按代际过滤，不会恢复已经删除的会话。Provider 只暴露这些字段的读取视图，协调器不引用 extension.ts。UI 内容仍按现有增量编码流程更新。

`ConversationLifecycle` 管理 idle/transition/turn/disposed、取消和请求门控。handler 表声明 run / gated / navigation；`ChatProvider.perform` 先验证统一参数 schema，再在等待历史初始化前调用 lifecycle.acquire，finally 调用 release。选择当前忙碌会话、后台轮次导航、迟到请求与门控恢复的规则均由 lifecycle 负责；导航失败恢复旧轮次及其取消标记，已完成轮次和旧代际不会被恢复。取消、授权和状态查询不受此互斥标记阻挡。

## 持久化与偏好

所有 harness 的历史统一保存到数据目录 `history/index.json` 和 `history/conversations/`。只有持有 service.lock 的 daemon 写入，由进程内 mutex 串行事务；没有 TS/Rust 的 history.lock 或会话锁兼容协议。快照先 durable 写入，再 durable 提交索引，最后清理旧快照。文件和目录均 fsync，快照 revision 与 tombstone 防止陈旧写入及删除复活。损坏或不兼容格式拒绝读取，不自动修复或迁移。

偏好统一保存到数据目录 `preferences/{pi,codex,claude}.json`，只继承最近成功使用的 model/thinking，按 harness 隔离。新建读取最新组合，顺序为 model → 刷新选项 → thinking。成功修改设置或实际发送才更新偏好；浏览/恢复旧会话不覆盖账户默认。不继承授权或协作模式。损坏文件拒绝覆盖。

客户端仍保存可见模型、价格与去重用量等界面偏好；这些不决定 worker 生命周期或共享正文。原生历史仍由各上游适配器管理，备份需要保留原生会话和 daemon 数据目录。

计费默认价来自 Pi 的 `get_available_models` RPC 模型 `cost` 字段，通过 inspect 返回给客户端；客户端刷新时替换默认价格快照，不维护静态价格表。用户价格单独持久化并优先于 Pi 默认价，恢复默认删除覆盖；缺失价格保留未定价状态。适配器的所有 Pi 启动入口共用 `pi-command.ts`，每次按显式覆盖、PATH、账户托管安装和实际 npm prefix 查找可执行文件，避免缓存旧安装路径。

## 异常隔离

release 使用 `panic = "unwind"`。同步短临界区通过 `pi-acp-core::sync::MutexExt::lock_unpoisoned()` 取得锁，锁中毒不会让后续访问再次 panic；Tokio 异步锁沿用其自身语义。取回锁不等于修复状态，恢复由相应操作边界负责。worker 更新、授权回调和会话操作边界捕获 panic，关闭对应 worker，不自动重放任务；持锁异常恢复该会话最近已提交快照。ACP 响应进入可变状态前检查结构，配置、历史索引、偏好与 Telegram 状态使用 serde 类型校验。此保护针对 worker 操作，不保证任意进程级故障都可恢复。

## 其他边界

socket 不监听公网，只允许同服务器账户使用；当前部署支持 Linux x86_64，需要单独部署 daemon，插件不自动启动或安装服务。Telegram 可打开三种 harness 的已有会话，`/new` 默认创建 Pi。Telegram 通过 `events.next` / `events.ack` 消费持久化 outbox，不读取或删除会话服务的文件。relay 可使用独立数据目录，通过 `serviceSocket` 指向服务 socket。

协议分块、请求 fingerprint 与原生分支哈希仍遵守 UTF-16/canonical JSON 契约，详见 [service-protocol.md](service-protocol.md) 和 [data-formats.md](data-formats.md)。适配器自身的 native fork 锁与 daemon 单实例锁各有独立职责，不应因删除客户端历史锁而移除。

## 接入退避与构建边界

socket 最多 32 个连接；满额时记录日志，在有界时间内读取首个请求并返回关联 ID 的 busy 错误，然后关闭连接。accept 系统错误与满额拒绝都退避 100 ms，关闭信号可打断等待；正常连接按原有 reader / writer / emit 任务处理。具体帧及大小限制见 [Wire 协议](service-protocol.md)。

增强适配器在 `scripts/build-adapter.mjs` 对固定版本 pi-acp 的 bundle 应用严格断言补丁，运行逻辑保存在 adapter-store、pi-enhancements、pi-native-fork 等 TS 模块。`pi-rpc-types.ts` 描述注入边界消费的最小 RPC 字段，不替代运行时校验。升级流程见 [贡献指南](../CONTRIBUTING.md#升级内置-pi-acp)。

Tokio 按 crate 显式声明所需 feature，release 保持 unwind。JS / Rust 的生产产物与 contract-test 构建分离；入口、缓存、CI 及验证命令见 [测试](testing.md) 和 [发布](service-release.md)。
