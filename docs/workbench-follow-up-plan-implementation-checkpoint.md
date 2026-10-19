> 历史归档：以下为本轮细节审查前的实施计划与执行声明，原样保留以供追溯；其中基线、阶段描述和“本轮”证据可能混杂，不能作为当前发布结论。当前唯一执行计划是 [workbench-follow-up-plan.md](workbench-follow-up-plan.md)。

# Workbench 后续调整：T04 后独立复核与修订执行计划

> **本文件为当前唯一有效实施顺序。** 原 T01–T04 的完整执行记录及旧版 T05–T11 已保存在 [T04 checkpoint](workbench-follow-up-plan-t04-checkpoint.md)，其中未执行的后续步骤已被本文件替代，不能继续照旧顺序机械实施。
>
> 复核基线：`7dd542d`，实现截止 `af66421`。T01–T04 的持久化切换基本符合原计划，功能验收通过；**架构简化和性能目标已按本计划实现；当前工作区门禁已完成**。

## 1. 独立复核结论

### 1.1 已完成、应保留的设计

- T01：CI 已使用当前入口和显式生产 binary，发布文档校验已修正，runner 有对应测试。
- T02：强类型 v3 查询/写集/预算已有定义，但生产 wire 仍为 v2，不能把类型测试当成已切换。
- T03：一个 SQLite 执行线程/Connection、有界队列、WAL/FULL、lease、版本拒绝、observer 与事务所有权分离均已实现。
- T04：journal/payload/outbox/session/Telegram 均接入同一个 Database；状态、archive 与 delivery intent 同事务；旧 history/io/ledger/project_outbox 已删除。没有发现生产双 backend、旧格式 reader 或任意 SQL 业务入口。
- 保留 StoreRequest enum、typed SQL、少量 facade、原始操作回执、epoch 栅栏、两阶段 cancel、真实 worker join、topic FIFO。这些不是应该为减少行数而删除的冗余。

### 1.2 本轮重新执行的验证

`npm run test:rewrite` 全通过：Rust 266 daemon 单元测试（另1项 SDK 默认 ignored）与 2 core、TS 30文件/188项、runner、IPC v3、Telegram、实际 SIGKILL、Chromium、GNU生产构建/打包/artifact smoke；随后新增的 WAL、scale、startup、musl artifact、offline SDK 和 600秒 soak 也已单独通过。

日志：`/tmp/workbench-t04-review/rewrite.log`；suite报告：`.test-results/run-CX8MXd/`。本轮 musl、offline SDK、最终规模/soak 均已执行；证据路径见 T10/T11 记录。

### 1.3 为什么实现变复杂

持久化目录非测试代码由基线 `af6d138` 的 **10文件/1,856行** 增至 **18文件/4,359行**（含 schema.sql，不含测试）。这不是自动证明设计错误，但说明简化收益目前尚未兑现。

| 类别           | 当前路径                                                           | 判断/处理                                                                                     |
| -------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| 计划内临时桥   | `commit.rs::between/validate_prefix`、`session_state.rs`           | 从完整历史算差量、再从SQL重建完整历史。必须删除，不再优化桥接                                 |
| 重复状态/写集  | SessionState/SessionSnapshot/SessionView；Transition/SessionCommit | 下一切换合并到一个热状态和一个提交写集，禁止继续加转换器                                      |
| 非临时全量热点 | `telegram_sql.rs::load/save/execute`、`inbox.rs::apply`            | 每次pending/offset/ack等操作读全部历史inbox，再clone/序列化/diff。原计划漏列，立即改为定向SQL |
| 非临时查询热点 | `delivery.rs::selected` topic分支                                  | json_each + effective相关子查询，不随结果窗口有界。立即替换查询，不改调度算法                 |
| 文档过程成本   | 近500行计划大半是中间阶段日志                                      | 旧记录归档；以后每项只写最终commit/命令/结果，不再追加每次修编译错误的长日志                  |

### 1.4 需要修正的具体问题

**R1 / P1：topic-head查询会长时间占据唯一数据库线程。**

位置：`persistence/delivery.rs::selected`，`telegram/delivery_scheduler.rs` 约100ms周期触发扫描。当前在全部Pending上按动态topic运行相关反连接，并反复解析bindings JSON。

从实际源码提取SQL，在独立SQLite 3.51.2、每topic一条Pending的微基准：

| 独立topic数 | 当前SQL    | 先target-head再topic合并原型 |
| ----------- | ---------- | ---------------------------- |
| 30          | 4.95ms     | 0.257ms                      |
| 60          | 36.24ms    | 0.243ms                      |
| 100         | 157.44ms   | 0.322ms                      |
| 200         | 1,253.42ms | 0.451ms                      |

这是隔离SQL实验，不是生产端到端基准。查询原型还验证了Session/direct target合并及deferred head不被越过。脚本和日志暂存 `/tmp/workbench-t04-review/topic-query-proof.{py,log}`；实施时必须转为仓库内测试，不依赖临时文件存活。

**R2 / P1：Telegram保留的已完成历史参与每次普通操作。**

位置：`persistence/telegram_sql.rs:28–109,173–189`。Pending和Snapshot也先load全部inbox/callback；写操作还复制整个TelegramState，并序列化比较old/next。因为默认不GC，成本会持续增加，并堵住所有session的DB工作。不能用定时GC或加缓存掩盖。

**R3 / P1（原计划缺陷，尚非当前生产回归）：删除源后的投递与Turn范围方案冲突。**

当前Entries持久化entry IDs，因此删除源后仍能投递。旧T05/T09若直接改为依赖`session_entries`的Turn范围，而remove继续删除这些链接，重启后会丢失待投递内容。修订计划用独立不可变delivery_entries关系冻结引用，不依赖源session存活。

**R4 / P2：严格先T05再T06会诱发第二轮桥接。**

fork依赖完整SessionState，旧IPC/Telegram也消费完整快照。直接删历史再分别修它们，会制造full-state适配器来让中间版本过门禁。改成以下协调切换：先完成低风险SQL改进，然后热状态/fork一起切，再同时切wire/客户端/Telegram消费者。内部工作阶段允许暂时红测试，但最终提交必须完整，禁止写第二套生产兼容协议。

## 2. 固定设计与不做事项

1. 保持SQLite单库、一个数据库线程、bundled rusqlite 0.40.2，不重选ORM/连接池/actor框架。
2. 不为未发布v3 schema增加迁移链。schema变更后用新隔离root测试，旧内部root明确拒绝；不要擅自升级或删真实数据。
3. 只保留一个具体热状态结构`SessionView`，包含现有native/config/intent/catalogue/plan/usage/interactions/origin/revision/last_entry_seq等。actor直接持有它；最终删除旧SessionState和SessionSnapshot，而不是长期互转。测试不要求保留旧生产类型。
4. 只保留一个具体增量写集`Transition`：`expected_revision,next,contents,append,tool_updates,deliveries,view_changed`。store.commit直接接受它；删除重复SessionCommit struct，不增加泛型转换层。next为SessionView。
5. 每个改变状态的transition严格revision+1；每revision一个CommitBatch，先提交后发布。无变化不commit、不增revision。
6. 不把全部active-turn工具放入热状态。tool patch所需旧ToolHeader按 `(session,turn,tool_id)` 定向读取，作为只读TransitionContext输入纯reducer；正文以ContentRef合并，不从SQL读回大BLOB。会话lane保证读旧值到提交之间的顺序，revision CAS最终把关。
7. 新增`delivery_entries(delivery_id,seq,entry_id)`，PK(delivery_id,seq)，refs指向不可变entry和delivery；不随session删除。turn-finish事务中用`INSERT ... SELECT`冻结本turn Agent rows的有序引用。delivery renderer按此表分页。
8. 保留帧8MiB、普通页/batch1MiB、view512KiB、inline16KiB、content slice64KiB、单内容64MiB、图片4MiB、JS safe integer边界。所有wire预算按实际完整JSON字节。
9. 不重写现有execution/delivery八lane、control/query reserve、worker协议和凭证scrub。性能问题先减少数据库扫描，不加队列层数/缓存/线程。
10. operation、archive、Acked delivery保留；不自动过期防重记录。本轮GC只压缩已有范围的Telegram completed inbox与未引用expired callback。

## 3. 新执行顺序与任务

T01–T04保持完成。新增 **T04-R** 修正漏项；旧T05/T06合为 **T05/06**；旧T07/T08/T09改为 **T07/08/09** 协调交付。T10/T11继续保留，但按本文执行。

### T04-R1 [x] topic heads定向聚合：先target，再topic

**文件：** `persistence/{delivery,query,database}.rs`、`telegram/delivery_scheduler.rs`及delivery SQL tests。

1. 新typed请求`DispatchSnapshot { bot, limit } -> { bindings, heads }`，同一DB读取边界返回当前binding和heads。调用方不再把整个binding数组编码成JSON传回DB。
2. SQL分三层：Pending按target_key取MIN(order_seq) → 用telegram_bindings的 `(bot_id,session)` 唯一索引把Session target映射到当前topic → 按effective topic再取MIN(order_seq)，最后JOIN回delivery并按order_seq LIMIT。
3. 映射使用`b.session=substr(target_key,9)`并检查`session:`前缀，禁止对索引列`b.session`拼接后比较。direct Telegram target保持其冻结bot/chat/thread，不重写历史target。
4. 保留deferred head进入结果，不能提前按retry筛掉；scheduler仍决定是否ready，防止后续消息超车。不存在binding时按原target处理/ack，不改变授权规则。
5. 现有active lane变更binding屏障不删；snapshot里的bindings用于reserve，实际投递时仍复核目标。
6. 不同时维护Heads/All/TopicHeads三个生产查询方案：检查真实调用者，只保留所需的生产DispatchSnapshot和必要显式分页读取；纯测试用途的旧API转test helper或删除。
7. 只有EXPLAIN证明需要时才新增Pending partial index。不要为每条状态查询盲目加索引。

**验证：**在bundled SQLite上测30/100/200/1000topic、每topic1/100条、混合Session/direct、deferred/rebind/Acked积压；比较旧小样本oracle的结果。用SQLite VM step计数或查询扫描spy验证没有逐candidate全表相关扫描，时间只辅助报告。现有topic FIFO/独立topic进展/lease join测试全保留。

**运行：** `cargo test --manifest-path rust/Cargo.toml -p pi-acp-workbenchd delivery`、`npm run test:contract:workbench:telegram`、`npm run clippy`。

### T04-R2 [x] Telegram存储改为定向SQL，删除全量diff

**文件：** `persistence/{inbox,telegram_sql,database}.rs`、`persistence/schema.sql`、`telegram/{polling,runtime,execution_scheduler,delivery}.rs`。

1. 从生产API移除`TelegramStore::snapshot`全集读取。拆为`offset/bot`、单topic binding、单callback、bounded pending、dispatch snapshot；测试需要全集时用cfg(test)独立查询helper。
2. `pending(limit)`直接SQL WHERE status='Pending' ORDER BY update_id LIMIT；offset只查telegram_meta；binding只查目标/反向session唯一索引。
3. `admit`一个事务内：查offset判duplicate → 复核expected_binding → 检查Pending容量 → 查并校验该callback → 更新used_by/插入inbox/推进offset。失败整体rollback。不要先更新offset再在另一个事务存inbox。
4. `complete`只更新一条inbox；`register_callback`只读/写该key并验证immutable定义和used_by；claim/bind/unbind各有具体SQL。
5. compact在事务中先删completed inbox，再删不被pending引用的expired callback，保持offset和unexpired consumed binding。
6. 删除`load(all)`、`save(old,next)`、生产`apply(TelegramState)`、whole-state clone/JSON diff。纯callback/command验证提取小函数即可，不增加通用状态持久化框架。
7. 加入合适的 `(bot_id,status,update_id)` 索引；pending计数最多扫描到max_pending后停止，不能反复统计全部已完成行。SQL列与typed JSON身份校验保留，但只校验本次实际访问记录。

**验证：**预置100k Completed inbox + 当前Pending/callback；offset/dispatch/pending/complete路径读取Completed行数=0，admit不load全部callback。保留duplicate offset、used_by、expected_binding竞态、SQL ABORT、observer丢弃、bot身份与重启回归。

**通过标准：**R1/R2提交后生产路径不再持有TelegramState全集。`cargo test ... telegram`、`npm run test:contract:workbench:telegram`、`npm run test:rewrite`全部通过。不要为了保留旧测试而重新暴露生产snapshot。

### T04-R 验证记录

- 实现：`DispatchSnapshot` 同事务读取 bindings/heads；旧 Heads/All/TopicHeads 仅 cfg(test)，删除 json_each 查询；Telegram 全集类型/reader 仅 cfg(test)，删除生产 apply/load/save/diff。
- bundled SQLite：30/100/200/1000 topics × 1/100 backlog，与 Rust FIFO oracle 比较；deferred/rebind/direct/Acked 覆盖，无 CORRELATED plan，binding 使用 session 唯一索引。
- VM steps：每 topic 1 条分别 3,565 / 11,755 / 23,455 / 117,055；每 topic 100 条分别 55,525 / 184,955 / 369,855 / 1,849,055。
- 100k Completed poison rows：offset/pending/admit/complete/dispatch 不反序列化历史；无 Pending 查询 VM steps <50；不读取无关 callback；原 rollback/observer/restart 测试保留。
- `cargo test ... delivery`、`cargo test ... telegram`、`npm run clippy`、`npm run test:contract:workbench:telegram` 通过；`npm run test:rewrite` 全通过（含 GNU artifact）。日志 `/tmp/workbench-r1-r2-rewrite.log`。
- 未完成：T05/06 至 T11；本阶段不代表最终规模、musl、offline SDK 或 soak 验收，不可发布。

### T05/06-A [x] 一个热状态、一个写集，纯transition与原子commit

**文件：** `domain/{session,query,reducer,transition,tool}.rs`、`actor.rs`、`actor_registry.rs`、`persistence/{database,session,interface,query,commit,session_state}.rs`。

1. reducer改为`transition(view, command, context, now) -> Option<Transition>`，None表示无变化。NewEntry/ToolUpdate/notice/interaction/delivery intents在处理本命令时直接生成，不从前后历史diff。
2. Transition合并现有SessionCommit字段；actor只clone有硬预算的SessionView。tool old header从store定向读，context只读；大正文在新写集里，不进入next热状态。
3. actor：epoch/turn检查 → transition → 一次store.commit → 替换热状态 → 同步publish一个batch → 再接下一命令。失败不改状态/发布。
4. 当前批次内分配entry seq和revision，query::commit仍做scope/CAS/不可变content验证。删除“同revision重写成功”特殊分支；operation回放由journal负责，不通过重新调用session commit幂等。
5. 热load只读SessionView；冷inspect不建actor；registry list用summary页，不再load所有SessionState。
6. 在turn结束事务创建DeliveryPayload::Turn清单，写入delivery_entries归属。renderer尚未切换前不能删除旧Entries消费路径；这是同一schema内的typed调用改动，最终B交付时删旧生成分支，不新增JSON双reader。
7. image与text/entry/intent仍同事务。shutdown/cold-recovery/cancel/config-intent全部改为相同incremental contract。
8. 已有`commit.rs::between`、`validate_prefix`、`session_state.rs::load/list/save`和完整snapshot构造必须最终删除，不能改名保留。纯batch构造可移到transition或query模块，不为一个函数维持桥接文件。

**注意依赖：**本任务与下一项fork必须同一个切换分支完成。单元测试可先通过，consumer尚未切换导致的编译/fixture失败应记录，不能为临时绿灯编写full-state adapter。完整切换合并提交须通过Rust actor/app/fork全部测试。

**spy验收：**100k旧entries情况下，prompt/text/tool/cancel/load/view不访问旧entries和大工具正文；只允许append、按key读header和有界热state。late epoch写入=0，失败commit发布=0；100k历史不增加actor热内存。

### T05/06-B [x] fork改为流式证明和SQL adoption

**文件：** `domain/{fork,fork_messages}.rs`、`app_fork*.rs`、`actor_registry.rs`、`persistence/query.rs`。

1. source mutation lane独占仍保留；取native identity、source revision、requested entry seq，拒绝active turn/configuration intent。
2. 用两遍有界扫描而非收集vector：第一遍定位目标contiguous group并算digest；第二遍查同role group和其他单row歧义。SHA256更新按content slice读取，grouping按message/turn/role保持基线语义。
3. 保留非末delta、thought、图像group、重复全文、跨turn reuse、partial key等拒绝规则；不把provider message id当native id。
4. ForkPlan仅含scope/revision/entry_seq/target/new_session_id/origin；无snapshot/prefix正文。
5. 远端成功后同事务校验source revision、插入branch热状态、INSERT SELECT复制prefix links、复制严格早于切点turn的tools。contents/entries复用，source删除不cascade archive。
6. branch config/catalogue/plan/interactions/usage清空，native branch-point设置继续由native load恢复。one-worker join、fork cancel、uncertain/unadopted回执不能削弱。
7. 原vector算法只允许test-only oracle；对既有fixture和生成序列比较接受/拒绝及target，生产删除ForkProjection.snapshot/旧SessionState。

**完成边界：**A/B完成后内部actor/store/fork不再依赖完整历史；接下来直接做consumer切换，不为v2 wire再构造完整snapshot。

### T07/08/09-A [x] 同时切换宿主查询、事件、回执和消费者

**范围：** `transport/vscode.rs`、app query/return types、TS protocol/client/session/controller/ui/browser、Telegram status/list/render及全部contract fixture。这是一项协调交付，不要求旧客户端在中间提交可用。

#### 服务端

- wire只支持v3，删除v2 decoder；mutation回执只含Created/Forked summary、Loaded view、Accepted revision、Removed id等，不包含DomainEvent数组或历史。操作journal记录新的typed原始回执。
- list默认50/最大100，created_seq DESC，首请求固定max边界，SQL LIMIT/keyset；history默认100/最大200，seq DESC分页、页内升序。cursor校验version/session/bounds。
- tools按(session,turn,tool_id)分页；text/diff/resource内容只在header带ref。
- content slice默认/最大64KiB，offset为UTF-8字节边界，结尾裁到合法边界。不能每个slice读取整个64MiB。完整身份/hash在写入及归档验证边界保留，分片响应明确不声称仅靠whole hash验证了单片字节。
- 分页测完整JSON envelope预算，放不下的row留下一页；单metadata过大返回typed TooLarge，不死循环空页/EOF。图片保持4MiB原始上限及完整ref验证，允许8MiB图像帧。
- attach：先注册broadcast，再同一DB读取边界返回view/recent_page；buffer有界，丢弃≤snapshot revision，依次发后续batch。重复丢弃，gap/lag发resync并断开，不增加第二套event log。
- owner commit后、下一session命令前发布batch；无修改不推进revision。remove发布明确的终态revision，删除前持久保存该receipt所需值，不能用随意last+1猜值。

#### 前端

- WorkbenchSession只持有view和有界历史页；batch替换view/追加已确认headers，删除provisional/committed双份对账及50ms inspect timer。
- 删除mutation后全量list+inspect链。list只在显式refresh更新或利用create/fork/remove receipt局部更新。
- 不复制领域reducer；trust/realpath授权、服务端entry identity和ref校验保留；断连/缺口重新attach绝不自动重发mutation。
- 第一版用**显式“更早一页/更新一页”分页浏览**，最多显示200条。不实现可变高度虚拟滚动/上下占位算法：它不是解决数据边界必需，且容易引入新的UI状态bug。
- 内存最多1000 headers/4MiB；展开content最多256KiB/项，继续翻页不无限串接；图片cache按32MiB原始bytes LRU，销毁释放URL/observer。

#### Telegram

- /list读取summary页，/status读取view；plan仍只显式/status。不得为了旧render回建SessionSnapshot。
- turn投递改读delivery_entries，以delivery_id/seq分页；session删除后仍可渲染，frozen cwd/topic授权保持。
- 每次只生成一个UTF-16受限文本片段/一张image，禁止先展开整个turn为Vec<Part>。大组连续text按状态机逐片发送，保留顺序。
- 原Entries数组生成/Turn源session范围依赖删除；简单单Entry/Image/Interaction/Notice路径按实际调用保留，不保留无人调用的payload variants。
- preserve 429/retry/at-least-once、deferred head、八lane和physical join，不能用“只测最终文本”替代这些断言。

**全链硬测试：**42轮合法100k prompt、restart attach继续prompt；正常500条更新inspect=0；跨页无重无漏；attach竞态；source删除后restart delivery；同文歧义fork；大tool ref；慢连接有界；所有现有binary契约迁移v3且完整门禁通过。

### T10 [x] 维护和最终删除清单

**本轮交付证据：**新增 `maintenance_wal_tests.rs` 验证有效未checkpoint WAL 的 DB/WAL/SHM 原样复制、manifest bytes/SHA-256 和在导出副本恢复查询，source bytes 不变；`workbench-startup.mjs` 验证 SIGINT/SIGTERM、Telegram 初始化失败、IPC bind 失败的 join/lease/socket 边界。生产路径已删除 v2 decoder、全量状态桥接和 `DeliveryPayload::Entries`。

- 维护已部分在T04切SQL，不重做。补齐持锁静止root的**有效未checkpoint WAL** export/restore：复制DB及必要辅助文件，source bytes/hash不变；不先checkpoint后声称原样导出。
- corrupt DB、旧格式、active lease、symlink/重叠目标继续拒绝。reset只接受marker-only/empty root，不增加递归删库。
- compact只动既定Telegram范围，operation/delivery/archive不删。DB队列drain、Connection关闭、线程join先于lease释放。
- 补启动半失败、IPC bind失败、启动中signal。不要新增自动stale socket清理。
- 删除桥接types/APIs、全量state SQL、全量Telegram load/diff、json_each topic查询、v2同步、测试专用生产reader。database.rs不要求行数上限，不为“文件小”再拆facade forwarding层。
- 文档同步新存储/IPC/UI分页/发布/恢复边界；只保留一份当前设计描述，细碎过程日志不进入实施计划正文。

### T11 [x] 最终规模与发布验收

**本轮交付证据：**`scripts/workbench-scale.mjs` 对 100k history、10k summaries、100k completed inbox、1000-topic dispatch、hot-state poison rows、WAL export 和 16-worker/32-interaction fault fixture 各执行 5 次并输出 median/p95/RSS/VM-step 诊断；报告 `.test-results/scale-b5d28bd2-94a6-4fb5-ba9d-d74a07a6cc0f/report.json`。600 秒 synthetic soak 通过 127 joined rounds，报告 `.test-results/soak-6d0abc96-5d16-4889-a455-fea9cea053a5/report.json`。GNU 与 musl 实际 production artifact smoke 通过；offline Pi SDK 真实 fixture 通过（18 guarded processes、0 network attempts、0 real model requests）。

1. 保留原计划100k entries、10k summaries、16 workers/32 interactions、SQLITE_FULL/失败事务、SIGKILL、Chromium、WAL export场景；加入100k Completed inbox和1000topic查询。
2. 硬指标优先：列表/热load不读旧entries；常规Telegram不读Completed rows；工具patch不读旧BLOB；wire、缓存有硬上限；head查询无逐candidate全表相关扫描。
3. 记录5次median/p95/RSS/SQLite VM steps/读取rows/wire bytes。旧计划“100k相较1k耗时及内存必须≤2倍”改为诊断指标，不能因fsync/设备噪声误报或放松正确性。结构性硬门槛不放宽。
4. 执行 `npm run format:check`、`npm run audit:workbench`、`npm run check`、`npm run clippy`、`npm run test:runner`、`npm run test:rewrite`；新增scale入口后运行scale，以及600秒soak。
5. 在安装目标标准库的环境构建musl，对该实际产物执行artifact/IPC/Telegram/release校验；显式执行offline真实Pi SDK。默认ignored不算执行，真实Bot/model未测需列明。
6. 发布前旧数据先export，新format3使用新root。回退binary同时回退数据root，不让旧binary打开新schema。

## 4. 提交和验收纪律

- 推荐下一提交先做T04-R1，再T04-R2。不要再花多个提交为尚未使用的API逐个增加facade，再花多个提交接入。
- 热state/fork完成一个协调切换提交，wire/UI/Telegram完成另一个协调切换提交；若拆分，所有中间分支不发布且不增加临时生产兼容桥。
- 一个任务的完成记录最多10行：commit、测试命令/结果、未执行项、实际删除路径。测试失败过程留在测试报告，不连续追加“stage-final-final2”叙述。
- 不以代码行数单独判合格；但最终必须删除上述明确的桥接和全量diff，并给出生产调用图。不能把目前4,359行底座上继续叠一套热state层当作完成简化。
- 本计划不授权删安全断言、吞坏数据、提高帧预算、自动迁移/清库、重写worker/调度、引入任意SQL闭包或第二个DB线程。
