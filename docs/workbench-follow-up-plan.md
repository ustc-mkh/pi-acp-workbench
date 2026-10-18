# Workbench 后续调整：可直接执行的实施计划

> 本文件替代先前的方向性建议。执行者按 T01 → T11 顺序实施，不重新选型、不增加兼容层、不同时实施两个方案。
>
> 重构基线：`af6d138`（`refactor: replace legacy daemons with unified workbench runtime`）。该提交已保存此前全部未忽略改动，未 push。本文件此次修订发生在基线提交之后。
>
> 本计划不是完成报告。下面所有任务初始均为未完成，只有实际通过对应验证才能勾选。

## 0. 已作出的决定：不要再讨论选型

1. **采用 SQLite 单库**，Rust 依赖固定 `rusqlite = { version = "=0.40.2", features = ["bundled"] }`。不采用 SQLx、ORM、事件数据库、自建 WAL 或 JSON/SQLite 可配置 backend。
2. **存储格式升至 3，外部 IPC 升至 3。** 不读格式 2，不自动迁移、不双写、不自动清理真实目录。独立实现显式离线 export；不在本任务中开发导入器。
3. **一个数据库执行线程、一个连接、一个有界任务队列。** 所有 DB 工作在该线程执行；没有连接池、共享 Connection Mutex、每请求 spawn_blocking 或第二个数据库 actor。先用最简单可验证的实现。
4. **所有持久化业务记录，包括图像 BLOB，进入同一数据库。** 不保留独立 payload 文件、history JSON、journal/results 文件或 Telegram state JSON。这样避免跨 DB/文件引用提交和 GC 协议。
5. **SessionActor 只持有热状态，不持有完整历史。** reducer 返回增量写集，不扫描或克隆旧 transcript。完整历史在数据库，按页查询。
6. **列表只读摘要；详情只读当前视图；历史独立分页；命令回执独立类型。** 禁止外部返回完整 SessionSnapshot。
7. **一次会话提交只发布一个 committed batch，以 revision 排序。** 不新增独立 event_seq、不持久化可重放事件日志。断线或缺口重新 attach。
8. **保留现有 host ingress、Registry、SessionActor、worker 和 Telegram 调度。** 本轮不合并 actor、不重写调度算法。只删除因文件存储/快照同步而产生的冗余路径。
9. **不做 token 批量延迟提交。** 每个 accepted 更新仍先提交再发布；先用增量事务消除全量写放大。不得默默降低耐久性。
10. **本轮不自动过期 operation 回执，不自动回收 archive。** 先保留全部；仅保留已有、安全可解释的 Telegram completed inbox/expired callback 离线压缩。容量/磁盘不足明确失败，不静默丢弃。

### 0.1 已验证什么

在仓库外 `/tmp/workbench-plan-proof-nlD59b` 建立并运行真实 Rust 小原型，未修改项目依赖或实现：

- `rusqlite 0.40.2` bundled SQLite 在当前 GNU 环境编译运行成功。
- WAL + synchronous=FULL，一次事务写入 session、100,000 条 entries 和 delivery intent 成功。
- keyset 查询读取 100 条，`EXPLAIN QUERY PLAN` 为 `SEARCH ... USING INDEX`。
- 杀死持有未提交事务的子进程，重开数据库后 session revision、entries 和 deliveries 一起回滚；`PRAGMA integrity_check` 返回 `ok`。
- 本机该原型 100,000 行批量插入约 108 ms，**不是 Workbench 性能承诺**，没有测量每 token fsync、16 worker 或实际 UI。
- 另用隔离 SQLite 验证了按实际 JSON 字节截页：1,000 条含中文/emoji/转义的记录分16页返回，无重无漏；首请求后追加的新条目不混入固定历史边界。
- 验证了UTF-8按字节分片后可精确重组，以及不checkpoint、直接复制静止数据库主文件与WAL后恢复成功，源文件hash不变。这验证T07/T10的基础算法，不代表已实现对应生产接口。
- 尝试 musl 编译失败：本机缺少目标 Rust 标准库（E0463）。GNU 成功不能算作 musl 验收；T11 必须在具备目标工具链的 CI 执行。

现有工作区验收证据：`npm run test:rewrite` 通过；200 项 Rust、180 项 TS、19 IPC、15 Telegram、3 SIGKILL、9 Chromium 和 GNU artifact smoke 通过；1 项 SDK 测试默认忽略。日志见 `/tmp/workbench-acceptance/rewrite.log` 和 `.test-results/run-Zu6yfb/`，临时日志可能被清理。

已复现缺陷：真实 daemon + synthetic ACP peer，42 轮各 100,000 字符 prompt 后，约 8.43 MB 历史导致 inspect EOF。CI、release 仍引用已删除文件。原型证明方案的基础能力，不代表下列集成任务已完成。

## 1. 执行规则

- 每次只执行一个 T 任务；先读指定文件，再改实现，再补测试，最后运行命令。
- 不修改真实 `~/.pi` 数据；所有测试使用 mkdtemp 的独立 root、独立 HOME 和 synthetic peer。
- 不通过删测试、改为 ignored、放宽超时/帧上限、吞错误或返回空历史使门禁变绿。
- 现有实现相关测试可以改成新 schema/API，但原有安全断言必须保留；测试替身不算旧生产实现。
- 中间提交允许后续任务尚未完成，**禁止中间版本发布**。T04 起是内部切换区；不要为了让中间版本对外可用临时写兼容 backend。
- 每项结束在本文件勾选，并记录 commit、实际命令/结果、剩余阻塞。没有证据不得写 PASS。
- 如果与本文具体约束冲突，停下记录冲突，不自行引入第二种设计。

### 不可削弱的六项保证

1. epoch/turn 栅栏拒绝迟到 worker 更新。
2. observer 断连不取消已接受操作；mutation 不自动重发。
3. 相同 operation + 相同请求回放原回执，不同请求冲突；Started 不自动重执行。
4. committed batch 只在 DB commit 成功后发布。
5. cancel/remove 的终态发布前已停止并 join 对应物理 worker。
6. 外部 native fork/createForumTopic/HTTP 副作用仍有 uncertain/interrupted 状态；SQLite 不提供跨远端 exactly-once。

## T01 [x] 修复 CI、二进制选择和发布入口

**执行记录（实现提交 `b746c3f`）：**

- `npm run test:runner`：37 项通过，包含 release 纯校验 fixture 和四入口显式坏路径不 fallback；默认 binary 存在/不存在均使用隔离 fixture 验证。
- `npm run format:check`：通过；`.pi/` 已排除，未修改 goal 账本。
- `npm run test:rewrite`：通过；200 项 Rust 通过、1 项既有 SDK 测试默认 ignored、180 项 TS、19 IPC、15 Telegram、3 SIGKILL、9 Chromium 及 GNU artifact smoke 通过。完整日志 `.test-results/t01/rewrite.log`，并行 suites 日志 `.test-results/run-1D6hxr/`。
- `node scripts/workbench-contract.mjs --binary "$PWD/service-dist/pi-acp-workbenchd"`：19 项通过，日志 `.test-results/t01/production-ipc.log`。
- `node scripts/workbench-telegram-contract.mjs --binary "$PWD/service-dist/pi-acp-workbenchd"`：15 项通过，日志 `.test-results/t01/production-telegram.log`。
- CI 中旧 browser/service contract 和 `PI_CONTRACT_DAEMON` 引用为零；发布准备已改校验 `extension/docs/workbench-release.md`，删除历史双 daemon/旧验收文档承诺。
- 剩余阻塞：本项无实现/验收阻塞。这里只验证本地 GNU 产物与发布校验 fixture，未创建 GitHub release；musl 实际产物和显式 offline SDK 门禁待 T11，不计作本次通过。任务状态 API 的单项/批量参数互斥校验拒绝更新，实际完成证据以本记录和提交为准。

**读取：** `.github/workflows/ci.yml`、`scripts/{test-rewrite,test-full,prepare-release,service-artifact-smoke,workbench-contract,workbench-telegram-contract,workbench-process-loss,workbench-browser-smoke}.mjs`。

**实施：**

1. 新增 `scripts/lib/workbench-binary.mjs`，导出 `resolveWorkbenchBinary(explicit)`：显式参数必须绝对、存在、可执行；未指定才解析 `rust/target/debug/pi-acp-workbenchd`。错误立即抛出，不 fallback。
2. 四个 `workbench-*-contract/process-loss/browser-smoke` 脚本统一支持 `--binary ABSOLUTE`，实际 spawn 只能用此 helper 的结果；保留各自其他参数。
3. CI browser job 安装 Rust 后执行 `npm run test:browser`。删旧 `scripts/browser-smoke.mjs` 调用。
4. CI production job 在 artifact smoke 后执行新 IPC 和 Telegram 契约，均传 `--binary "$PWD/service-dist/pi-acp-workbenchd"`；删旧 `service-contract.mjs` 和 `PI_CONTRACT_DAEMON`。
5. `prepare-release.mjs` 校验 `extension/docs/workbench-release.md`；发布说明改为单 daemon，删除 rust-acceptance.md 失效链接和未经本次验证的承诺。
6. `.prettierignore` 排除 `.pi/`。不改写、删除 goal 账本。
7. 新增 `scripts/workbench-binary.test.mjs`、`scripts/prepare-release.test.mjs`。把发布脚本拆出纯校验函数以 fixture 测试；不能要求真的发布 GitHub release。覆盖版本/tag、文档、dirty/provenance、哈希和 smoke report。
8. 更新 `test:runner`、`test-full.mjs` runner 列表。`test-rewrite.mjs` 加入 `npm run format:check`，替代单独 Rust fmt 步骤。

**验收：**

```bash
npm run test:runner
npm run format:check
npm run test:rewrite
node scripts/workbench-contract.mjs --binary "$PWD/service-dist/pi-acp-workbenchd"
node scripts/workbench-telegram-contract.mjs --binary "$PWD/service-dist/pi-acp-workbenchd"
```

新增测试必须证明显式错误路径不会运行 debug binary。全新 CI 中旧脚本引用为零。不要把本任务与存储修改混在一个提交。

## T02 [x] 固定新数据契约、字节预算和回归用例

**执行记录（实现提交 `b71244c`）：**

- 新增 `domain/query.rs`、`domain/transition.rs` 与共享 `test/fixtures/rewrite/ipc-v3.json`；Rust/TS 固定 summary/view/entry/tool/content/receipt/batch/page/cursor 契约及预算。序列值使用 JS safe-integer 边界，写集为强类型，不包含任意 JSON Value。
- 新增 9 项 Rust `domain::query_tests` 和 7 项 TS `test/workbench-protocol.test.ts`，覆盖 Unicode/JSON 转义实际字节数、16KiB inline 边界、坏 ref/hash/kind/path、64MiB 单条 ref、溢出、v2 请求拒绝、cursor scope、页/slice 限制、512KiB view/1MiB metadata/batch 和32项 interaction 上限。
- `cargo test --manifest-path rust/Cargo.toml -p pi-acp-workbenchd domain::query_tests`：早期7项通过；后补2项随完整 rewrite workspace 测试通过。
- `npx vitest run test/workbench-protocol.test.ts`：7项通过；`npm run check`、`npm run audit:workbench`、`npm run format:check`：通过。
- `npm run clippy` 首次发现 Loaded 回执 enum 体积差异，改用 wire 等价的 `Box<SessionView>`，随后完整 rewrite 中 clippy 通过，未添加 lint 豁免。
- `npm run test:rewrite`：通过；209项 Rust 通过、1项既有 offline SDK 默认 ignored；187项 TS、runner37、IPC19、Telegram15、SIGKILL3、Chromium9及 GNU artifact smoke 通过。日志 `.test-results/t02/rewrite.log`、`.test-results/run-sCzy2F/`。
- 剩余阻塞：本项无实现/验收阻塞。类型目前独立定义，旧生产 reducer/state/IPC/UI 尚未切换，**本项没有修复大历史问题**；存储与外部v3切换按 T03–T08执行。任务状态 API 参数互斥问题仍在，未手工改写 goal 账本。

**读取：** `domain/{session,transcript,event,command,reducer,tool,fork,fork_messages}.rs`、`transport/vscode.rs`、`src/workbench-{protocol,schema,session,ui}.ts`。

**新增：** `domain/query.rs`、`domain/transition.rs`、`test/fixtures/rewrite/ipc-v3.json`。

固定以下类型，Rust/TS 同名字段，不让执行者自行设计另一套：

- `SessionSummary { id, harness, cwd, status, revision, created_seq }`，不含历史/完整工具内容。
- `SessionView`：当前 native identity、status、config/configuration_intent、catalogue、plan、usage、pending_interactions、origin、revision、last_entry_seq；不含 transcript 或历史 tools。
- `EntryHeader { seq, id, turn, role, message, text: TextBody, image }`。
- `TextBody = Inline { text } | Archived { content: ContentRef }`。文本总是存 DB，wire 编码时 ≤16 KiB UTF-8 的文本 inline，否则只返回 ref。
- `ContentRef { id, sha256, bytes, kind }`。kind 用 enum，不接受文件路径/URL。
- `ToolHeader` 保留 id/turn/status/kind/title/locations；text/diff/resource 大字段改用 ContentRef，不在 header 放完整结果。
- `CommandReceipt = Created { summary } | Loaded { view } | Accepted { session, revision } | Forked { summary } | Removed { session } | ForkCancelRequested { source, operation }`。错误独立 typed error。回执不含历史。
- `Transition { next: SessionState, append: Vec<NewEntry>, tool_updates: Vec<ToolUpdate>, deliveries: Vec<DeliveryIntent>, view_changed: bool }`。每项 payload 有具体 typed 结构，不用 serde_json::Value。
- `CommitBatch { session, revision, view: Option<SessionView>, entries: Vec<EntryHeader>, tools: Vec<ToolHeader>, removed: bool }`。每个 revision **只发这一条消息**，不再逐项发布多个生命周期事件。

**预算固定：** frame 8 MiB；普通 query/batch 完整 JSON ≤1 MiB；list 默认/最大 50/100 项；history 默认/最大 100/200 项；content slice 默认/最大 64 KiB 原始字节；Inline 文本阈值16 KiB；SessionView 编码 ≤512 KiB；单个不可变文本/工具内容 ≤64 MiB；图像继续 ≤4 MiB。所有 JSON 限制按实际序列化字节检查。view 超限以明确 protocol/resource error 结束相关更新，不能截断授权字段。

- 超长工具 title/detail/路径等 metadata 无法转 ref 时明确拒绝；不要静默截断用于身份或授权的值。
- seq/revision 使用非负整数，写入前拒绝超过 JS MAX_SAFE_INTEGER；Rust 和 TS 上限相同。
- pending_interactions 继续沿用32上限，provider catalog/plan/view 共享上述512 KiB硬边界。

**测试：**新增 `domain/query_tests.rs` 和 `test/workbench-protocol.test.ts`，包含 Unicode、JSON 转义、坏 ref、溢出、版本2拒绝、超大单条 content 引用。定义新类型后可暂不连生产，但不得声明此时已经修复大历史。

## T03 [x] 建立唯一 SQLite Store

**执行记录（实现提交 `17279b4`）：**

- 固定 `rusqlite = { version = "=0.40.2", features = ["bundled"] }` 并更新 lockfile；新增 `persistence/{database,schema,content,query,sqlite_tests}.rs` 和编译时包含的 `schema.sql`。
- Database 只有一个专用 OS 线程/Connection、256项 Tokio mpsc 和 typed StoreRequest；持有同一 host lease，禁止同 lease 第二个 executor。observer 丢弃不取消已入队事务，shutdown/最后 handle drop 都关闭 sender、drain、close Connection、join；没有连接池、Connection Mutex、任意 SQL/closure 业务 API 或每请求 spawn_blocking。
- SQLite 验证 WAL/FULL/foreign_keys/busy_timeout=5000 的实际值、user_version=3、必要表、quick_check/foreign_key_check；所有写入参数绑定。热视图/entry/content/tool/delivery 增量提交在一个事务中，带 revision CAS、不可变内容逐字节校验及实际 batch/view 字节预算。list 只读摘要列，history 使用有 LIMIT 的索引 keyset，长文本 header 不读取整个 BLOB。
- format3 初始化在数据库成功后才完成 marker；pending 明确区分中断，旧/未标记/损坏/symlink root 拒绝且不自动删除。保留稳定 flock inode，DB 线程关闭前不释放 lease。
- `cargo test --manifest-path rust/Cargo.toml -p pi-acp-workbenchd sqlite`：最终15项通过（含供子进程调用的 test entry）。覆盖100k Unicode/转义 entries 全分页无重无漏及 EXPLAIN SEARCH 索引、真实子进程持未提交事务被 SIGKILL 后 revision/entries/content/delivery 同时回滚且 integrity_check=ok、真实第二进程 lease 拒绝、队列有界/observer丢弃/drain、初始化中断、坏hash/不可变id冲突、图像/长文本/tool/delivery原子提交与 schema约束。
- `npm run clippy`、`npm run format:check`、`npm run audit:workbench`：最终复跑通过；日志 `.test-results/t03/{sqlite,clippy,format,audit}.log`。
- 本项期间 `npm run test:rewrite` 通过：224项 Rust、187项 TS、runner37、IPC19、Telegram15、SIGKILL3、Chromium9及 GNU artifact smoke；1项既有 offline SDK 默认 ignored。日志 `.test-results/t03/rewrite.log`、`.test-results/run-I1NXOP/`。随后额外收紧 SQL status约束和 shutdown失败路径 join，最终使用上述 sqlite/clippy/format/audit 复验，未把此后的完整 rewrite 声称为已重跑。
- 剩余阻塞：本项无实现/验收阻塞。新 DB 尚未接入旧生产 facade，未增加可选 backend；旧生产格式标记与文件路径在 T04 切换/删除，不能将本次旧生产 artifact smoke 作为“已迁移 SQLite”的证据。任务状态 API 参数互斥问题仍在，未手工改写 goal 账本。

**修改：** daemon `Cargo.toml`、`persistence.rs`、`persistence/format.rs`。
**新增：** `persistence/{database,schema,content,query,sqlite_tests}.rs`。SQL 放 `persistence/schema.sql`，编译时 include_str。

### 3.1 执行器

- `Database::open(root)` 在已持有现有 host flock 的前提下启动一个专用 OS 线程；线程自己创建/拥有/关闭 Connection。
- `StoreRequest` 用明确 enum，不暴露任意 SQL/任意 closure 给业务层。Tokio 有界 mpsc 容量256，执行线程 blocking_recv，回应用 oneshot。
- 内部提交已进入 store 队列后，即使 reply receiver 丢弃也完成事务。shutdown 关闭 sender 并 drain 队列后 join 线程；不得 abort DB write。
- SQL 读写均在此线程。没有 await/网络/provider 调用进入事务。
- `journal_mode=WAL`、`synchronous=FULL`、`foreign_keys=ON`、busy_timeout=5000ms；校验 PRAGMA 实际值。
- DB 路径固定 `ROOT/workbench.sqlite3`；user_version=3。旧格式 root 在打开/创建 DB 前拒绝；保留现有 lock inode 和 socket 权限检查。
- 新 root 初始化失败不得留下“已完成格式初始化”的假标记；重启必须能区分空 root、初始化中断和有效 DB。

### 3.2 schema（这些实体必须存在）

| 表                 | 主键/索引                                                   | 内容与规则                                                                                |
| ------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| sessions           | id PK；created_seq UNIQUE                                   | revision、last_entry_seq、hot_state_json、摘要列；hot JSON 禁止历史                       |
| contents           | id PK                                                       | kind、sha256、bytes、data BLOB；相同 id 不可变且逐字节验证                                |
| entries            | entry_id PK                                                 | turn/role/message、content_id/image_id、不可变 metadata；不 cascade 删除                  |
| session_entries    | (session,seq) PK；(session,entry_id) UNIQUE                 | session 到不可变 entry 的归属/顺序；fork 可复用同一 entry                                 |
| tools              | (session,turn,tool_id) PK                                   | 当前该 turn 的工具投影，大内容均为 ref                                                    |
| operations         | operation PK                                                | fingerprint、Started/Completed/Failed/Tombstone、原始 typed receipt/error bytes、checksum |
| deliveries         | delivery_id PK；(status,next_retry)；(target_key,order_seq) | typed target/payload refs、attempt、retry、Pending/Acked；保留 Acked防重                  |
| telegram_meta      | bot_id PK                                                   | offset/归属                                                                               |
| telegram_bindings  | (bot_id,chat,thread) PK；(bot_id,session) UNIQUE            | topic/session 绑定                                                                        |
| telegram_inbox     | (bot_id,update_id) PK                                       | typed command、operation、callback ref、status/outcome                                    |
| telegram_callbacks | (bot_id,key) PK                                             | binding、expires_at、used_by                                                              |
| telegram_effects   | effect_id PK                                                | topic creation 的 Started/Completed/Failed/Uncertain 回执                                 |

- JSON 列只序列化强类型 DTO；读出必须反序列化并校验 id/revision/ref。禁止 Value 重新进入业务层。
- 不对 entries/contents/operations/deliveries 设置会随 session 删除的 FK cascade；源会话删除后仍可回放/投递/读取归档。
- schema 必须显式约束唯一性/非负长度/status合法值；所有 SQL 参数绑定。
- 不增加冗余 checksummed JSON 外壳。不可变 content 和 operation 原始回执仍校验 sha256；SQLite integrity_check不替代业务身份校验。

**本任务必须形成可重跑证据：**把0.1节原型检查改写为仓库内Rust测试，包括100k索引分页、真实子进程持事务被kill后的恢复；不要依赖`/tmp`里的原型继续存在。测试没有权力修改真实业务root。

**测试：**事务整体 rollback、重复不可变 id冲突、队列 observer丢弃仍提交、shutdown drain、空/旧/损坏root拒绝、两host lease排他。用测试钩子触发失败，生产不引入故障注入IPC。

**命令：** `cargo test --manifest-path rust/Cargo.toml -p pi-acp-workbenchd sqlite`、`npm run clippy`。

## T04 [ ] 迁移所有持久化业务，删除多文件协议

**读取/修改：** `app.rs`、`persistence/{history,journal,outbox,payload,inbox,telegram_effect,interface}.rs`、`telegram/{runtime,admission,polling,execution,delivery,render}.rs`。

执行顺序固定：

1. `JournalStore` 改为共享 `Database` handle 的 typed facade。begin/lookup/finish/expire 在 SQL 事务中实现相同语义。Started 重启后仍 OperationInterrupted，不重跑。result保存原始字节且回放相同内容，不重新构造依赖当前状态的 receipt。
2. `PayloadStore` 改为 contents/entries 查询 facade；图像signature/MIME/hash等现有校验保留，debug 不输出 pixels。
3. `OutboxStore` 改为 deliveries 查询 facade；order_seq 持久化。同 topic deferred head 仍阻塞后续，同 topic最多一个发送者。
4. **history commit直接在同一事务插入 delivery intent**；删除 `project_outbox`、历史delivery_events ledger和恢复时扫全部history重建outbox的路径。
5. outbox 的1024容量改为“同时派发/载入的工作窗口”，不是拒绝保存committed intent的上限。磁盘记录不得因窗口满丢失。pending查询保持每topic head排序。
6. `TelegramStore` 的 offset、callback used_by、inbox admission 同事务；不能改成三个独立SQL调用。按现有 expected_binding 再验证以防TOCTOU。
7. Telegram topic effect在调用HTTP前写Started；remote结果不确定不重复createForumTopic。completed之后inbox恢复只查effect/operation，源session已删除也不重做。
8. facade只包typed SQL方法，不再各有root/path/Arc<Mutex>。所有facade必须来自同一个Database，不得为每个store开连接。
9. 替换 `HistoryStore` 为 `SessionStore`；调整 `SessionPersistence` 到新commit contract，保留一个测试用MemoryStore。删除 filesystem HistorySnapshot、checksum快照外壳和 `persistence/io.rs`。
10. 更新 format维护测试/fixture。format2只保留 frozen拒绝样本；不能保留reader当作迁移。

**暂不改：**Telegram execution/delivery的并发算法、worker spawn协议、credentials scrub和native fork外部协议。

**验收：**原journal replay、删除源后投递、429/restart、callback重放、坏hash拒绝、队列满不丢intent、topic FIFO所有断言保留。用SQL事务故障替代旧rename故障。真实daemon停止后root只应含lease、format marker、DB及其合法WAL辅助文件，不出现新history/journal/payload JSON。

## T05 [ ] 从 SessionActor 中移除完整历史

**修改：** `domain/{session,transcript,reducer,transition}.rs`、`actor.rs`、`actor_registry.rs`、`actor_runtime.rs`、`app.rs`、`persistence/interface.rs`。

1. `SessionState` 删除 `transcript.entries` 和全历史 `transcript.tools`。保留origin、last_entry_seq、当前turn必要tool状态/ref及其他热字段。
2. reducer从`apply(&mut state)`改成`transition(&state, command, now) -> Transition`；clone只复制有硬预算的热状态。
3. prompt/text/thought/image创建NewEntry；tool partial update只合并当前turn的已知metadata/ref，旧turn工具通过SQL查询。
4. actor执行顺序固定：epoch/turn检查 → 纯transition → 一次store.commit(expected_revision, transition) → 成功后替换state → 发布一个CommitBatch。失败保持内存state不变，不发布成功事件。
5. DB事务使用revision CAS，只有旧revision相等才写；同revision相同内容允许明确的幂等分支，冲突必须拒绝。
6. `commit`同时更新hot state、append entries/contents、tool updates、delivery intent，分配连续entry seq；不能先保存image再单独更新history。
7. turn结束后清理actor当前turn工具内存，不删除DB工具历史。cancel两阶段、configuration intent恢复语义不变。
8. registry cold list/inspect不得创建actor/启动worker；load只读取热状态。worker恢复继续使用provider native load，不文本重播。
9. 删除旧SessionState::snapshot中复制transcript的实现。内部测试如果确需全集，显式使用仅测试helper按页收集，不在production保留full_snapshot。

**测试硬断言：**给同一session预置100,000旧entries后，transition/commit不得读取旧entries、不得序列化旧entries；用store spy记录读取条数，不只用耗时推测。失败commit不改内存、不发布；late epoch不写DB；cold query不spawn。

## T06 [ ] 保持 native fork 语义但不再构造全量分支快照

**读取/修改：** `domain/{fork,fork_messages}.rs`、`app_fork*.rs`、`actor_registry.rs`。

1. source lane仍在fork期间独占，prepare记录source id/native/revision和选中entry seq；拒绝active_turn/configuration_intent。
2. 把现有grouping/重复文本/partial assistant/image拒绝规则提取为incremental scanner：按session_entries.seq升序分页，维护当前contiguous group的SHA256、末entry、role和media标志，不收集全部文字。
3. 扫描目标group和所有其他group/单row，检查与目标同role同digest的重复歧义；保留“其他单row等于目标完整文本也拒绝”的现有规则。缺group/非末row/图像group不变地拒绝。
4. fresh provider candidates匹配仍要求唯一、安全、相同role和digest；不把message id当native id。
5. prepare产物`ForkPlan`只含source/source_native/source_revision/target/entry_seq/new_session_id/origin；不含snapshot或复制的prefix。
6. 远端成功后一个SQL adoption事务：验证source revision → 插入branch热状态 → `INSERT ... SELECT`复制prefix的session_entries链接 → 复制严格早于切点turn的tools。entries/content本身不可变且复用，不复制大BLOB。
7. 分支清空plan/interactions/usage/config/catalogue，保留新的native identity、origin和历史prefix，与现有语义一致。
8. operation回执只存branch summary；uncertain/unadopted/cancel-fork语义、one-worker限制下先join source adapter均保留。

**必须先做等价测试：**对既有fork fixture及生成的小序列，同时运行旧vector算法与新scanner，比较接受/拒绝和target；测试完成后删旧production算法，可在test-only保留oracle。覆盖重复文本、跨turn重用message id、thought、同turn工具、image、同role单row歧义、源删除和restart replay。

## T07 [ ] 实现IPC v3的有界查询与无缺口attach

**修改：** `transport/vscode.rs`、`app_query_tests.rs`、`domain/query.rs`、`persistence/query.rs`、`docs/workbench-ipc.md`。

### 7.1 固定查询

- `list { cursor?, limit? } -> { sessions, next_cursor? }`。排序created_seq DESC；首请求冻结max_created_seq，cursor携带version/max_created_seq/before_seq。不用OFFSET，不读entry表。
- `inspect { session } -> SessionView`。冷读，仅查hot state。
- `history { session, cursor?, limit? } -> { entries, next_cursor? }`。首请求冻结max_entry_seq，按seq DESC选，页面内部返回升序。next_cursor记录最后已返回的最小seq和初始max；并发新append不混入旧页。
- `tools { session, turn, cursor?, limit? }` 对该turn的工具按tool_id keyset分页；页面同样有1MiB实际字节预算。
- `content { ref, offset, length? } -> { text, next_offset?, sha256, total_bytes }`。ref必须匹配存储身份/hash/长度；UTF-8字节offset必须在字符边界，结束裁到合法边界；不能对whole BLOB from_utf8后再切，也不能读取任意路径。
- image继续typed archive API，验证完整ref，图像响应允许使用8MiB总帧预算，不放进普通1MiB页。
- cursor为明确typed字段或其编码形式；解码验证version/session/bounds/limit。cursor不是权限凭证，不需要新加加密密钥。
- 不信任client ref授权文件/网络。IPC同UID仍使用已有访问模型，VSCode UI只允许已加载view中的引用；Telegram仍校验topic/workspace。

分页实现必须边构造边测完整JSON大小，放不下的row留到下一页，不能跳过；单项因metadata超过预算时返回明确TooLarge，不无限返回空页。数据库SQL LIMIT必须使用，不能先查全表。

### 7.2 attach与batch

- `attach { session } -> { view, recent_page }`并建立订阅，替代subscribe+全量inspect组合。
- transport先注册现有broadcast receiver，再发一致性read事务读取view/recent_page（同revision边界）；缓冲到达消息有界。完成reply后丢弃revision≤view.revision，依序转发更大的batch。
- 会话owner在commit成功后、处理下一个会话命令前同步发送batch，防止同会话发布顺序倒置。
- 收到revision>last+1、buffer满或broadcast lag，发送resync_required并关闭该连接。客户端显式重新attach，不自动重放mutation。
- 一次commit只有一个batch，所以不需要event_seq。无状态修改的command不增revision、不制造空batch。
- `remove`发单一removed batch，operation receipt仍可回放；attach不存在返回NotFound。
- `write_message`超限不能只返回io error：能归属request的超限先返回小型typed error；超大batch属于实现违约，记录脱敏错误并要求resync。

**测试：**并发append跨页无重无漏；list只读summary；单row长文本可展开；attach期间commit不丢；重复batch忽略、缺口resync；慢连接有界；旧v2拒绝；100k历史能取最后/中间/第一页。

## T08 [ ] 前端切换到v3并删除inspect风暴

**修改：** `src/workbench-{protocol,client,session,controller,ui}.ts`、`webview/workbench-main.ts`、相关TS/Chromium测试。

1. protocol schema与T02/T07一致；mutation ticket.result变成CommandReceipt，删除按`SessionCreated`等event数组查结果的代码。
2. WorkbenchSession.start调用attach一次，保存view和recent_page。正常batch以revision去重/检测缺口；view字段存在时整体替换，entry按id追加。不是重新运行domain reducer。
3. 删除dirty/50ms inspect合并timer，以及每个mutation结束后的全量list+inspect链。summary由create/fork/remove回执或显式refresh更新；其他客户端的变化在显式refresh发现即可，本轮不新增全局列表事件服务。
4. v3 mutation授权路径仍先检查workspace trust和realpath containment；fork entry必须来自服务端已加载page，不让webview伪造native path。
5. history缓存最多1,000 headers/4MiB（先触到哪个就淘汰远端页）；DOM最多300条，使用已有滚动容器的上/下占位与页窗口，不引入UI框架。
6. Archived文本默认显示大小和“展开”，展开按64KiB content页读取；每个展开项内存最多256KiB，超出提供继续翻页，不自动把64MiB整个载入。
7. 图片cache按decoded原始bytes总32MiB LRU，切会话/销毁时释放引用/对象URL。image id/hash验证保持。
8. resync/断连显示明确状态并停止接收旧generation结果；用户显式选择会话或refresh触发attach。没有自动重发prompt。

**测试：**正常500条text更新inspect调用数=0；attach一次；重复/缺口batch；切会话期间慢content不串图/串文本；dispose无timer/observer泄漏；100k历史Chromium滚动；大工具diff按ref读；42轮各100k prompt后session仍可打开和继续prompt。

## T09 [ ] Telegram只依赖新查询，保持现有投递保证

**修改：** `telegram/{runtime,execution,render,delivery,delivery_scheduler,execution_scheduler}.rs`。

- `/list`读取summary页，`/status`读取SessionView，plan只在显式/status展示；不得通过测试helper偷偷加载全部history。
- turn完成delivery只存typed不可变entry refs或turn范围，render按seq分页获取，不先收集整个turn为Vec<String>。
- 每次只载入一个待发送text片段/一张image；Unicode按现有UTF-16 Telegram限制切片，parts不无限预展开到内存。
- delivery scope仍使用已持久化cwd/topic，即使session删除也可投递；不因v3 view变化丢掉冻结授权信息。
- 保留八lane并发、同topicFIFO、deferred head barrier、429 retry及at-least-once说明。不得承诺multipart或crash-after-send不重复。
- host operation receipt改为新typed结果；topic创建/绑定/offset/callback的durable语义与T04一致。

**测试：**迁移现有15项binary契约及runtime regressions；追加大turn文本+image流式render内存边界、删除源后restart投递、相邻topic不被大历史/status拖住。

## T10 [ ] 离线维护、shutdown和删除清单

### 10.1 维护命令

保留同一binary `storage export|gc|reset --root ABSOLUTE --confirm`。

- 所有操作先取同一flock；活跃host直接拒绝。DB handle全部关闭后才允许释放lease。
- export保持“exact bytes + hashes”的现有承诺：在持锁且无host的情况下复制DB、存在的WAL/journal等必要辅助文件和marker；不能只copy主DB。禁目标重叠/symlink/special-file，目标不覆盖。用复制结果恢复验证完整性。不要执行checkpoint后谎称源bytes未变。
- gc只事务删除completed inbox和不被pending引用的expired callbacks；保持offset/unexpired consumed bindings。**本轮不删operations、deliveries、entries或contents**。
- reset继续只接受marker-only/empty root；非空DB拒绝并说明先export后人工处理，不把reset偷偷升级为递归删库。
- 维护测试须覆盖有效WAL未checkpoint的导出、corrupt DB拒绝、active lease拒绝、导出/失败后源bytes不变。

### 10.2 生命周期

只收敛相同cleanup实现，不重排安全顺序：close_admission → worker停止/join → settle已接受工作 → transport/runtime/DB队列drain与线程join → socket cleanup → lease释放。

检查启动失败：DB初始化失败、Telegram startup失败、Telegram已启动而IPC bind失败、启动中SIGTERM。加入对应真实进程测试；不在此任务自动删除stale socket。

### 10.3 必须删除/不再可达

- filesystem `HistorySnapshot`、`history.delivery_events`、`project_outbox`、persistence/io.rs。
- facade内的path/new(root)/全局文件Mutex和任意旧JSON reader。
- production全量SessionSnapshot查询/回执、SessionState完整transcript、ForkProjection.snapshot。
- v2 wire decoder、旧subscribe+inspect同步和50ms inspect timer。
- 直接读fixture JSON路径断言“新持久化成功”的测试：改查typed store或独立SQL，不能为测试恢复旧格式。

更新 `audit-workbench.mjs` 只检查这些具体边界，不写通用lint框架。更新 `docs/{workbench-ipc,workbench-storage,workbench-release,workbench-vscode,workbench-telegram,persistence-recovery}.md`、README、CHANGELOG、examples；不把本计划当使用说明。

## T11 [ ] 性能/破坏性回归、CI和发布验收

**新增：** `scripts/workbench-scale.mjs`、`test/workbench-scale.test.ts`、Rust scale/transaction故障测试。fixture通过独立测试工具/typed store生成；不增加生产造数命令。

固定场景和通过条件：

| 场景                                          | 硬通过条件                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| 100k entries，Unicode/escaped text/large tool | 所有页≤1MiB；无重无漏；长内容可切片；inspect/list无transcript              |
| 10k sessions，每页100                         | SQL只读summary并LIMIT；页内存不依赖全部entries                             |
| 同样1k新chunks分别追加到1k/100k历史           | store spy证明读取旧entries=0；无全量state clone/序列化；记录提交bytes与p95 |
| 42轮合法100k字符prompt                        | 所有轮完成；restart后attach/history/content正常；继续下一prompt            |
| 16活跃workers/32 interactions                 | query/control reserve、cancel物理join和跨session进展保持                   |
| SQLITE_FULL/只读/事务失败                     | 不发布成功batch；state不推进；operation不重做；其他可读session可诊断       |
| 真实SIGKILL：事务前/中/后、外部副作用后       | 一致性、interrupted/uncertain、回执、native identity和archive保持          |
| 大历史Chromium                                | ≤300 DOM rows；cache有界；正常流式inspect=0                                |
| live WAL export                               | 复制的独立root可恢复所有committed数据；源bytes/hash不变                    |

性能报告存 `.test-results/scale-*/report.json`：机器/版本、数据量、重复5次的median/p95、峰值RSS、页wire bytes、每commit写入bytes、DB排队时间。108ms原型不是目标。以上结构性断言是必过；另要求100k相较1k历史的“同样1k新增chunks”中位耗时和峰值增量内存≤2倍，超出先查索引/隐式扫描而不是加缓存掩盖。

执行顺序：

```bash
npm run format:check
npm run audit:workbench
npm run check
npm run clippy
npm run test:runner
npm run test:rewrite
npm run test:workbench:scale  # 本任务加入package.json，运行上述scale脚本
npm run test:workbench:soak -- --duration-seconds 600
```

- CI安装x86_64-unknown-linux-musl标准库、musl-tools，重新build-services，并对**该musl产物**执行artifact、IPC和Telegram契约及发布准备测试。任何缺目标依赖不得标PASS。
- 显式执行已有offline真实Pi SDK/native-fork入口；报告ignored默认测试是否真的执行。真实Bot/model不作为默认门禁，但必须列未验证。
- 生产准备通过前不得发布；旧format2数据要先export，切换root到全新format3目录。二进制回退同时回退独立数据root，不能让旧binary打开新DB。

## 2. 提交顺序与最终验收

建议每个T一个提交；T04/T05/T07/T08可按文件再拆，但不要乱序开启新的架构方向。提交消息分别以 `fix(ci)`、`feat(protocol)`、`feat(storage)`、`refactor(session)`、`refactor(fork)`、`feat(ipc)`、`refactor(ui)`、`refactor(telegram)`、`fix(storage)`、`test(scale)`标识。

完成后必须能回答：

- [ ] 旧CI入口/发布文档引用全部消除，当前实际产物被测试。
- [ ] 只有一个SQLite backend、一个数据库线程；无格式2读者/双写。
- [ ] 热actor不拥有历史，普通提交不读/写全部历史。
- [ ] list/view/history/content/command receipt用途分离，wire预算有真实测试。
- [ ] attach无丢失窗口，一个revision一个batch，正常流式无inspect风暴。
- [ ] fork hash/歧义/历史设置/取消/uncertain语义与基线等价。
- [ ] state/entries/delivery intent同事务；源删除后回执/投递/归档仍可用。
- [ ] 所有mutation仍不自动重放，cancel终态前物理join。
- [ ] 维护不隐式删数据，WAL导出恢复成功，GC范围没有越权扩大。
- [ ] GNU、musl、规模、故障、浏览器、offline SDK结果与未验证项均如实记录。

**这份计划不授权：**恢复旧兼容路径、重写worker/调度框架、引入ORM/连接池/事件日志服务、自动清理stale socket/真实数据、在线迁移或自动过期防重回执。需要这些功能时另立明确需求，不让执行模型顺手扩展。
