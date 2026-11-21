# 架构与实现

`pi-acp-workbenchd` 是唯一控制进程。VS Code 经 Unix socket IPC v3 接入，Telegram adapter 在宿主内调用同一 app/domain；Pi、Codex、Claude ACP worker 是独立外部子进程。

## 模块职责

| 模块                                 | 职责                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Rust `domain/`                       | 领域类型、命令、事件、纯 reducer 和验证                                                                             |
| `actor*`、`actor_registry`           | 串行状态所有权、冷加载、路由、热会话预算                                                                            |
| `app_prompt`、`app_worker_lifecycle` | 输入预处理与派发、worker 发现/观察/停止                                                                             |
| `worker`、`task_scope`               | 子进程预算、启动、取消和等待退出                                                                                    |
| `acp/`                               | 强类型协议转换、RPC 关联及明确的不透明扩展边界                                                                      |
| `persistence/`                       | SQLite 事务、归档、回执、查询与维护                                                                                 |
| `telegram/`、`transport/vscode`      | 入口授权、输入与输出适配                                                                                            |
| TS `src/workbench-*`                 | IPC 客户端与会话视图。`controller` 协调授权，`undo` 管理撤回确认，`operations` 管理持久回执                         |
| `webview/`                           | 主入口组装界面。`history-view` 渲染对话历史，`submissions` 确认草稿提交，`image-view` 和 `diff-view` 展示图片与变更 |

Session actor 是领域热态、worker epoch、pending intent 的唯一 owner。provider 完成消息携带 session/epoch/turn，验证后才能提交。客户端只维护有界显示视图，不保存第二套领域状态。

## 持久化与操作回执

SQLite 使用固定 writer/reader 预算。状态变化、操作回执和必要投递意图按事务提交；读取历史、统计或导出不创建 provider。

| 操作                                               | 提交方式                                            | 恢复行为                            |
| -------------------------------------------------- | --------------------------------------------------- | ----------------------------------- |
| 本地创建、元数据、设置                             | 变化与终态回执同事务                                | 同 operation 同参数返回原结果       |
| prompt/answer                                      | 输入、接受回执和必要投递意图持久化后派发            | Accepted 表示接受，执行结果另行记录 |
| provider 设置、native fork、外部 context、创建话题 | prepare → 远端尝试 → 观察 → settle                  | 未知结果保留 uncertain，不自动重发  |
| cancel/remove/undo                                 | 持久围栏或准备 → 等待进程/文件副作用完成 → 持久结果 | 查询原回执；停止不代表副作用回滚    |

operation ID 跨连接和重启防重；同 ID 不同参数拒绝，过期回执保留 tombstone。request ID 只用于连接内响应关联。断线、超时或取消观察者不撤销已接受操作。

消息 entry 不可变；完整正文、图片和投递 manifest 使用有类型的引用与哈希。相邻消息片段只有在 turn、role、provider message ID 和顺序连续时才拼接。原生恢复/分支保留真实身份和上下文，不用文本重播或摘要替代。

删除会话前停止其 worker；可见会话和 Diff 删除后，历史归档、已计划投递、用量和去重身份仍可能保留。共享清理冻结目标集，每批最多 10 个会话，逐项保存结果；删除不等于安全擦除 SQLite/WAL 字节。

## 生命周期与恢复

worker、热会话、mailbox、在途操作和媒体分别有容量上限。回收先隔离旧事件，再停止并等待实际进程退出，最后复用槽位；活跃任务、交互、配置、分支和标题工作受到保护。驻留期限见 [VS Code](workbench-vscode.md)。

文件/数据库事务由独立 owner 持有，不随外部观察者取消而丢失。关闭服务时等待已接受写入及子任务完成，最后释放存储 lease。重启不会自动重放工具或未知远端操作；Pi context 的待应用 revision 在下一次明确使用时对齐。

提交后 actor 发布带 revision 的 CommitBatch。客户端忽略重复 revision，出现缺口或断线时重新 attach 获取视图；不重发 mutation，不轮询重建完整历史。

Telegram 接收 offset、分类输入与按钮消费同事务提交。发送基于不可变 outbox/manifest，按话题 FIFO、最多 8 路并行；HTTP 重试不重新运行 Agent。发送成功与数据库确认之间无法原子提交，因此投递为 at-least-once。

## 资源与访问边界

工作区输入、设置和文件操作检查当前信任及规范化路径包含关系。消息中的路径、URI 和 terminal metadata 不授权读取或执行。浏览器使用 CSP 与净化 Markdown，显式链接和附件经宿主处理。

正文和图片以有界分页/分片读取，分别计算 UTF-8、base64、JSON 和 Telegram UTF-16 预算。输入图片由宿主完整解码；归档分片的全内容哈希需在拼接完成后验证，不能单独证明任意一片完整可信。

SQLite writer 在请求之间检查 WAL，达到逻辑阈值时尝试 RESTART checkpoint，忙读者保留快照并延后重试；不会每次截断文件或在线 VACUUM。具体协议见 [IPC v3](workbench-ipc.md)，维护命令见[存储维护](workbench-storage.md)。

## 界面契约与归档读取

宿主到 Webview 的所有消息由 `workbench-ui.ts` 的 `uiMessage` 统一解析，消息、状态和回执类型从 schema 推导。UI 模块接收已验证消息，继续按当前会话、operation 和草稿 generation 检查过期响应。持久回执恢复只查询结果，不重新发送命令。

历史视图按当前会话缓存消息投影、Markdown 和长文本分页。切换会话时，它清空消息节点与缓存，断开可见性观察器并取消待执行的动画帧。归档正文响应携带会话 ID，视图只接收当前会话的响应。实现位于 `webview/workbench-history-view.ts`。

SQLite 的每个读取线程持有最多 4 份、正文及元数据分配容量合计最多 48 MiB 的 Diff 解码缓存（两个读取线程合计最多 96 MiB，不含当前请求临时分配）。命中时只查询归档身份是否仍存在，避免会话删除后返回旧缓存；缺失结果不缓存。摘要只复制当页元数据，不复制 before/after 正文，分片复用不可变正文。该优化不改变数据库格式；首次读取、淘汰后读取或超预算归档仍需完整解码。完整 Undo 读取仍返回独立快照。
