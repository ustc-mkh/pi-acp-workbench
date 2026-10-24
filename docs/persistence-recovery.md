# 持久化提交与恢复契约（workbench format 3 / IPC v3）

本页描述当前单宿主与 SQLite 增量存储，不描述旧 JSON reader、双 daemon 或 native 数据自动迁移。剩余功能差异与验收要求统一见[下一版重构计划](workbench-next-rewrite-plan.md)。

P2：prompt 为有序 text/context/image parts；operation 指纹覆盖原始 parts 身份与顺序。图片输入在 writer 外有界完整解码并重编码为静态 PNG，归档使用清理后的描述符及原 asset ID；每个有限输入 part 都有正确 entry/seq 的不可变 input delivery intent，输入/归档/Accepted 同事务。草稿仅在原 operation + generation 接受且未改变时清除。通用 select 设置持久 prepare/restore，观察确认后才提交偏好；失败/未知不保存，显式 discovery 可恢复旧 baseline，但不重发原操作。`provider_preferences` 与成功观察/settle 同事务，只含最近 model/thinking，Fast 不成为全局默认，新会话读取、已有会话优先。当前 root 必须含该新表，旧实验 root 明确拒绝，禁止隐式迁移/清空。

P3：仅协商过的 Pi workbench v1 显式 start/finish 创建自主 turn；live run ID 与 worker epoch/turn 一起隔离迟到输出。自主 start 与并发输入在 actor commit 处串行化；provider 最后一刻抢占时，已 Accepted 的输入保留并原子写入独立 rejected marker，不冒充已执行，不回滚 receipt。finish 的本轮 assistant usage 更新独立 usage fact；已删除 native-file tail 计费路径，避免上一轮/新唤醒串账。授权、完成/停止通知复用现有持久链；重启只恢复冷历史及原 receipt，不自动续跑。自主 Diff 明确 unavailable，worker 存活期 gate 仍保护 undo；Pi 尚无可信后台 pin 释放证据，idle worker 保守不回收。显式 stop/remove/shutdown 物理 join 后释放容量；不以超时推断无后台工作。

## Durable ordering

| 组件              | 提交顺序与故障行为                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operation journal | create 的指纹检查、session 与 terminal receipt 同一事务；冷 model/mode 和纯本地 management 不预写 Started，状态（可为空）与 terminal receipt 同事务。成功 no-op 只提交 receipt，不增 revision、不发 batch；删除源会话后仍可查询/重放原 operation，同 ID 异参拒绝。prompt 的输入/turn/delivery 与 Accepted receipt 同一事务，provider dispatch 在其后；容量/dispatch 失败记任务失败，不回退 Accepted。warm configure、prompt/answer、cancel/remove、native fork/cancel-fork、外部 management/context、undo 仍保留 Started/prepare；Started 只表示可能执行，未知结果不自动重执行。 |
| Session commit    | owner 计算小型 typed Transition，数据库检验 revision CAS，在一个 SQLite 事务内提交 view/entry/tool/content/interaction/notice 及 delivery intent，成功后更新热状态并发布；不是全历史拷贝或完整事件 replay。                                                                                                                                                                                                                                                                                                                                                                      |
| Revision          | session identity/cwd 必须保持；低 revision、同 revision 内容冲突、不兼容格式或无效 ID 拒绝。Cold inspect/list/history 不创建 worker，不进行 native load。                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Delivery          | 不可变内容引用与 manifest；durable admission sequence 决定 FIFO，不用跨源 revision 当时钟。ack 保留 dedup tombstone，满容量时保留未投递 intent；同 topic backoff head 不越过，最多八 lane。                                                                                                                                                                                                                                                                                                                                                                                      |
| Remove            | 先停止并物理 join worker、drain owner；持久删除会话可见状态，既有归档与待投递依据保留。投递仍复核当前 binding/chat/workspace 授权。不会递归删除 native provider 历史。                                                                                                                                                                                                                                                                                                                                                                                                           |
| Telegram inbox    | update offset、冻结 command 分类、callback consumption 原子提交；失败/重启不将旧 answer 重新解释为 prompt；可靠控制回复持久后 inbox complete。                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Cancel/config     | 远端动作前持久中间阶段；停止/配置与最终 commit 失败不能谎报成功；epoch/turn fence 拒绝旧事件。所有 accepted 写入和 worker physical join 后才释放 host lease。                                                                                                                                                                                                                                                                                                                                                                                                                    |

共享历史清空先在一个事务中冻结筛选命中集、活跃 session 与 pending delivery 数并封存预览；批次最多10个 session。每个目标复用 Remove 流程的 stop/join 与 durable operation，完成后单独保存 removed/failed 结果；job 可查询并继续未完成目标。清空不撤销已计划 delivery，不删除 native 文件、usage、operation receipt、dedup identity 或归档内容。终态 turn outcome/diff 行数在会话源删除前冻结，Telegram Turn delivery 页可在删除后发送完成摘要。

Telegram topic preferences 的绝对值设置（`notifications` / `silent`）与不可变控制回复在同一 SQLite 事务提交；随后 outbox enqueue / inbox complete 可重启补齐。重放原 inbox ID 只返回原回复，不把旧开关再次应用到新设置上；同 ID 不同分类/话题拒绝。自动成功正文/图片在投递时依当前设置跳过并 ack，授权/错误/主动查询不受 notifications 开关影响；这不是 Agent cancel 或归档删除。当前 schema 必须含 `telegram_topic_preferences`，缺表/列的旧实验 root 拒绝，不隐式迁移或清空。

Telegram `/menu` 将文本、typed choices、expected binding 和 10 分钟期限冻结为不可变回复，再入现有 outbox；重试复用原 archive 与 deterministic callback key，不重新按新状态生成旧回复。按钮由 `CallbackAction::Control` 进入同一 admission/operation 执行链；SQL 同事务复核冻结 command/binding、消费 key 并更新 offset/inbox。过期、权限/目录变化、重绑或重复点击是拒绝，不消费成另一命令。菜单在线回收每次最多 128 个过期 Control keys，保护 Pending 引用，不清理授权 Answer keys；最多 3072 菜单 keys / 4096 总 keys。当前 schema 还必须含 `telegram_callbacks.action_kind` 及新 typed body；旧实验 root 拒绝，不迁移/reset。

Telegram 目录选择沿用上述不可变菜单/typed Control callback，不另存第二份目录树或创建状态。目录/Harness 选择冻结 canonical cwd；New 在 admission 及执行前复核当前授权，canonical identity 变化时不发起建 topic/create session 副作用。浏览只读目录名、不读文件正文，不写 core operation、不启动 provider；没有跨用户翻页持有目录 FD 或 filesystem snapshot。目录页新增 enum variants，但未新增 SQL 表/列或 IPC 方法；旧 binary 不应打开更新后的 root。

Telegram history 导出事务：核对冻结 inbox action/topic 与当前 binding/canonical cwd，raw scan 每批最多 2000 条元数据，visible segments 独立限制为 recent 20 / all 100，每组最多200 entries；选择 eligible entries，既有 outbox intent、`telegram_history_cursors` 与不可变 request receipt 同事务提交。每条导出 identity 来自 bot/topic/session/entry，Acked/Pending 都不重复入队；游标表示可靠入队，而非 HTTP 已成功。回复 enqueue/inbox complete 可重启补齐原收据，不取新的批次。显式导出正文只保留一片64KiB slice/4000 UTF-16 part，复用不可变图片；部分发送与 ack 前崩溃仍可重复。权限/目录暂不可用时保留 Pending/backoff，不丢已计划的历史；恢复范围后原意图可继续，同 topic head 仍是屏障。自动 Turn 完整发送后，ack 与实际 bot/chat/thread/session 收据在同事务提交，复用原 manifest 作为正文/图片证据；mute/范围拒绝等 skip ack 不写成功发送收据。History 预订及发送前均复核，Turn 分页按≤100个显式导出 ID 查询 Acked，双向避免已确认正文重发。全量正文此前已导出时仍投递可靠完成提示。HTTP 成功但 ack 提交失败时，内存恢复缓存携带原话题，不因重绑记成新目的地；进程丢失缓存仍按 at-least-once 重试。新必需表缺失的旧实验 root 明确拒绝，不迁移/reset。

IPC numeric request ID 只关联连接响应；durable operation 才负责跨连接/重启防重。断开、超时和取消 observer 不证明副作用撤销，不自动换 operation 重发。普通 query 不写 journal；image query 禁止 operation，pixels 只在专用 response 返回；typed image prompt 输入允许专用有界 asset part，不进入 SessionView。当前 UI 已持久化有界未决 handles 并在 reload 后只读查询，不保存命令正文、不重发；Started 查询保守为 uncertain，不暗示实际执行阶段。

## 数据与查询预算

ACP stdio 的普通 JSON payload 上限 2 MiB（不含换行），仅 `session/update` 的 agent image chunk 可使用 `ceil(4 MiB / 3) * 4 + 64 KiB` 大帧；大帧还需满足 raw image ≤4 MiB、有效 base64/媒体身份及非 data envelope ≤64 KiB。IPC 仍为 8 MiB。普通文本/tool 不借图片通道放大；100,000 Unicode scalar prompt（包括中文、emoji、JSON 转义）可落入普通帧。出站超限在入 worker mailbox 前拒绝，不写 stdio 或杀 worker；入站超限作为明确 provider 任务失败。完整解码/像素与帧数 sanitization 仍属后续媒体安全工作，不以 signature/hash 验证替代。worker capacity、mailbox full、mailbox closed、provider unsupported 分别诊断，容量周转另在 P1 实现。

业务表位于 `workbench.sqlite3`，启用 WAL、外键与 `synchronous=FULL`；format marker 和 schema version 不兼容时拒绝。当前数据库使用一个专用 writer 和两个固定只读线程；writer 队列 256，每 reader 队列 128。list/history/tools/content/image、attach、dispatch snapshot 与 operation status 走 reader；原子 admission、状态、receipt 和投递确认仍走 writer。attach 的 view+page、dispatch 的 heads+binding 各自使用短事务快照。所有 SQLite 工作均在这些专用线程执行；关闭先停止接受，再 drain 并物理 join 全部线程后释放 lease。完整发布性能与资源门槛见[下一版计划](workbench-next-rewrite-plan.md)，读写隔离本身不是SLO已通过的证据。

List/history/tools 分页、正文 UTF-8 slices 和冷查询均已实现，不需全历史载入内存。attach 的 view + recent page、delivery dispatch 的 heads + binding 使用短事务快照。普通页/批完整 JSON envelope ≤1 MiB，view ≤512 KiB，inline text ≤16 KiB，content slice ≤64 KiB；单正文 ≤64 MiB。可见 UI 条目窗口不等于全部历史范围。超大 metadata 返回 typed TooLarge，不用空页无限循环。数字必须是 JS safe integer。

正文和图片按不可变 descriptor/hash 校验。图片另校验 MIME、size、identity、signature；这不是完整解码或 sanitization。工具 URI/path/terminal reference 本身不授权 fetch/read/exec。不要把输出图片读取误称为输入图片支持。

Multipart 投递为 at-least-once：部分发送成功、取消或响应未知时重试可能重复先前 parts，但不会重跑 Agent。

## 生命周期、离线维护与保留

停止接受 → drain accepted writes → 关闭连接并物理 join → 释放 host-wide flock。取消 shutdown observer 不改变该顺序。锁文件持续存在正常；不能 unlink `.workbench.lock` 绕过 lease。

正常启动不自动迁移、reset 或扫描删除 orphan。已有 format 2 / 未版本化非空 root 拒绝；不以清空真实数据解决切换。默认用隔离 root 验收，实际切换前整组备份 binary/配置/root 与需要的 native 文件，回退也整组回退，旧 binary 不得打开新 schema。

同 binary 的显式 export、marker-only reset 与 typed Telegram SQL GC 见 [存储维护](workbench-storage.md)。GC 仅原子删除 completed inbox 与不被 pending inbox 引用的 expired callbacks；离线 content GC 另按500行为限分批删除无 entry 引用且无 `archive_roots` pin 的 content。普通文本保守永久 pin；delivery 文本/image 有 archive root，故当前不宣称通用 archive retention 或自动回收已引用 content。保留 offset 与未过期 consumed bindings。Journal expire 保留 tombstone；不可通过手动删收据使旧 operation 再次执行。

## 验证入口与边界

- `cargo test --manifest-path rust/Cargo.toml --workspace`：SQL 原子增量、CAS、分页/预算、actor 故障、replay、cancel/config、joined cleanup。
- `npm run test:workbench:storage`：实际 binary 的确认、flock、私有 byte export、symlink/overlap、marker-only reset、corrupt-state refusal。
- `npm run test:workbench:process-loss`：实际宿主 SIGKILL + synthetic peers；fixture 只显式移除自己隔离 root 的死 socket。不是在线 provider 测试，也不证明任意 descendants 清理。
- `npm run test:contract:workbench` / `npm run test:contract:workbench:telegram`：真实 daemon + synthetic ACP/local mock Bot，不替代真实模型/Bot。
- [下一版重构计划](workbench-next-rewrite-plan.md)统一定义mixed benchmark、长期故障与真实环境验收要求；原始运行证据放 `.test-results/`，不以历史通过结果代替当前源码验证。
