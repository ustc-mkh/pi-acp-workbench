# 功能对齐与架构减负计划

> **状态：待执行的后续工作计划，不是完成声明。**
>
> 对比基线：`main@4bf6f32` 与 `rewrite/full-workbench@a5a5fba`。目标是恢复 main 的主要使用体验，同时提高稳定性、减少概念与重复编排；允许修改 IPC、存储 schema、配置和模块边界。**不要求保持旧内部实现、旧数据 reader 或旧协议兼容。**
>
> 本计划接替 [上一轮收尾计划](workbench-follow-up-plan.md) 的后续执行权。上一轮 R01–R08 的修复与测试保留，其“禁止第二数据库线程”“无需再调整架构”等约束不再约束本阶段。历史通过记录不等于本阶段通过；所有新任务初始均为未完成。

## 1. 目标与取舍

优先级：**不丢用户意图、不重复执行副作用、不破坏工作区 > 核心体验对齐 > 可维护性 > 峰值吞吐 > 内部兼容性。**

1. 用户依然可以在桌面与手机创建、继续和管理任务；关闭桌面不终止任务；切换会话不丢草稿、进度或授权入口。
2. 恢复 main 中的重要操作入口与反馈，包括上下文附件、图片输入、会话历史、流式展示、Diff/撤回、模型设置、统计和 Telegram 菜单。不是只保留后端 API。
3. 把“会话所有权、持久化事务、外部副作用恢复、消息投递”分清，而不是继续叠加 actor/journal/transition/outbox 适配层。
4. 允许一次明确的破坏性切换，不引入双协议、双写或长期迁移框架；不自动删除旧数据，不以清空真实 root 来解决升级问题。
5. 不追求自动故障续跑、工具 exactly-once、任意 provider 原生分支、无限历史常驻内存或多文件原子撤回。这些不是 main 已保证的能力。

**完成标准：**本文件的功能矩阵逐项有证据；剩余例外必须单列并经确认。不能以“新测试全绿”“减少了行数”或“已有同名按钮”替代体验对齐。

### 1.1 执行纠偏：以阶段出口推进，不再无限细分局部切片

**以下是后续执行的硬约束。每次收到“继续”，先读本节和当前阶段收尾表，不默认沿上一轮模块继续完善。**

此前 S4 多轮交付了设置、菜单、目录、历史及去重，但阶段主流程仍未打通。原因是局部可靠性持续深化、主干缺口优先级失守，以及小切片反复承担全套验证成本；不能把这些解释为阶段必然缓慢，也不能用测试数量替代进度。

1. **先锁定阶段出口，再选择改动。**每轮开始写明：当前阻塞哪条用户流程、这一轮要消掉什么阻塞、可观察的验收条件。优先补缺失的主干能力，而非继续优化已交付模块。
2. **阶段收尾清单保持有限。**不把实现过程中发现的每个边缘情况都升级为新交付项。非阻塞性 UX 完善、性能微调、扩展矩阵进入待办，不阻塞主流程集成；不得自行扩大阶段验收范围。main 对齐范围或已承诺安全保证若确实无法达成，明确列出差异并请求确认，不自行降低标准。
3. **切片必须跨过用户入口到结果。**允许内部拆实现步骤，但不能连续多轮只交付辅助 ledger、API、重构或同一功能的更多竞态测试，而不减少阶段主流程缺口。确需前置工作时，指出具体依赖和随后的集成步骤；下一轮优先兑现，不继续串联前置工程。
4. **已交付功能默认冻结到阶段集成。**只有复现的正确性/数据安全问题、破坏既有安全保证的回归，或下一条主流程的必要依赖，才允许插队修复；说明证据、影响和最小修复。不能以“更完整/更稳健”为由无限延伸。
5. **分析随决策停止。**先检查现有实现和测试，做出最小可行决定，尽早运行定向集成。没有新证据时，不反复推演同一设计或持续补假设性极端场景。可延期风险记录一次，不在每轮重新展开。
6. **验证分层，不逐小改动重复发布验收。**开发中运行定向测试及必要静态检查；主流程集成点跑完整门禁；阶段收尾/候选发布跑生产制品与完整验收。存储、生命周期或公共协议等高风险变更可提前跑全套，但说明触发原因，复用同一源码版本的证据，不重复跑同一套链路来增加通过记录。详见 §7.3。
7. **进度按阶段缺口减少量报告。**每轮结束列“主流程消掉哪些阻塞、还剩哪几项、下一项是什么”。测试数只作为证据，不作为进度指标。若本轮没有减少主流程缺口，必须解释阻塞原因和解除步骤，不能把它包装为阶段收尾进展。

以上不放松“不丢用户意图、不重复副作用、不破坏工作区”、授权、资源预算、commit-before-publish、fencing/join 等既有安全约束，也不允许以赶进度删除测试、清空业务 root 或隐瞒失败。

## 2. 审查结论：哪些保留，哪些需要改变

### 2.1 已有成果应复用

当前实现已经具备单宿主、typed IPC v3、SQLite 原子增量提交、有界 history/tools/content、冷查询、精确 fork 取消、worker fencing、两阶段 cancel 和独立 Telegram 投递 manifest。上一轮还修复了分页竞态、授权复核、图片槽位、投递饥饿、callback 寿命和 cancellation-safe shutdown。

这些是可靠性资产，不应为了“重新设计得干净”再重写一遍。尤其保留：

- 先 commit 后 publish、revision 检查和不可变归档引用。
- observer 取消不取消已经接受的事务或宿主操作。
- 停止旧 worker 并物理 join 后才宣告终止；旧 epoch/turn 的事件不得污染新任务。
- 原生 fork 的安全 cut、独立 identity、uncertain/unadopted 处理，不退化成提示词重播。
- Telegram 同 topic 顺序、授权复核、at-least-once 和发送不确定性。
- 查询、正文、图片、连接、并发和缓存的硬预算；不通过抬高上限掩盖问题。

### 2.2 当前需要正面处理的问题

| 观察                         | 代码证据                                                                                                                                          | 后续判断                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 单 executor 串行处理所有类别 | `persistence/database.rs::StoreRequest/open_sync`：history、content/image、fork、journal、inbox、delivery 和 commit 共用容量 256 的队列及同一线程 | 存在结构性队头阻塞风险，**尚未证明当前生产吞吐不足**。先量化，再引入最小读写隔离；单写入者不等于单执行者。         |
| command 编排分散             | `app.rs::execute_journaled/execute`、`app_ingress.rs`、`actor_registry.rs`、`actor.rs`、`domain/reducer_transition.rs`、`persistence/journal.rs`  | 接受、执行、状态提交和 receipt 封口跨层；必须明确失败窗口并合并重复职责，而非只把模块改名。                        |
| 状态提交与操作结果分开       | `execute_journaled` 先 begin，再 execute，最后 finish；session commit 在另一条路径完成                                                            | 这是应测试的窗口，不直接断言为已复现的数据损坏。纯本地命令应尽量同事务完成状态与 receipt；外部副作用需要显式阶段。 |
| 部分能力停在 adapter 层      | `src/pi-enhancements.ts`、`pi-session-runs.ts`、`pi-title.ts` 保留扩展能力，但当前 `DomainCommand/AgentEvent` 和 UI 未完整承接旧工作流            | 文件还在不等于功能已恢复；自主轮次、Fast、命名、详细用量要逐层验收。                                               |
| 明显 UI / Telegram 缺口      | 当前 prompt 为纯文本；Webview 提示不支持图片输入；Telegram command 集合缺少旧菜单、history/sync、推送开关等                                       | 按第 3 节恢复使用场景，不复制旧 controller/bridge 整体。                                                           |
| 文档不再能作为功能真相       | README 仍有 IPC v2、完整分页未恢复的描述；存储维护文档仍描述 format2/旧 JSON GC；当前协议与 schema 已为 v3                                        | 第一阶段重建事实表，最后按实现生成/核验文档，不继续堆叠“本轮已完成”。                                              |

当前 SQLite 主实现已经不是“把整个旧 JSON 状态搬进数据库”。不要再开展一次相同的存储重写，也不要把现有增量存储误称为必须全量 replay 的 event sourcing。

## 3. 功能对齐矩阵

“已具备”仅表示代码路径存在，不表示本次已实际运行验收。P0/P1 都属于目标范围；P2 是后续补全顺序，不代表默认删除。

| 场景                        | main 的用户体验                                                       | 当前状态与后续要求                                                                                                          | 优先级 |
| --------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------ |
| 基本对话                    | Enter 发送、Shift+Enter 换行；流式 Markdown；失败保留输入             | 已有文字与 Markdown；补键盘行为、明确发送接受点、失败/断连保留草稿；不自动重发未知结果                                      | P0     |
| 多会话与后台运行            | 新建/切换 Harness 和会话不终止已提交任务                              | 已有基本路径；补切换与 reload 连续性、后台任务状态、重连后重新 attach                                                       | P0     |
| 编辑器上下文                | 选区、显式文件附件、粘贴图片，受上下文预算限制                        | 已有显式选区；恢复文件选择/附件预览/删除、图片粘贴与 provider 能力检查；不从工具 URI 猜读文件                               | P0     |
| 历史与恢复                  | 可访问全部历史，冷会话可查；原生恢复                                  | 已有有界分页与冷查询，不重复建设；补人性化标题/编号、筛选入口、稳定滚动锚点；冷读不得启动 worker                            | P0     |
| reload 后继续操作           | 页面重开能确认任务是否已接受、继续授权/停止                           | 当前 operations 主要在 controller 内存；补最小持久 operation handle 与查询，不保存整个前端领域状态                          | P0     |
| 工具和思考                  | 按轮分组、折叠过程、最终回答突出，必要时查看输出                      | 当前有工具内容/引用及 Thought；恢复稳定消息分组、轮次折叠、思考显示偏好、可用的终端输出；引用本身不等于已支持 terminal 内容 | P0     |
| 授权与停止                  | 双端任一端作答，其他端及时失效；停止不撤销文件修改                    | 已有 typed interaction/cancel；补双端竞态、过期 UI、忙时可操作性，控制入口不被普通任务耗尽                                  | P0     |
| 模型与思考/Fast             | provider 实际能力可选；设置恢复，新会话默认值符合预期                 | 已有 model/mode；补 thinking/Fast 对应 config options、成功后保存偏好、会话自身设置优先；不伪造其他 provider 能力           | P0     |
| Pi 自主后台轮次             | 后台唤醒产生独立轮次，支持停止/授权/历史/通知；不误归上一轮           | adapter 侧有 run 支持，不视为端到端已完成；补领域轮次开始/结束、冲突输入保留与冷恢复测试                                    | P0     |
| Plan/Todo                   | 会话内清单、折叠偏好、恢复后可见                                      | 已有 Plan 与 `/status`；恢复桌面固定区域、状态样式与偏好，不让每条 delta 重建交互状态                                       | P1     |
| 每轮 Diff                   | 实际执行前后工作区净变化，单文件/总 Diff，取消和失败也可审阅          | 未恢复；复用 main 的行为规范与安全测试，独立实现快照/摘要/按需正文                                                          | P1     |
| 手动撤回                    | 用户确认、无脏编辑/冲突、完整快照才恢复；不回退模型上下文             | 未恢复；在 Diff 稳定后单独上线，不以自动 Git reset/checkout 替代                                                            | P1     |
| 用量与模型设置              | 模型/日期/会话统计、缓存 token、费用、价格/可见性/context 设置        | 当前仅基础 token/context；恢复持久明细与聚合、未知/未定价语义、用户覆盖价、模型搜索；不重复计 fork 历史                     | P1     |
| 命名与导出                  | 自动短标题、稳定会话编号、Markdown 导出完整历史                       | 现有标题扩展不等于宿主完整支持；补命名策略、费用归属、手动命名和流式全历史导出                                              | P1     |
| 丰富渲染                    | 代码高亮、LaTeX、Mermaid、图片                                        | 保留已支持渲染；补 Mermaid 与交互一致性，维持 CSP/链接安全及有界媒体缓存                                                    | P1     |
| Telegram 基本操作           | 菜单创建/打开会话、状态/授权/停止、跨端继续                           | 已有 new/attach/status/answer/cancel 等；恢复 `/menu`、`/open`、`/stop` 等熟悉入口，保留新 typed answer 能力                | P0     |
| Telegram 历史与推送         | `/history`、`/history all`、`/sync`；自动推送与静音开关；节流流式预览 | 当前以归档完成投递为主；恢复显式历史同步、用户输入/输出同步、开关和可丢弃预览，不把每个 delta 写入可靠 outbox               | P0     |
| Telegram 排队与中断         | 同 topic 普通提示词排队；stop 清旧队列；interrupt 停止后提交替代输入  | 不能把当前 topic FIFO 等同于全部旧语义；逐项补取消屏障、替代输入及恢复规则，状态查询可独立推进                              | P0     |
| 进程与部署体验              | worker 有总量和空闲回收策略，登录/日志清晰，部署不易误配              | 已有 supervisor/打包；对齐资源策略与可观测错误；旧“8 个长驻 16 天”不是必须复刻的内部机制                                    | P1     |
| Telegram 配置向导及细节偏好 | 安全配对、目录选择、历史列表高度等便捷设置                            | 在核心场景完成后补薄向导与 UI 偏好；仅生成新配置，不恢复双 daemon 自动安装体系                                              | P2     |

不作为功能倒退：Telegram 图片输入在 main 也未支持；不强行把它列入此次对齐。tool binary archive 可作为新能力单列，不混进旧功能缺口。

涉及删除语义时必须区分：单会话 remove、清全部历史、归档保留、待投递内容与 native provider 文件。恢复“清空历史”入口必须有范围预览和二次确认，不能顺手递归删除 native 历史或改成静默重置 root。

## 4. 目标架构：减少重复职责，而不是消灭必要语义

```text
VS Code / Telegram
        │
        ├─ query ───────────────→ ReadService（固定少量只读连接，短快照）
        │
        └─ command → Admission / OperationService
                              │
                     SessionRuntime（一个会话一个串行所有者）
                              │
                    小型状态变更 + 显式副作用阶段
                              │
                       WriteStore（单写入者）
                              │
              一个事务：会话数据 + 必要 receipt + delivery intent
                              │
                 commit 后通知 / provider dispatch

Telegram：独立的 polling / 执行 / 投递监督；预览非可靠，最终结果可靠。
```

### 4.1 会话所有权保留，但缩减 Actor 框架感

- 保留每会话串行 mailbox/owner；这是处理 worker 事件和用户命令竞态的手段，不是必须保留的泛化框架。
- `SessionRuntime` 统一拥有该会话的热 view、worker/adapter handle、epoch、turn 和短期协调状态。registry 只负责查找、创建、淘汰，不再次解释领域命令。
- admission 只负责入口授权、配额、排队和 operation identity；不再维护第二套会话 phase。
- 不把耗时 provider I/O 放进阻塞 mailbox 的长 await；用显式进行中阶段与带 fence 的完成消息回来推进。cancel/answer 需有可用控制容量，但不能越过已定义的同会话因果边界。
- 不同时大改 supervisor 的进程回收协议；先把它作为可靠底座，由 runtime 调用。

### 4.2 Journal 收敛为 Operation receipts，不做通用事件账本

将 `JournalStore` 收敛为事务内的 operation 表访问，业务入口不再普遍手工 `begin → execute → finish`：

| 操作类型                                                    | 目标处理                                                                                                    |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 纯查询                                                      | 无 operation journal，不写库，不创建 actor                                                                  |
| 纯本地状态变更                                              | 指纹校验、防重、状态写入和 terminal receipt 同事务提交                                                      |
| prompt 接受                                                 | 持久接受的 turn/input 与 receipt 对齐；receipt 表示“任务已接受”，不是“模型执行成功”                         |
| provider configure / native fork / 撤回 / Telegram 建 topic | 保留必要的 prepare/外部调用/settle；崩溃窗口显式为 uncertain 或 interrupted，不自动重试不可证明幂等的副作用 |
| Telegram 发送                                               | 由 delivery 重试，不通过 operation 重跑 Agent                                                               |

- 所有对外命令写清 receipt 的线性化点；外部副作用执行失败通过任务状态表达，不能用泛化 `failed` 隐去“已经接受/部分生效”。
- phase 只针对真正跨进程/文件系统边界的操作存在；不为每个 UI 点击引入通用 workflow engine。
- 相同 operation + 相同指纹返回同一结果/明确的进行中或不确定状态；相同 operation + 不同指纹拒绝。崩溃后不得换 ID 自动重发。
- 新增按 ID 查询 operation 的窄接口，供 reload 恢复。前端仅保留有界未决 handles，结果以宿主为准。
- terminal receipt、去重 tombstone、inbox 引用和 GC 保留期一起设计；不要通过删除过期 receipt 让旧 ID 重新执行。

### 4.3 Transition 保留纯计算价值，删除重复中间表示

- 保留“小型 typed change + revision CAS + 一个事务”的方式，不退回全历史重建或完整 SessionState 拷贝。
- 现有 Transition 可继续用，也可收敛为私有 `SessionChange`。重点是同一命令不再依次经过多套可写状态、event/projection 转换与结果拼装，而不是名字少一个。
- owner 计算一次变更；WriteStore 校验并提交；返回已提交 batch/receipt；owner 更新热状态并发布。提交失败不发布，迟到提交/完成消息必须检查 fence。
- 移除没有生产替代实现的 trait/facade、测试专用写 API、重复 OwnerReply/receipt 转换；fixture 构造留在测试侧。删前必须确认生产调用图。
- 不引入通用 reducer/plugin/event bus/ORM，不要求为未来可能出现的第二种数据库保留抽象。

### 4.4 Outbox 只保留 Telegram 可靠交付职责

- 可靠 outbox 保留：最终答复、授权入口、明确的任务结果与控制回复确实需要重启后重试。
- 直接使用事务提交的不可变内容引用和 delivery manifest；不另维护一份可重放的会话投影来重新生成它。
- ephemeral streaming preview 走有界、可合并的内存通道，限频 edit；崩溃可丢弃，不作为完成证据。最终消息仍走 durable delivery。
- history/sync 使用明确的导出任务/cursor 和稳定 dedup key，复用 sender；不是再造一套完整历史副本或逐 delta journal。
- 保留 topic FIFO、binding 变更屏障、八 lane 等已验证机制；除非基准证明必须改变，不和本轮架构收敛同时重写 scheduler。
- at-least-once 不变：部分发送后重试可能重复；不以新增无限逐片账本换取无法真实保证的 exactly-once。

## 5. SQLite：拆除单执行者瓶颈，暂不分库

### 5.1 推荐落点

**一个写连接/专用线程 + 固定小规模只读执行器（初始 2 个）+ 同一 SQLite 文件/WAL。**连接数是明确预算，不引入通用动态连接池。所有 rusqlite 阻塞工作留在专用线程，不阻塞 Tokio executor。

SQLite WAL 允许读写并行，但仍只有一个 writer；长读事务也会阻碍 checkpoint 推进。因此读写隔离解决的是查询挡住写入，不是让多路写入同时提交。不要用“增加连接”包装写吞吐无限扩展的承诺。

### 5.2 实施边界

1. **先埋点再切换：**按请求类型记录 enqueue wait、SQL 时间、序列化/校验时间、返回字节、总延迟、队列深度、事务耗时、WAL 大小与 checkpoint 结果。日志不含正文/token。
2. **分类路由：**list/history/tools/content/image、统计和导出走 read；session commit、receipt、inbox、binding、delivery ack 走 write。涉及 admission 原子判定或“读后立即写”的操作不拆到 reader 后拿旧结果写入。
3. **短一致性快照：**attach 的 view+recent page、dispatch 的 heads+active binding 必须各自来自一个数据库快照。不能拆成随意两次 read；不保留跨网络/用户翻页的长事务。
4. **读后写可见性：**成功 receipt 只在 commit 后返回；依赖该提交的查询使用提交后开始的新快照。attach 订阅仍通过 revision/gap 补齐，不能因加 reader 引入丢 batch 窗口。
5. **写入服务质量：**单队列 256 的实现可以改成有界分类入口与公平调度；给控制状态提交留容量，但不乱序同会话变更、operation 因果与 delivery admission 顺序。预留 slot 不等于可抢占正在执行的长事务。
6. **大任务分片：**导出、统计、fork 准备及维护不应长期占用实时路径。按条数/字节分片，明确一致性边界；fork adopt 等必须原子的事务不能为了延迟随意拆开。
7. **生命周期：**reader 和 writer 都由同一 storage lifecycle 持有；停止接受 → drain accepted writes → 等待读取/后台任务 → 关闭连接并 join → 释放 lease。调用者取消 shutdown 不改变此顺序。
8. **WAL：**记录长 reader、checkpoint busy/进度和磁盘增长；用 page 级短事务避免 checkpoint starvation。在线路径不突然运行阻塞式大 VACUUM/全库 GC。

### 5.3 何时才继续升级

- 若只读请求仍拖慢控制延迟：先检查 SQL 计划、正文反序列化和事务长度，不先把 reader 数量扩大。
- 若写队列持续饱和：量化每轮 commit/fsync/字节。可合并相邻文本 delta 的短批次，但不得跨 interaction、完成、cancel 或配置边界，且明确可丢失的未提交尾部与展示延迟；不能降同步等级冒充优化。
- 只有以上仍达不到第 7 节预算时，才另立 ADR 评估独立 blob 文件、按用途/会话分库或更换数据库。分库失去跨表原子性，会重新引入协调成本；本计划不预先承担。

## 6. 分阶段执行清单

任务以可独立验收的小 PR/commit 推进。每项记录：基线、改变的用户场景、删除的重复路径、schema/wire 变化、测试结果与未测项。不边做功能边无期限保留旧新双路径。

### S0 [ ] 冻结体验基线与可执行 oracle

**范围：**新增 `docs/feature-parity.md`，测试 fixture，当前文档修正。

- 从 main 的 README、usage、telegram、turn-diff 和相关测试提炼用户脚本；旧源码用 `git show main:...` 参考，不重新挂入生产构建。
- 将第 3 节拆成逐项 case：旧行为、当前事实、目标行为、provider 差异、证据路径。尤其区分“支持 tool diff 展示”与“完整工作区 Diff/撤回”。
- 在 main 独立 worktree/隔离 root 采集关键 UI/Telegram 交互与协议 trace；无法执行的列为规范参考，不假称实测。
- 修正 README、存储/Telegram/IPC 文档版本和失效描述；给历史计划统一标注历史状态。
- 跑当前整条门禁建立真实基线，同时建立第 7 节混合负载基准。旧报告只作参考。

**出口：**每个 P0/P1 有验收脚本或人工步骤、当前状态及目标；不再靠“感觉还缺一些功能”推进。

### S1 [ ] 打通状态提交与 receipt 的一致性边界

**范围：**`app.rs`、`app_ingress.rs`、`actor*.rs`、`persistence/{journal,query,database}.rs`、领域变更类型。

- 先对 create、remove、model/mode、prompt 接受建立失败窗口测试，再逐个收敛为第 4 节事务边界。
- 用 create → prompt → answer → cancel 一条纵向切片验证新的运行时职责；旧对应路径在切片通过后删除，不保留两套 executor service。
- 明确配置/fork/文件撤回等外部操作的 prepare/settle 与崩溃结果；不使用通用“全部重试”策略。
- 提供 operation 查询，补 reload 恢复，不让 UI 必须保留原 socket 才能确认结果。
- 复用现有 worker join、epoch、fork controls 与 Telegram delivery 协议；改接口时同步迁移故障测试。

**出口：**纯本地 mutation 不再出现“状态提交了但其 terminal receipt 尚未提交”的双事务窗口；外部操作窗口都有明确可查询的结果语义。生产调用图少一层重复编排，而非多一层新 façade。

### S2 [ ] SQLite 读写隔离与负载边界

**依赖：**S1 的事务 API 稳定；S0 埋点/基准可先行。

- 按第 5 节接入两个固定 readers 与一个 writer；reader 只读且不可持有写事务。
- 分别验证 attach、dispatch、分页、读后写和 remove 并发的一致性；旧“只有一个 connection”的断言改成具体的事务与资源断言。
- 新增读取阻塞/慢查询、长读 checkpoint、队列饱和、取消等待、关闭重入和 lease 独占测试。
- 重构以实测降低混合负载下控制命令等待为目标；若无收益或增加无法接受的复杂度，回滚 reader 具体实现并记录结论，不能仅为“用了多线程”合并。

**出口：**满足第 7 节基准，运行时不在 async 线程执行 SQLite 或 blocking join；每次 attach/dispatch 保持快照一致性。

### S3 [ ] 恢复桌面核心输入与多轮体验

**范围：**`src/workbench-*`、Webview、ACP DTO/content/settings/extensions、最小领域能力扩展。

- 先把 prompt 从单字符串演进为有预算的 typed text/image/context parts；附件明确来源、预览、移除，文本附件不无限嵌入 view。
- 恢复快捷键、显式文件附件、图片粘贴；发送接受与实际完成分开反馈，未知结果保留操作 handle，不能换 ID 重发。
- 补思考/工具按轮分组、稳定 message identity、自动折叠、Plan 固定区域、滚动/焦点/展开状态；局部更新优先，不引入全状态同步框架。
- 接通 thinking/Fast/config options、已成功应用的默认偏好、模型能力可见性；保留当前配置恢复保护。
- 接通 Pi autonomous run 的端到端生命周期，覆盖 busy/用户输入竞争、授权、停止、重启后只读与继续任务。
- 恢复 reconnect/reload：重连只恢复观察和查询 receipt，不重发 mutation。草稿与有限 UI 偏好由客户端保存。

**出口：**第 3 节桌面 P0 全部可从 UI 操作，Pi 真实 adapter 和 synthetic peer 都有证据；Codex/Claude 按实际能力给出清晰降级。

### S4 [x] 恢复 Telegram 日常工作流

**范围：**`telegram/{command,admission,execution,render,delivery,runtime}.*`、inbox/binding/settings SQL。

- `/menu`、目录/Harness/模型选择、分页打开会话、状态和授权入口；同一命令实现同时服务文本与按钮，不另建第二个 command engine。
- 恢复 `/stop`、`/interrupt`、排队提示与取消屏障；清旧队列只影响被明确覆盖的输入，持久记录不静默失踪。
- 补 `/history`、`/history all`、`/sync`；请求范围明确、有界分页、可重复不重发已导出片段。建 topic 的 uncertain 仍需显式处理。
- 补 notifications/silent 持久开关；关闭自动推送不停止 Agent、不隐藏拒绝/未知结果；主动 status/history 仍可使用。
- 增加有界节流预览，最终回复与授权保持可靠投递。验证中文/emoji/代码、长回复和图片顺序；禁止新建第二套归档。

**出口：**手机可不借助 VS Code 完成创建→排队/运行→授权→停止/中断→历史→继续的完整流程；断网/429/重启不重跑 Agent。

#### S4 当前收尾顺序（执行纠偏后）

完成 S4 的自动化阶段出口证据列于 `docs/workbench-parity-execution.md`「S4 最终自动化验收」。旧工作树局部状态与未运行的 live/Extension Host/2小时 soak/SLO 仍不得写成已验。

按以下顺序推进，除复现的安全/正确性回归或必要依赖外，不插入周边功能：

| 顺序 | 主干收尾项                  | 完成条件                                                                                                                                                                                                               |
| ---- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | 排队、`/stop`、`/interrupt` | 同 topic A/B 输入有可见排队反馈；stop 明确取消哪些旧输入并保留持久结果；interrupt 停止后接受替代输入，旧任务/晚到事件不得越过屏障；status/授权仍可操作；重启不重放未知副作用。                                         |
| 2    | 首任务前模型选择            | 手机从目录/Harness 创建后，无须发送业务 prompt，就能发现并选择 provider 实际支持的模型；不伪造 catalogue，不将“先跑一次任务”算完成。若必须启动受控发现，应明确生命周期和预算，而非将冷查询原则变成无法完成流程的借口。 |
| 3    | `/sync` 与自动输入同步      | `/sync` 不再是预览占位：按 main 规范实现可访问会话的明确范围/有界批次、话题副作用的 uncertain 处理、去重与恢复；新输入在适用的话题可同步，与已交付输出同步连通，不回放 Agent。                                         |
| 4    | 有界节流预览                | 运行期间有可见、限频、可合并的预览；崩溃可丢弃，授权/错误/最终回复仍可靠，不逐 delta 写可靠 outbox。                                                                                                                   |
| 5    | 一条完整流程验收            | 用同一用户脚本串起创建→首任务前选模型→A/B排队→授权→stop/interrupt→history/sync→继续，加入断网/429/重启；集成测试不能只用各模块分别通过代替。真实手机/provider 验收另列，不拿 synthetic 代替。                          |

每轮选择表内最前面的未完成项，直接实现用户可用链路并补其必要故障证据；确有依赖需调整顺序时先更新原因，不能无声转去别的切片。完成第1–4项后立即进入第5项收尾，不继续自行追加增强功能。自动化就绪与真实环境验收分别记录；未获确认的对齐差异和未跑的必要验收仍阻止勾选整个 S4。

### S5 [ ] 恢复审阅与安全撤回

**范围：**独立 workspace snapshot/diff/undo 模块，领域摘要与归档、VS Code editor ports。

- 从 main 的规范/测试移植安全约束，不整包恢复旧 service。显式采集执行前后快照，包含 shell 写入；不是只汇总 ACP tool diff。
- 沿用旧预算作为起点：5000 文件、单文本 1 MiB、快照文本 16 MiB、详细内容 4 MiB；超限/失败展示 partial，不声称完整。
- 提供本轮文件摘要、按需单文件/总 Diff；取消/失败后尽力完成快照，cold history 不需启动 worker。
- 撤回单独启用：脏编辑检查、before/after 哈希、路径/链接/权限检查、同/父子 workspace 独占门控、确认前后复核。
- 多文件发布可能部分成功，必须返回逐文件结果/uncertain，不能自动重放，也不能承诺文件系统事务。不能通过扩大 workspace 全局锁让正常不同任务都串行。

**出口：**新增/删除/修改/权限/冲突/超限/取消/崩溃都有案例；无后台任务可在撤回许可期间绕过宿主 workspace 门控。外部编辑器和残留后台进程的限制明确显示。

#### S5 当前收尾状态

代码主流程已贯通（审阅→单文件/总 Diff→确认→安全撤回），具体安全边界与入口见 [每轮 Diff/撤回](turn-diff.md)，逐项证据见 [执行记录](workbench-parity-execution.md)。不再追加局部架构切片。阶段未勾选仅表示以下严格出口尚未全部验收，不表示仍缺用户入口：

1. 真实 Extension Host 验证只读原生单/多文件编辑器、未保存 buffer/信任变化及 modal 交互；mock API 与 Chromium port 不能替代。
2. 真实 provider 与发布平台制品验收、2 小时混合 soak/admission SLO 按 §7 单列，不能把短 synthetic 验收写为通过。
3. 与 main 的已知保守差异需确认：符号链接不跟随目标且标为 partial，目前不提供链接文本 Diff；超过 256 文件/64 KiB 路径的完整快照可审阅但不能一次撤回。外部 editor/残留进程仍不受宿主门控，已在 UI/确认文案中明确。

### S6 [ ] 恢复统计、模型管理与内容完善

- 持久保存每轮用量事实及来源；汇总使用索引/分页，不把全量 records 载入 view。对 title、fork、native load、自主轮次定义稳定去重 key。
- 恢复按模型/日期/会话统计，价格覆盖、缓存读写单价、缺失数据/未定价提示；费用估算不冒充账单。
- 恢复模型搜索/分组/可见性、Pi context 配置与刷新；context 配置是显式受信任设置写入，不是普通查询附带副作用。
- 接通自动标题/命名策略、编号；标题调用隔离于主任务，有限时/费用记录，不使首条 prompt 无限等待。
- Markdown 全历史导出使用服务分页/content slices 流式写出；不受当前 200 条 UI 窗口限制，也不构造一个超大 IPC 帧。
- 补 Mermaid、复制/消息操作、显示偏好及 P2 配置向导；沿用安全 renderer 和 CSP，不恢复基于原始 HTML 的旁路。

**出口：**所有 P1 有端到端证据，P2 逐项标为完成或经确认延期；无“adapter 有方法但用户无入口”的假完成。

#### S6 当前收尾状态

本次已按全范围连续接通代码，并统一运行验收，未拆成多轮功能切片。使用入口、事实/价格语义及硬预算见 [用量与模型管理](workbench-management.md)，命令、失败记录及最终构建证据见 [执行记录](workbench-parity-execution.md) 的 S6 节。全历史导出、Mermaid/代码复制复用既有实现；P2 已补新配置向导、目录选择、显式 user/chat allowlist 与有限显示偏好，无默认删除项。

不再有需要继续交付的 S6 辅助模块。未跑的真实 Extension Host（原生对话框/剪贴板/模型设置）、在线 provider/context/title 及其它发布平台/长期性能验收仍单列，不把 synthetic 协议成功写为这些环境已通过；S3 自主轮次/typed 图片等既有缺口不在 S6 中假称恢复。严格阶段勾选仍依赖原 §7 出口，不为赶进度自行降标。

### S7 [ ] 删除旧路径、故障验收与切换

- 删除被替代的 app/owner/journal 转接、test-only 生产 API、过期协议类型、无调用兼容分支、重复 npm aliases 和过时审计规则；同步测试/文档，不用删除测试降低门槛。
- 执行第 7 节完整门禁，追加真实 Extension Host、provider 和 Bot 验收；不能用 mock 成功覆盖真实环境缺项。
- 若 schema/IPC 改变，同一切换点更新 Rust/TS/fixture/manifest；不在每个阶段增一个永久兼容版本。
- 生成发布清单：恢复的功能、行为差异、破坏性变更、备份/切换/回退、未测环境。

**出口：**第 1 节完成标准满足；只保留一条生产实现和一套当前设计说明。

## 7. 验证与性能门槛

### 7.1 场景测试先于补实现

从 main 移植的是行为断言，不是内部对象结构。纯领域规则用单测；故障窗口用可控 barrier/fault injection；跨进程语义用实际 binary+隔离 root；UI 用真实 Chromium，信任/编辑器行为另用 Extension Host。

必须覆盖：

- 两端同时 answer、answer/expiry/cancel、load/撤销信任、切会话/旧分页响应、reload/未知结果。
- autonomous start 与 prompt 竞争、旧 worker 迟到事件、配置成功但 settle 前崩溃、fork 完成但 adoption 未确认。
- commit 前后、receipt 前后、provider dispatch 前后注入 SIGKILL；本地变更与 receipt 原子，外部不确定结果不自动重试。
- inbox offset/分类/command acceptance、Bot 发送后 ack 前崩溃、部分 multipart/429/rebind/源删除；不越过同 topic head，不重新执行 prompt。
- 大历史/长正文/大图/大量工具、慢 consumer、断连、慢 reader/磁盘、队列饱和、连续 shutdown 取消；RSS、队列、连接/线程都有上界。
- Diff/undo 的路径越界、symlink/hardlink、未保存编辑、并发工作区、部分写入失败和重启后不重放。

### 7.2 混合负载基准

沿用现有 startup/scale/soak scripts，新增版本化 mixed workload；固定机器与数据集，至少 5 轮，分别报告 median/p95/p99/max，而非把 5 次运行的均值叫 p95。

建议数据集：10k 会话、单会话 100k entries、1 MiB 正文分页、4 MiB 图片、2048 个 deferred topics；16 个活跃 synthetic sessions、8 个 delivery lanes，叠加历史/图片/导出读取和控制操作。真实 provider 延迟单独报告，不混进存储延迟。

初始合并预算（S0 确认测试硬件后固化，不事后放宽隐藏回归）：

| 指标                                                         | 目标                                                                                                      |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| 已加载会话控制请求从 admission 到 durable fence/本地状态提交 | 混合负载 p95 ≤ 100 ms，p99 ≤ 250 ms；物理 worker stop 时间另外计时                                        |
| 普通 history/list 页面                                       | p95 ≤ 200 ms；与同机器空载对比，不允许无解释退化超过 20%                                                  |
| 读写隔离收益                                                 | 并发大读取时控制延迟显著下降；writer 不再等待纯图片/正文读取完成                                          |
| 公平性                                                       | 2048 个 deferred topics 不隐藏独立 ready topic；普通流量不能耗尽控制/查询保留容量                         |
| 资源                                                         | readers 初始 2、writer 1；沿用现有帧/页/缓存预算；内存不随累计历史/投递条数线性增长                       |
| 持续运行                                                     | 本地 600 秒快速 soak + 发布前至少 2 小时混合 soak；检查趋势/平台值、WAL 和泄漏，不以最后一个 RSS 点下结论 |

若测试硬件或数据库规模使初始数值不可行，先记录瓶颈和修改理由再调整验收；不保证取消一个卡死 provider 的总耗时也小于 100 ms。

### 7.3 仓库门禁

**这是阶段/候选发布的验收集合，不是每个小切片都必须从头完整执行的循环。**按实际 `package.json` 使用以下分层策略：

- **开发迭代：**先跑改动模块的定向单测和一条相关集成用例；按变更运行 typecheck/clippy/format 等必要检查。新失败优先定点定位，不通过反复全量运行碰运气。
- **主流程集成：**一条用户流程贯通或多个切片合并后跑 `test:rewrite` 等完整门禁。高风险的存储、生命周期、公共协议改动可提前执行，并记录原因；不为了少跑测试放过相关风险。
- **阶段收尾/候选发布：**完成下面适用的完整门禁、生产制品契约、性能/soak 和真实环境验收。`test:rewrite` 已包含的检查不再机械重复；仅补它未覆盖的目标、构建配置或故障窗口。同一源码/构建配置的既有有效结果可复用，后续有相关变更则重跑受影响项。
- 记录源码/构建配置、实际命令、结果及未跑项；失败日志保留。文档修改只做相应格式/差异检查，不因更新执行记录再启动整套构建。不能把延期验证写成已通过，也不能以本节削减阶段原定验收标准。

阶段/候选发布至少覆盖：

```sh
npm run check
npm run audit:workbench
npm run format:check
npm run test:rewrite
npm run test:workbench:process-loss
npm run test:workbench:startup
npm run test:workbench:scale
npm run test:workbench:soak -- --duration-seconds 600
```

补充本阶段 mixed benchmark、Extension Host、真实 Pi/Codex/Claude 和 Bot 验收；GNU/musl production 产物分别运行 artifact/IPC/Telegram 契约。真实 SDK 离线 fork、真实模型请求和真实 Bot 是不同证据，不能互相替代。单独补跑通过不抹去整条门禁失败。

## 8. 兼容性与数据策略

### 可以删除

- 旧双 daemon、旧 socket/client、v2/旧 v3 协议 reader、旧配置别名、旧数据自动迁移、旧前端状态补丁。
- 仅为迁移期存在的双写、全量 hydrate、重复投影、无生产调用 façade/trait。
- 旧 provider 特定 fallback，**前提是**不是当前 provider 的合法能力缺省路径，并明确目标支持版本。

### 不能以“兼容代码”为由删除

- 不兼容版本拒绝、损坏校验、storage lease、安全边界、去重 tombstone、epoch fencing、fork safety、partial/uncertain 结果。
- 标准 ACP 的可选字段/无 message ID 路径。比如 `domain/fork_messages.rs` 变量名 `legacy` 也承担缺少 grouping evidence 时的安全候选判定；必须按当前 provider 合同判断，不能按关键词一删了之。
- native provider 文件格式处理。Workbench root 的兼容性和用户 Pi/Codex/Claude 原生文件的可读性是两回事；删 native fallback 前先决定支持版本并实测，不修改源 native 文件来“升级”。

### 切换流程

1. 默认用新的隔离 root 验收。不读取/修改真实业务 root，不执行部署/systemctl/push，除非得到额外授权。
2. 真实切换前停接任务、等待/明确中断未完成操作，离线 export 旧 root 与所需 native 文件，验证备份可读。
3. 默认不开发自动迁移。若需要旧记录可读，优先保留旧 binary+只读备份；确需导入时单独批准一次性离线转换器，不把 reader 留在生产启动路径。
4. 新 binary、VSIX、配置、root 作为一组切换。回退也整组回退；禁止用旧 binary 打开新 schema。
5. 文案明确：体验对齐不代表旧未完成任务跨版本自动续跑，也不代表历史数据默认无缝迁移。

## 9. 建议的第一批交付

不从“再写一个总框架”开始。首批只交付四件事：

1. **功能事实表与基线**：完成 S0，修正文档失实处，锁定缺口和 mixed workload。
2. **事务纵向切片**：create/prompt 接受的 receipt 与状态边界收敛，加 crash-window 测试，删除对应旧编排。
3. **最小读写隔离**：两个 reader，仅迁移 history/content/image；先证明控制延迟收益，再扩大路由。
4. **用户可见切片**：桌面 Enter/附件/图片输入 + reload 操作确认，或 Telegram menu/stop/history 的完整链路；每次交付至少一个用户能直接感知的恢复。

S1/S2 不应成为长时间冻结功能恢复的借口；事务/读写接口确定后，S3/S4 可分模块并行，S5/S6 在稳定接口上推进。不要同时改 runtime、存储、wire、UI 和 Telegram scheduler 后才做第一次集成。

---

### 审查依据与未执行边界

本计划依据 main 的 README、`docs/{usage,telegram,turn-diff,session-service}.md` 与当前 `app/actor/domain/persistence/telegram`、`src/workbench-*`、`webview/workbench-main.ts`、adapter 代码及现有测试入口。SQLite 并发设计参考官方 [Write-Ahead Logging](https://sqlite.org/wal.html) 与 [Checkpoint a database](https://www.sqlite.org/c3ref/wal_checkpoint_v2.html)；其约束不是本仓库已经达成的性能证据。

**本次是代码/文档审查与计划编写，未运行 main/current 的完整门禁、基准、真实 provider/Bot 或 Extension Host；没有证据声称单 executor 已在实际使用中成为性能瓶颈，也没有证据声称本计划的数值预算已经达到。**
