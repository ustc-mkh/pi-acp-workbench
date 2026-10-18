# Workbench 重构后续调整计划

## 1. 目标与结论

本计划基于当前工作区的独立验收，不关联或推进既有 goal。本文是实施建议，不代表以下调整已完成。

目标按优先级排序：

1. 消除已复现的正确性和发布阻断问题。
2. 减少同一业务事实的多份表示、持久化协议和恢复分支。
3. 让内存、磁盘写入、查询成本随实际工作量增长，而非随全部历史反复增长。
4. 保留明确的状态所有权、外部副作用不确定性、取消栅栏和物理进程回收语义。
5. 利用破坏性重构窗口直接更新协议和存储，不为旧版本增加透明兼容、隐式迁移或双写路径。

**不把行数减少、文件减少或“全测试通过”单独作为成功标准。** 优先删除不必要的协议、事务边界和状态副本；安全所需的状态机不能为了短代码而删除。

当前建议：修复发布链路 → 固化新查询/事件契约 → 存储方案决策及实现 → 精简前端同步 → 收拢生命周期与调度 → 保留策略和完整验收。不要同时推进多套替代实现。

## 2. 基线与证据分级

### 2.1 本轮已确认

- `npm run test:rewrite` 通过：类型检查、源码审计、构建、Rust fmt/Clippy、200 项 Rust 测试（另有 1 项 SDK 测试忽略）、19 项 IPC、15 项 Telegram、3 项实际 SIGKILL、9 项 Chromium、完整测试、GNU 生产包及产物冒烟。
- TypeScript 为 29 个测试文件、180 项通过。
- `git diff --check` 通过。
- 完整日志：`/tmp/workbench-acceptance/rewrite.log`；分套件日志：`.test-results/run-Zu6yfb/`。这些是本地临时证据，不应成为长期文档唯一依据。
- 使用真实 daemon 和 synthetic ACP peer，第 42 轮合法的 100,000 字符提示词后，历史文件约 8.43 MB，`inspect` 因响应超限直接 EOF。没有改写真实业务数据。
- CI 仍引用被删除的脚本和旧 daemon；发布脚本仍要求被删除的文档。
- `npm run format:check` 仅因 `.pi/` 运行时状态文件格式失败，生产源码未报格式问题。

### 2.2 源码确认的结构性成本

- `actor_registry.rs` 的 `list` 对全部 SessionState 生成完整快照；`inspect` 返回完整快照。
- `persistence/history.rs` 每次提交读取前一快照、校验，克隆并序列化完整状态及累计 delivery ledger，最后原子替换文件。
- `HistoryStore::project_outbox` 扫描历史快照及其 delivery ledger。需测量实际调用频率和规模成本，不能据此直接声称已出现生产性能事故。
- `workbench-session.ts` 在事件后将视图标记 stale，并用 50 ms 合并窗口反复 inspect；事件本身没有 revision，客户端无法可靠定位快照与事件的先后关系。
- `persistence/io.rs` 读取记录限制为 64 MiB，但写入未见对称限制；历史读取又使用另一条实现。这属于需要补充测试验证的边界风险，不是本轮已复现的数据损坏。
- `JournalStore` 有覆盖文件 I/O 的全局 Mutex。是否构成吞吐瓶颈需要测量，不应立即增加分片锁。

### 2.3 本轮没有证明的事项

真实付费模型/真实 Bot、实际 VS Code Extension Host、musl 发布、夜间长时间运行、大规模真实历史、任意 hung-disk 与整个外部进程树场景。不要把 synthetic 契约或历史验收记录当作本版本的全部生产证明。

## 3. 设计约束：哪些保留，哪些删除

### 保留的核心不变量

- SessionActor 是会话可变业务状态的唯一所有者；transport 不修改领域状态。
- 外部 worker epoch/turn 栅栏阻止迟到消息污染新状态。
- 接受命令与调用方 observer 分离：断连不撤销已接受工作，不自动重放 mutation。
- operation id 相同且请求相同只回放原回执；请求不同必须冲突。
- 取消完成意味着相关物理 worker 已按协议停下并完成 join，不能只改 UI 状态。
- 本地提交先于 committed event 发布；投递失败不能重新执行 agent。
- 对外部副作用的不确定结果明确标记 uncertain，不承诺跨数据库、provider 和 Telegram 的 exactly-once。
- 数据版本不兼容必须明确拒绝，正常启动不隐式删除或迁移数据。

### 主动避免/删除

- 旧 daemon、旧 socket client、旧数据读取器、双协议兼容和双写。
- 无实际调用者的通用 task/actor/store 抽象；按变更原因组织模块，不按行数拆文件。
- 前端复制完整领域 reducer、从时间戳/文本猜身份、自动重试 mutation。
- 为提升吞吐先增加队列层数、actor 层数、锁分片和后台任务。
- 自建通用数据库/WAL/事务框架、任意 JSON 业务容器、仅为测试增加生产协议分支。

## 4. 阶段 A：恢复可靠的工程入口（P0）

### A1. CI 全量迁移

涉及 `.github/workflows/ci.yml`、`scripts/workbench-*-contract.mjs` 和构建脚本。

- 删除 `scripts/browser-smoke.mjs`、`scripts/service-contract.mjs`、旧 daemon 路径的引用。
- browser job 调用当前浏览器入口，并显式准备 Rust 工具链和 Workbench binary。
- 为需要真实二进制的脚本统一一个显式 `--binary ABSOLUTE` 参数；无参数时才允许使用约定的本地 debug 路径。
- production job 的契约必须用本次打出的 musl 二进制，不得隐式回落 debug。
- 缺失或不可执行的显式二进制必须立即失败。

### A2. 发布脚本与文档

涉及 `scripts/prepare-release.mjs`、`docs/workbench-release.md`、VSIX/package 清单。

- 更新 `extension/docs/service-release.md` 的断言为实际发布文档。
- 清除双 daemon 升级说明、失效链接和未对本次产物执行的验证承诺。
- 区分 GNU 本地验收与 musl 生产验收。
- 增加离线发布准备测试：fixture 产物、版本/tag、source commit、dirty 标志、文档清单、哈希和报告；不需要真正创建 GitHub release。

### A3. 工程状态隔离

- 在 `.prettierignore` 中排除 `.pi/` 等运行时状态；禁止用 format 改写 goal 账本。
- 根据团队需求决定 `.pi/` 是否入 `.gitignore`，不擅自删除用户状态。
- 统一高层门禁清单，CI、`test:rewrite`、发布使用同一套命名入口；避免再写一个任意解析 shell/YAML 的大型审计框架。
- 门禁应包含 format:check 和发布准备测试，而不仅是 Rust fmt。

**验收：**全新 checkout 中所有 job 的文件入口存在；错误 binary 参数测试失败；当前生产 binary 确实被契约启动；离线发布准备成功且不引用旧文档；格式检查不扫描运行时账本。

## 5. 阶段 B：重设有界查询与同步协议（P0/P1）

这是已复现长会话问题的根治，不采用单纯扩大 8 MiB 上限的修补。

### B1. 分离三种数据模型

1. `SessionSummary`：id、harness、cwd、status、revision、更新时间和短标题；不含 transcript、完整工具结果或 delivery ledger。
2. `SessionView`：当前状态、catalogue、plan、usage、pending interactions、活动工具摘要、历史边界；不携带全部历史。
3. `TranscriptPage`：有限数量且有限序列化字节的不可变历史条目。

- `list` 返回 summary 页；不得先读取/反序列化全部历史再切片。
- 初次选择会话只读取当前视图和最近一页；滚动时读取更早页。
- 稳定游标基于 session、顺序号和查询边界，不基于文本、数组 offset 或时间戳。
- 删除、并发追加、无效/过期游标和视图 revision 变化的行为写入协议。
- 单条超大工具内容等必须支持有界内容读取，或在产生时明确拒绝；不能只按条目数量分页。
- 命令结果使用独立 typed result；不要继续把查询快照、生命周期事件和持久化回执统一塞进 `Vec<DomainEvent>`。

### B2. 统一事件信封与断线语义

建议事件元数据包含 `session`、`revision` 和独立 `event_seq`。一个 revision 可能发布多项事件，不能假定两者相同。只有在实现证明每次提交恰好一个事件批次后，才合并两个概念。

- attach 的快照边界与订阅边界必须无丢失窗口；通过 session actor 提供有界握手，不在 adapter 中凭空拼接一致性。
- 客户端按序追加历史/更新显示投影，重复事件可丢弃，缺口触发一次重新 attach。
- 慢订阅者明确收到 resync 或断连；内存不允许无限缓存。
- 不强制增加 durable event replay 服务：第一版可通过重新读取有界视图和历史页恢复，减少保留策略与后台任务。
- committed domain event 与可选 ephemeral token preview 严格分开，后者不可作为 fork、授权或操作回执依据。

### B3. 明确字节预算

- 保留 IPC 总帧上限，并设更小的页面目标预算，为 envelope/JSON 转义预留空间。
- Unicode、控制字符转义、大工具结果都按实际 wire bytes 验证，不只按字符数估算。
- 可预判超限的查询返回 typed error，不应以 EOF 代替正常错误。
- 对事件、命令结果、图像、存储记录分别规定输入/输出上限和超限语义。

**验收：**42 轮复现转为必过回归；100,000 条合成历史可列出/读取任意页；列表体积不随 transcript 字节增长；跨页无重无漏；巨大单条内容、并发追加、断线和慢读均有测试；fork 只能使用服务端确认的真实 entry id。

## 6. 阶段 C：收敛持久化，消除全量快照写放大（P1）

### C1. 先做短期 ADR 和可丢弃原型

**推荐优先验证 SQLite 单库方案**，而不是继续扩建自定义 JSON 快照、ledger、outbox 和 journal 协作协议。

推荐原因：历史条目、会话状态、投递 intent 和操作回执之间大量本地事务可以交给同一个数据库；减少 rename/fsync/多文件崩溃前缀和扫描恢复的业务代码。代价是增加数据库依赖、schema 和维护约束，必须量化，不能把第二次大重写当成默认正确。

原型只验证：

- 一次 session commit 原子写入状态、增量历史、delivery intent。
- 历史页/summary 索引查询与备份恢复。
- 16 活跃会话下单写者吞吐、读写延迟和取消/控制命令响应。
- 断电/进程终止后的事务恢复及数据库完整性。
- GNU/musl 构建和 bundled SQLite 的供应链/产物影响。

ADR 必须列出相对当前实现可以删除的实际模块/状态机以及新增复杂度。通过后只保留一种正式存储实现；不在生产运行时支持 JSON/SQLite 可选 backend。

若原型未达到要求，回到一个明确的、范围受限的替代方案：增量 transcript + 小型状态快照，并单独设计原子提交协议。不要同时维护该替代方案和 SQLite。两者择一后再实施 C2。

### C2. 推荐落地结构

建议逻辑实体，而非预先冻结具体 SQL：sessions、entries、当前工具状态、interactions、operations、deliveries。immutable blobs 可保留 content-addressed 文件，但不应再次复制整份 transcript。

- 一个有界数据库写入执行器，串行事务；actor 不持有连接或跨 provider I/O 的事务。
- 数据库阻塞工作放到专用线程或有界 blocking 执行器，不阻塞 Tokio reactor；不要每条 token 无限制 spawn_blocking。
- provider/HTTP 调用始终在数据库事务之外。
- operation Started → 外部调用 → result 的不确定窗口仍然存在，不能因引入数据库而删除 uncertain/interrupted 状态。
- 本地事务提交成功后才发布 committed event；客户端断连不取消事务。
- blob 先写完并验证，再提交引用；失败只允许留下可识别的孤儿，不能留下指向缺失 blob 的有效提交。
- 读模型、操作回执、投递结果不保存包含全部会话历史的大快照。
- 普通启动只做数据库完整性/版本检查和必要恢复，不全量加载所有历史到内存。

### C3. 流式提交与历史粒度

先定义产品语义：是否承诺每个已显示 token 都耐久。默认建议保留已发布 committed 数据的耐久性，不默默降低保证。

- transport chunk 与 durable entry 解耦，provider message id/entry id/turn id 各负其责。
- 增量写入，避免每个 chunk 重写所有历史。
- 仅在测量证明必要时增加有界批处理；明确最大等待、字节量、flush 条件和错误处理。
- permission/form、tool 生命周期、cancel、turn finish、fork 边界必须强制 flush。
- 若引入即时 preview，UI 明示它未提交；preview 不进入可分叉/可回放历史。
- 不为了合并展示修改已发布 entry 身份或历史字节。

### C4. 版本和旧数据

- 新存储使用明确的新版本标记；路径中检测到旧数据时拒绝启动并给出离线处理说明。
- 默认不写迁移器，不双写，不静默重置。
- 实施前导出已有新格式数据。若实际使用者必须保留，单独批准离线导入范围及测试，不把它隐藏在正常启动流程中。

**验收：**崩溃点测试证明状态/历史/intent 原子性；operation 回放不重复外部调用；历史大小增加时单次提交不再重写全部历史；冷列表不读取 transcript；存储新版本显式拒绝旧格式；删除被替代的生产实现。

## 7. 阶段 D：简化前端同步与渲染（P1）

涉及 `src/workbench-session.ts`、`src/workbench-controller.ts`、`webview/workbench-main.ts`。

- 用阶段 B 的 attach/seq 协议替代“每个事件 stale → 50 ms inspect 全快照”。
- 前端仅维护 bounded read projection，不复制领域合法性判断；必要的信任/工作区授权仍在入口执行，最终合法性由宿主决定。
- 删除为缺少 revision 而设置的重复 committed/provisional 对账分支；如保留 preview，单独管理且有硬上限。
- UI 加载最近页并限制 DOM 行数；较长 transcript 不全量 Markdown 重渲染。
- 图片缓存按字节和生命周期限额；切会话/关闭视图撤销不再使用的对象 URL 和 observer。
- 明确所有请求是否有 timeout、是否可能已提交、是否允许显式查回执；不新增自动重发 mutation。
- 移除多余 refresh 链条，让 create/fork/remove 的结果直接驱动最小列表/选择更新；发现序列缺口时才重新取权威状态。

**验收：**正常流式回合无按 token inspect；事件/渲染成本与新内容有关，而非全部历史；切换和销毁时无遗留 observer；同文重复消息、乱序/重复/缺口、图片失败和断连明确展示；真实 Chromium 大历史测试。

## 8. 阶段 E：收拢所有权、调度和异常路径（P2）

不能以删除压力测试覆盖过的 join/epoch/fence 换取表面简化。先画出现有任务和队列所有权图，再调整。

### E1. 单一生命周期模型

- 文档化 root supervisor → transport/Telegram/ingress/runtime → session/worker 的拥有关系。
- 把“关闭 admission → 停物理 worker → settle 已接受事务 → join → 释放 lease/socket”的顺序收敛到一个入口。
- 核对启动半失败路径，尤其 Telegram 已启动但 IPC bind 失败、signal 发生在启动中、清理自身失败。不能只覆盖正常 SIGTERM。
- 若多个 helper 实现同样的任务保留/join 机制，合并为一个小型具体组件；不扩建通用 supervisor 框架。

### E2. 减少重复调度层

- 列清 host ingress、Registry、SessionActor、IPC pools、Telegram execution/delivery 的职责、容量、reject 语义和排队顺序。
- transport 只负责连接/资源预算；会话 FIFO、业务取消和 worker 容量只由明确的业务 owner 决定。
- 删除重复的业务 FIFO/队列，仅在压力和取消测试证明等价后实施。
- 保留 control/query reserve，避免取消和交互回答被普通任务堵住；不要把所有请求塞进单队列。
- 不盲目合并 Telegram 的 execution 与 delivery：其外部失败与 FIFO 语义不同。

### E3. 错误和配置

- 明确区分 invalid input、backpressure、conflict、not found、interrupted、uncertain、storage failure；只在边界编码，不用字符串匹配驱动状态机。
- 归并散落的容量和超时常量，先用一份静态 Limits 定义；没有运维需求的参数不暴露配置。
- 单会话损坏应隔离并显示 typed health 信息；不能静默当作不存在。索引可列出该会话的失败摘要，安全相关的全局格式损坏仍 fail closed。

**验收：**保留现有取消/饱和/observer 丢弃/Registry abort 回归；补齐启动失败矩阵；提交前后任务/队列图可解释、重复 owner 减少；没有新增无界队列或后台任务。

## 9. 阶段 F：有界保留、维护与可观测性（P2）

### F1. 保留策略

- 先定义 replay retention，而不是先删文件：有效回执、过期 tombstone 和原生分叉 uncertainty 的保存期限分别明确。
- operation 过期后不得重新执行；压缩后仍需有防重执行的 durable 记录或明确的全局 epoch/ID 接受策略。
- deliveries 按已确认、待重试、uncertain 区分；pending 不因达到容量被静默删除。
- blob GC 由 typed 引用和事务边界驱动；不按文件名字符串猜引用。
- 第一版离线 maintenance 足够，不自动新增后台 GC daemon。提供 dry-run、备份/导出和同一 lease 排他。
- 删除会话是否保留未投递内容、归档和回执写成公开规则。

### F2. 最小诊断面

增加少量可直接服务排错/性能验收的结构化指标：

- admission/pool 使用量、reject 次数、每阶段排队和执行时长。
- commit 次数/字节、查询读取条数/字节、每页 wire bytes。
- worker 数量/epoch、join 耗时、outbox age/retry、resync 次数。

日志可关联 operation/session/turn/epoch，但不得含 token、凭证、默认完整 prompt 或未经脱敏的 provider 错误。暂不引入完整分布式追踪系统。

**验收：**长运行后容量有明确上限或可执行保留策略；过期回执不能重复副作用；GC 不破坏 pending/uncertain 引用；日志能定位等待与存储瓶颈且无敏感信息。

## 10. 测试与性能验收

### 10.1 测试组织

- 保留独立 synthetic peer/mock Bot，它们是测试替身，不是旧生产实现。
- Domain 测试负责合法转换；storage 测试负责事务/崩溃边界；contract 测试负责 wire/真实进程；浏览器测试负责实际 UI 路径。
- 同一不变量不必在每层穷举，但不能把所有独立契约替换成内部 mock。
- 对取消、operation replay、跨页读取和投递状态增加状态机/性质测试，避免仅依靠固定时序 sleep。
- offline 默认门禁与 opt-in SDK/live 验收明确分开，报告必须列出 skipped 项。
- 把发布准备、当前入口完整性和大历史用例加入默认门禁。

### 10.2 固定基准集

记录机器、版本、cold/warm、数据量、重复次数；报告 median/p95 和峰值，不能只跑一次。

| 场景                                                 | 验收重点                                           |
| ---------------------------------------------------- | -------------------------------------------------- |
| 1k/10k/100k 历史条目，含 Unicode/工具大结果/图片引用 | 有界分页，单次查询不随全部历史增长                 |
| 100/1k/10k 会话摘要，固定页大小                      | 不读取 transcript，内存按页增长                    |
| 相同新增文本分别写入短/长会话                        | 不反复改写全部历史；记录写入字节及 fsync           |
| 1/16 活跃 worker，含等待 permission                  | control/query 可用，跨会话不被 provider I/O 串行化 |
| 慢 socket、慢 HTTP、429、连接丢失                    | 有界内存，无自动重执行，取消有进展                 |
| 提交前后 SIGKILL、启动半失败                         | 恢复原子性、回执不变、lease/进程正确释放           |
| 大历史 Chromium 滚动和流式渲染                       | 有界 DOM/图片缓存，无持续全量重渲染                |

先保存当前基线。绝对延迟指标在同一机器完成基线后冻结，不编造未经测量的毫秒目标。架构硬门槛为：列表不读历史、页面按 bytes 有界、提交不写全部历史、内存不靠历史全集增长、控制请求不无限等待普通任务。

## 11. 建议交付顺序与拆分

1. **PR A：CI、发布、格式范围修复。** 独立可合并，直接解除已确认阻断。
2. **PR B：数据契约 ADR、预算定义、42 轮与大历史回归、性能基线。** 先锁定可验证目标；不一次新增一套未使用的生产 API。
3. **PR C：存储原型结论。** 只选一个 backend，明确格式、事务、线程与删除清单。
4. **PR D：单一存储实现及新版本门禁。** 原有外部入口暂时可由新 store 服务，但不并存双写；预发布阶段不部署。
5. **PR E：有界 list/view/history + attach/event_seq + typed command result。** Rust、TS、browser、Telegram 和 fixture 同步更新；彻底删除旧全量对外协议。
6. **PR F：前端投影/渲染简化。** 删除 inspect 风暴和冗余对账；加入浏览器规模回归。
7. **PR G：生命周期/调度收敛。** 以所有权图和等价测试证明每次删除安全，避免混入存储事务改动。
8. **PR H：维护策略、指标、性能对比与最终发布验收。** GNU/musl 实际产物、离线 SDK、必要的真实客户端验收。

说明：若阶段 B 的有界查询可在现有存储上低成本完成，可提前修复 8 MiB 故障，但最终查询必须下推到 store，不能把“先读全量再分页”当作完成。不要为短期修复建设以后还要保留的第二套索引和恢复协议。

## 12. 最终 Done 标准

- 本轮三项 P1 问题有真实回归，CI/发布链路通过。
- 没有旧生产协议、旧存储 reader、双写和隐式迁移。
- list、view、history、command result 的用途清晰且资源有界。
- 历史/状态/delivery intent 的本地一致性由一个清晰的提交机制保证。
- 前端不运行领域 reducer，不以高频完整 inspect 追流。
- operation、cancel、fork uncertainty、投递 at-least-once 和 join 的保证未削弱。
- 性能报告证明随历史增长的主要放大路径已消除；没有仅凭测试数量宣称性能改善。
- 数据导出、格式拒绝、回滚二进制与数据不兼容的操作说明齐全。
- 实测范围与未验证项明确，不把临时日志、旧记录或 synthetic 覆盖包装成真实生产验收。

## 13. 暂不建议做的事

- 再引入 actor 框架、微服务拆分、消息中间件或自建事件数据库。
- 一开始就实现无限事件回放、全量在线迁移、分布式 exactly-once 或自动恢复所有外部进程状态。
- 未经测量调整并发度、给所有缓存加锁分片、为每个小任务增加 Tokio task。
- 通过扩大帧大小、吞掉损坏记录、自动删 stale socket/旧数据来掩盖设计问题。
- 为追求更小 diff 保留过时生产路径；也不为了追求更少代码删掉证明安全所需的栅栏和持久化状态。
