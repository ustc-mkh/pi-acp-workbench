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

| 模块                                                                               | 职责                                                           |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `protocol.rs` / `session-protocol.generated.ts`                                    | serde 边界与 ts-rs 生成的客户端协议                            |
| `service/worker_pool.rs`                                                           | 按 harness 选择 worker、能力协商、原生加载、闲置回收           |
| `service/session_ops.rs`                                                           | 创建、状态、设置、删除                                         |
| `service/turn.rs` / `phase.rs`                                                     | 轮次执行、授权、取消、分支、终态保存                           |
| `queue.rs` / `journal.rs`                                                          | 会话串行、全局容量、取消代际、持久化防重放收据                 |
| `history.rs` / `prefs.rs` / `diff.rs`                                              | 服务独占历史、按 harness 偏好、工作区净变化                    |
| `conversation-session.ts` / `conversation-turn.ts` / `conversation-attachments.ts` | 会话选择与启动、轮次操作、附件与导出协调器；共用 Provider 状态 |
| `bridge/commands.rs`                                                               | Telegram 命令解析、分发与会话权限检查                          |
| `outbox.rs` / `outbox_reader.rs`                                                   | 持久化事件、socket 分页读取与版本确认                          |
| `conversation-history.ts`                                                          | socket 历史读取、轮询、删除、失效代际；无磁盘事务              |
| `conversation-statistics.ts`                                                       | 客户端用量分页、价格、标题与迟到结果过滤                       |
| `workspace-documents.ts`                                                           | Diff 预览、文档缓存、链接真实路径校验                          |

## Harness 与能力边界

worker 配置统一放在 `sessions.json`，可用 `harnesses.pi/codex/claude` 分别覆盖 command/args/env。顶层 command/args/env 为 Pi 配置；未配置的 Codex/Claude 分别从服务 PATH 启动 `codex-acp` / `claude-agent-acp`。不自动安装适配器，也不继承 Pi 专属环境覆盖。凭据归上游工具管理，登录按钮仅打开登录终端。

每个 harness 的 `hello` 返回实际 ACP `initialize` 结果，并添加 `_meta['session-service']={version:3,authoritative:true}`。能力首次探测会短暂启动 worker，后续在服务生命周期内缓存；配置更新需重启服务。图片、配置选择器、原生加载按上游声明处理。Pi 的 inspect/nativeFork 扩展只在适配器实际声明时开放；Codex/Claude 不伪造 Pi 专用统计或分支能力。Codex collaboration mode 保持 default，fast mode 按上游能力提供。

Pi 使用原生 ID；其他 harness 使用 `workbench:<harness>:<encodeURIComponent(nativeId)>`。Rust ACP 请求边界统一还原出站 ID、为通知和授权加入命名空间。快照必须显式记录匹配的 harness，不通过 ID 推断缺失元数据。编号、队列、删除和收据使用本地 ID。

## 会话生命周期

首次打开无历史时仅显示欢迎页；显式新建才调用 create。活动指针触发恢复，浏览已有历史读取服务状态，不为浏览启动工作进程。冷会话在发送、修改设置或分支时请求上游 session/load；加载失败保留原 ID 和快照，不重放提示词、不自动新建。无 loadSession 能力的历史只读展示。

多个桌面/Telegram 客户端可以附着同一个会话，没有客户端独占文件租约。服务队列按会话串行执行，授权可在任一端处理。关闭窗口、断开连接或切换 harness 只移除客户端连接，已经提交的任务继续运行。服务空闲回收 worker，下一次操作原生加载。

客户端取消代际防止迟到结果覆盖新会话；服务取消使当时排队的请求失效。服务保存轮次正文、授权状态与 Diff，客户端重新附着可以获得一致状态。删除会话由 daemon 处置运行时并提交 tombstone；清空会停止全部 harness 的任务。关闭 persistHistory 只隐藏这个客户端的历史和活动指针，服务仍持久化。

selectedHarness 和活动指针按工作区保存；非 Pi 指针使用 `harness.<id>.*`。草稿和附件按 harness 暂存，切换时不跨供应商搬运。生成、连接或分支期间拒绝切换。`ConversationLifecycle` 管理 idle/transition/turn/disposed 和取消状态。

## 持久化与偏好

所有 harness 的历史统一保存到数据目录 `history/index.json` 和 `history/conversations/`。只有持有 service.lock 的 daemon 写入，由进程内 mutex 串行事务；没有 TS/Rust 的 history.lock 或会话锁兼容协议。快照先 durable 写入，再 durable 提交索引，最后清理旧快照。文件和目录均 fsync，快照 revision 与 tombstone 防止陈旧写入及删除复活。损坏或不兼容格式拒绝读取，不自动修复或迁移。

偏好统一保存到数据目录 `preferences/{pi,codex,claude}.json`，只继承最近成功使用的 model/thinking，按 harness 隔离。新建读取最新组合，顺序为 model → 刷新选项 → thinking。成功修改设置或实际发送才更新偏好；浏览/恢复旧会话不覆盖账户默认。不继承授权或协作模式。损坏文件拒绝覆盖。

客户端仍保存可见模型、价格与去重用量等界面偏好；这些不决定 worker 生命周期或共享正文。原生历史仍由各上游适配器管理，备份需要保留原生会话和 daemon 数据目录。

## 异常隔离

release 使用 panic unwind。worker 更新、授权回调和会话操作边界捕获 panic，关闭对应 worker，不自动重放任务；持锁异常恢复该会话最近已提交快照。ACP 响应进入可变状态前检查结构，配置、历史索引、偏好与 Telegram 状态使用 serde 类型校验。此保护针对 worker 操作，不保证任意进程级故障都可恢复。

## 其他边界

socket 不监听公网，只允许同服务器账户使用；当前部署支持 Linux x86_64，需要单独部署 daemon，插件不自动启动或安装服务。Telegram 可打开三种 harness 的已有会话，`/new` 默认创建 Pi。Telegram 通过 `events.next` / `events.ack` 消费持久化 outbox，不读取或删除会话服务的文件。relay 可使用独立数据目录，通过 `serviceSocket` 指向服务 socket。

协议分块、请求 fingerprint 与原生分支哈希仍遵守 UTF-16/canonical JSON 契约，详见 [service-protocol.md](service-protocol.md) 和 [data-formats.md](data-formats.md)。适配器自身的 native fork 锁与 daemon 单实例锁各有独立职责，不应因删除客户端历史锁而移除。
