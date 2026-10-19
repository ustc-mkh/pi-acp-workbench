# Workbench 收尾完善计划：正确性、竞态与有界消费

> **历史执行记录，后续执行权已移交。** 新的功能恢复、架构减负与性能工作以 [功能对齐与架构减负计划](workbench-parity-and-simplification-plan.md) 为准。本文件保留上一轮 R01–R08 的任务与证据；其中“单 SQLite executor”“禁止第二数据库线程”等固定约束不再约束后续阶段。旧实现计划与完成声明见 [implementation checkpoint](workbench-follow-up-plan-implementation-checkpoint.md)，更早记录见 [T04 checkpoint](workbench-follow-up-plan-t04-checkpoint.md)。下文“当前”“本轮”均指原审查轮次，不代表新计划已验收。
>
> 审查基线：HEAD `7dd542d` **加当前工作区实现**，不是仅审 HEAD；本轮在既有工作区上完成收尾修复，不提交、不访问真实业务 root。R01–R08 已按下方证据验收；真实 Bot/model、真实 VS Code Extension Host、offline real Pi SDK 与 musl 构建仍明确列为未执行边界。

## 1. 结论与固定边界

核心改造已经落地：单 SQLite executor、增量 Transition、SessionView 热状态、流式 fork、定向 Telegram SQL、独立 delivery manifest、v3 wire。没有发现需要再次推翻后端架构的依据。下一阶段只做竞态修复、有界消费和删除死路径。

必须保留：

- 一个 SQLite Connection/执行线程、有界队列、WAL/FULL、事务与 observer 所有权分离、revision CAS、先 commit 后 publish。
- 原始 operation receipts、防重、worker epoch/turn fence、两阶段 cancel、物理 process join、fork uncertain/unadopted 语义。
- 控制/查询独立配额、Telegram topic FIFO、binding 变化屏障、at-least-once 投递；部分发送后的重复是已知交付语义，不假装 exactly-once。
- frame 8MiB、普通 page/batch 1MiB、view 512KiB、inline 16KiB、slice 64KiB、content 64MiB、image 4MiB、JS safe integer 边界。
- 不新增 ORM、连接池、第二数据库线程、通用状态同步框架、兼容 v2 reader、自动迁移或清库；不用缓存掩盖扫描；不降低 CSP 或删安全断言。

## 2. 审查发现与证据等级

### 2.1 已复现，必须修复

| ID  | 级别    | 位置                                                | 问题与边界                                                                                                                                                                                                        |
| --- | ------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F01 | P2      | `src/workbench-session.ts::batch`                   | 实时窗口淘汰只 shift，不更新 earlier。从空会话接收500条，显示301–500而没有 earlier；旧游标也会跳过后来淘汰的中间区间。数据仍在库中，但当前浏览路径不可达。                                                        |
| F02 | P2      | `workbench-session.ts::latest/earlier`              | latest 请求期间收到401，旧页返回覆盖401；随后402形成[400,402]，revision仍连续而不resync。历史请求交错也只检查attach generation；remove不推进generation，迟到history会重新填充removed的entries。                   |
| F03 | P2      | `workbench-controller.ts::refresh`、UI/browser      | list只读默认50条，丢弃next_cursor；后续会话无UI入口。10k后端分页测试不能替代消费者测试。                                                                                                                          |
| F04 | P2      | `workbench-session.ts::loadTools/refresh`           | 工具页旧Running覆盖新batch的Completed；refresh清空tools却保留旧toolCursor。跨turn及请求倒序同样没有页面请求栅栏。                                                                                                 |
| F05 | P1      | `workbench-controller.ts::receive(execute)`         | authorize后等待load，仅复核selected，未复核trust；load期间撤销信任仍发送prompt。复现只证明前端授权时序缺口，不声称绕过宿主OS权限或恶意provider入侵。                                                              |
| F06 | P2      | `workbench-controller.ts::refresh/upsert`           | 较早list响应会覆盖较新的Created summary；新session仍selected但从列表消失。remove/fork与list同理需要定义线性化顺序。                                                                                               |
| F07 | P2      | `webview/workbench-main.ts` image response          | 图片请求期间翻页，返回图片已不在当前页，代码在pendingImages.delete之前return。4个槽位全部可卡死为Loading，返回原页仍不可重试。Chromium已复现。                                                                    |
| F08 | P2      | `persistence/delivery.rs::dispatch_sql`             | topic heads按order LIMIT后才在scheduler筛retry。1024个deferred heads能隐藏第1025个独立ready topic，在整个延迟区间造成无关topic饥饿。注意不能把retry筛选移到选head之前，否则破坏同topic FIFO。                     |
| F09 | P2      | `telegram/render.rs`、`persistence/telegram_sql.rs` | ACP交互通常expires_at=None，render变成MAX_SAFE_INTEGER；4096 callback总量上限后，常规compact无法清掉这些记录，新按钮永久Backpressure。隔离SQL测试确认。                                                           |
| F10 | P2      | `persistence/database.rs::shutdown`                 | 第一次shutdown取走finished receiver后若被取消，第二次直接在async线程上join。隔离current-thread测试中30ms timeout实际250ms后返回成功，期间executor被阻塞。现实现仍会physical join，不能误报为已证明提前释放lease。 |
| F11 | P2/门禁 | `scripts/workbench-browser-smoke.mjs`               | 首次rewrite被自动favicon请求的img-src CSP错误阻断，独立重跑和full通过；是测试夹具flakiness，尚非生产图片回归。                                                                                                    |

独立证据（临时路径不是永久测试资产）：

- 上轮三个UI问题重新运行：`/tmp/workbench-detail-review/prior-ui.log`；源 `/tmp/workbench-final-review/ui-repro.ts`。
- 新增5个TS边缘复现：`/tmp/workbench-detail-review/races.{ts,mjs,log}`；直接使用生产Session/Controller类，fake client只控制时序。
- 实际Chromium图片槽位复现：`/tmp/workbench-detail-review/image-race.{mjs,log}`。
- 后端源码复制到 `/tmp/workbench-detail-review/rust`，追加独立测试；`backend-proof.log`/`backend-proof.exit`：3项通过，覆盖F08/F09/F10。未在仓库实现文件里插测试。
- 隔离copy首轮缺fixtures/临时crate引用未编译，修正后成功；首次宽泛`independent_`过滤器还误匹配4项依赖完整repo fixture的测试并失败。最终仅`detail_review_`过滤器的3项通过，不能把前次误匹配失败算成仓库回归或隐藏成全套通过。

### 2.2 代码确认的资源/维护问题，不夸大成已复现事故

- `dispatch_snapshot`仍读取全部bindings；scheduler::resolve每条head线性搜索bindings。输出窗口1024并不意味着binding读取或Rust映射有界。F08 fixture已观察到1025 bindings；R04一起删除全集映射。
- Rust IPC限制64连接/8MiB帧，但没有未完成帧期限；同UID客户端可占满连接。TS客户端有partialMs不能保护Rust端。作为可靠性加固，不声称跨用户远程攻击。
- `imageErrors`没有数量上限；content响应没有同ref请求序号，旧offset可覆盖新offset。Controller读内容失败仅发全局error，缺少单请求终结通知。应统一为小型request-id结果协议，而不是增加另一套内容缓存。
- `renderSettings`/`renderTranscript`每次状态更新全量重建DOM，remove二次确认、details展开、焦点/浏览位置可能被流式更新重置。页面有界，尚未做性能基准；以保留交互状态为目标，不引入虚拟滚动或通用DOM diff框架。
- 生产仍有仅测试使用的PayloadStore写接口、Entry/Image投递分支和整entry正文重建；`view_changed`当前始终true，消费者反而必须处理缺view。删除不必要分支比继续加抽象更合适。
- browser smoke的`for (const forbidden of [])`是空审计；专用audit仍检查实际import graph，不能说架构检查全部失效。删空壳，职责归专用audit。
- 原计划正文把T04旧基线、wire-v2描述、旧日志和后续完成声明混在一起；不能继续在同段反复改“本轮通过”。当前计划与历史证据已分离。

### 2.3 本轮未证明为缺陷的边界

- 删除源后投递、fork adoption CAS、cancel join、observer丢弃后事务继续完成等现有安全设计保留；不凭猜测重写。
- Telegram发送成功后ack失败/中途终止可重发已发送片段：at-least-once设计，不在本阶段增加持久化逐片发送账本。
- 同UID外部程序直接修改root/锁文件不在可信host协作模型内；不为此重写整套openat sandbox。

## 3. 唯一执行顺序

顺序固定：**R01 → R02 → R03 → R04 → R05 → R06 → R07 → R08**。每项先加可失败的回归测试，再修实现。不要把所有UI动作串在一条队列上：它会让cancel/answer被慢load/fork堵住。各任务记录最多10行：commit、命令、结果、未执行项、删掉的路径。

### R01 [x] mutation授权栅栏与列表一致性（F05/F06）

**文件：** `src/workbench-controller.ts`、`src/workbench-extension.ts`及controller/extension tests。

1. Controller维护授权失效generation；extension在可观察的workspace trust/授权workspace变化时通知controller。VS Code若没有撤销事件，不假设存在API：最终边界直接读取`workspace.isTrusted`，workspace folders变更与宿主reload/dispose同样使旧流程失效；可观察到的撤销后再授予使旧授权令牌无效。
2. 授权令牌包含selection generation、selected对象、cwd、授权generation；每个await后的副作用边界复核closed/trusted/令牌。尤其load后必须重新authorize cwd，并在最终同步request前再校验；create/fork/cancel_fork同样检查，不在中途变更后继续发送。
3. 已发送命令不因撤销信任自动重发/取消；只阻止后续步骤，UI明确显示已发送步骤可能已生效。
4. list读请求使用独立generation；create/fork/remove的成功receipt与removed batch均使旧list响应失效。不要仅合并旧list数组，因为那会复活已删除summary。
5. 不维护无限summary tombstones：本地mutation时使旧list过期；分页窗口按R03刷新。selected可独立保留一个summary，不因当前list页不含它而取消选择。

**回归：**authorize期间换session、load期间撤销/重新授予trust、dispose、工作区变化、旧list在create/fork/remove后返回；断连不重发mutation；cancel/answer不被慢ordinary步骤阻塞。

**通过：**F05/F06失败用例变绿；最后一次授权失效后新增prompt/config/fork/create发送数=0（已经发送的请求不回滚）。运行controller/extension tests、`npm run check`、`npm run audit:workbench`。

### R02 [x] 一个页面请求所有者，修复history/tools交错（F01/F02/F04）

**文件：** `src/workbench-session.ts`、protocol/UI必要类型、session tests。

1. `latest()`直接复用现有`refresh()/attach`一致性流程；删除它独立history覆盖实时窗口的路径，不再手写第二套latest batch重放。
2. history和tools各有单调request generation。earlier发起时记录当前页面及cursor；同类并发仅最新意图可发布。latest/refresh/stop/lost/stale/removed使两类请求失效。remove必须清空entries/tools/earlier/toolCursor/pending；迟到页不得复活终态内容。
3. 历史页可固定cursor上界，但热view继续收batch。earlier响应后切historical；用户切回latest走attach。请求错误不能覆盖更新页面的状态。
4. 实时窗口淘汰后，基于当前最小保留seq重建earlier：max_entry_seq使用本次已确认view.last_entry_seq、before_seq为最小保留seq。seq从1连续且会话内不单删entry；最小seq=1时无需earlier。不要沿用attach时的旧边界。
5. 工具页记录请求时revision；若请求期间revision变化则丢弃响应，保留新batch并允许显式重读（不自动重试循环）。当前tools仅一个明确turn/page；turn切换及refresh清空cursor。historical tools页不被其他turn的batch混入；本turn后续更新按key合并但不增补到当前页外。
6. 保留200条显示上限及byte上限；去掉每次shift重新JSON.stringify整个数组的循环，先计算总字节/每项字节再线性淘汰，最终完整jsonBytes复核。不要为此新建通用LRU框架。

**回归矩阵：**500条淘汰后向前遍历无重无漏；旧cursor覆盖被淘汰区间；latest×batch；earlier×latest倒序；earlier×remove；tools×Completed batch；跨turn反序；refresh清cursor；stop/lost/gap期间所有旧页失效；attach缓冲溢出仍要求显式恢复。

**运行：**session/client/controller tests；UI逻辑测试必须通过真实peer解析，不能只用忽略schema的fake对象。测试可用可控deferred，不靠sleep概率撞竞态。

### R03 [x] UI显式会话分页与归档读取收尾（F03/F07）

**文件：** `src/workbench-{controller,session,ui}.ts`、`webview/workbench-main.ts`及browser/controller tests。

1. sessions仅保留一个有界页（请求limit=50），UI暴露next_cursor和“下一页/返回最新列表”；不自动抓取所有页、不追加到无限数组。首请求固定max边界。create/fork receipt切回最新列表窗口并局部展示新summary；remove过滤当前页，下一次显式刷新补齐。
2. history/tools/list统一显示各自loading并禁用重复按钮，但正确性仍由request generation保障，不能只靠DOM disabled。
3. read_image/read_content添加UI request_id（单调safe integer），请求和成功/失败响应均回显。与daemon wire request id分离，不更改持久化operation语义。controller必须对已接受UI读取发终结结果；选择变化后的结果可标cancelled/drop，但不能占住browser槽位。
4. browser以(request_id, selection generation, ref identity)关联请求；成功/失败/离页失效均先释放对应pending，再决定是否展示。旧响应不得清除新请求占用。每次state页变化淘汰不再visible的pending/error；同ref倒序内容页只接受最后请求。
5. 图片raw-byte LRU仍32MiB，逐出/切session/unload释放URL。imageErrors最多覆盖当前页可见图片；不保留无限历史错误。content仍最多4项、每项一片，不串接全文。
6. remove确认、展开details及focus用小型按稳定ID状态保存；切session/移出有界页清理。不要引入React、虚拟滚动或全量领域状态；先保障流式更新不会重置用户操作，再按实测优化渲染。

**验收：**51/120会话可逐页选择；创建/删除与在途列表交错；真实Chromium中4图片请求→翻页→响应→返回后槽位释放；成功/失败/断连/切session均可重试；content相反返回不倒退；连续200次失败error数不超过可见集合；streaming时remove确认和展开状态不重置。

### R04 [x] dispatch公平性与binding读取有界（F08）

**文件：** `persistence/{delivery,database}.rs`、`app{,_ingress}.rs`、`telegram/delivery{,_scheduler}.rs`、SQL/contract tests。

1. SQL顺序固定：全部Pending按target取最早head → 当前binding映射effective topic → 每topic取最早head → JOIN该记录 → **仅此处筛选next_retry<=now** → ORDER/LIMIT。绝不先过滤Pending retry再选head；这样deferred head仍阻止本topic后续条目，但不占独立ready topic查询窗口。
2. typed请求改为`DispatchSnapshot { bot, now, limit, active_sessions }`，active_sessions去重且最多8；返回`heads: Vec<{ record, effective_topic }>`和active session当前映射。不再返回全库bindings。
3. effective topic直接由SQL返回并校验typed chat/thread；active映射按(bot_id,session)索引读取，scheduler用小BTreeMap查找。不再为每条record线性搜索全集binding。
4. 同一DB读边界包含head与active mapping；已占lane同时保留old reserved topic和current mapping，join之前两边都不放行。发送前仍复核当前binding及cwd授权。
5. 100ms轮询保留；本阶段不新增通知调度/持久化ready队列，不改变8lane。

**硬测试：**1024/2048 deferred独立topic + 末尾ready topic必须可在一个scan选中；同topic后续ready绝不越过deferred；Session/direct汇合FIFO；rebind时双destination屏障；active session数量≤8且无全bindings反序列化。维持无CORRELATED逐candidate扫描及VM steps线性诊断；大量Pending聚合成本仍明确报告，不声称与全库大小无关。

**运行：**delivery/dispatch Rust tests、`npm run test:contract:workbench:telegram`、scale dispatch case、Clippy。

### R05 [x] callback有限生命周期及容量恢复（F09）

**文件：** `telegram/render.rs`、`persistence/telegram_sql.rs`、`persistence/inbox.rs`及Telegram tests。

1. callback默认有效期固定24小时：`min(interaction.expires_at.unwrap_or(now+86400), now+86400)`，用checked/saturating安全整数计算，保持重复render定义一致。不能每次重试重新now+24h：注册以delivery的稳定时间字段（首次持久创建时间）计算截止；需要schema字段则同一未发布schema切换、隔离新root，不引入迁移reader。
2. 不改原interaction寿命；按钮过期后文本`/answer`仍可基于当前interaction校验。文案明确按钮时限。
3. 新callback注册达到4096前，在同事务清理该bot的expired且无Pending inbox引用的callbacks，再重新检查容量。删除与Pending引用判定必须同事务；不因used_by存在就直接删除，保留Pending恢复所需绑定。
4. 已过期delivery重试不得创建更晚期限或发送可点击死按钮；使用无keyboard的interaction说明/文本answer入口。正常达到4096个仍有效callback时返回可重试Backpressure，不启动无限清理或提高上限。
5. compact继续只删Completed inbox及上述expired未引用callback，不触碰journal/archives/deliveries。旧MAX_SAFE callback root不静默自动改写；当前未发布schema用新root验收，真实root先export并明确版本拒绝策略。

**测试：**无expires_at交互；首次render→重试时间变化key定义不冲突；24h后注册新callback恢复容量；Pending引用阻止删除；consume/admit/compact交错；过期按钮被拒但offset推进正确；legacy root不自动迁移。运行Telegram Rust和contract。

### R06 [x] cancellation-safe数据库关闭与IPC慢帧防护（F10）

**文件：** `persistence/database.rs`、`transport/vscode.rs`及对应tests。

1. shutdown使用数据库已有lifecycle状态保存唯一关闭任务及最终结果；首次调用关闭sender后创建一个owned异步关闭任务，等待finished并通过`spawn_blocking`物理join OS线程。调用者只借用/等待stored JoinHandle，不take后挂起；取消observer不得取消owned关闭过程。后续caller收到同一结果，包括失败，不用None=>Ok掩盖历史错误。
2. 不在async执行线程调用可能阻塞的join；Database Inner最终Drop的同步兜底仍保留且注释清楚，不把Drop当正常关闭。lease只在SQLite Connection关闭后释放，spawn_blocking任务未join前不得宣告shutdown成功。
3. Rust IPC实现固定未完成帧deadline=10秒，从该帧首字节到newline，不随滴入字节重置。完全idle连接无需按10秒断开；已有64连接上限仍保留。读缓冲必须真实按字节增量观察，避免`read_until`内部累计而上层无法启动deadline。
4. 慢帧超时只断开该连接，已accepted durable host任务继续；不abort事务。read/write/stop select保留物理清理职责。

**测试：**pause executor→取消首shutdown→第二caller等待时heartbeat仍运行→恢复→所有caller同结果；shutdown失败结果可重读；Connection已关/线程已join才允许新host lease；partial首字节后滴流10秒仍断开，合法接近8MiB帧不过早误杀；24请求/64连接边界与control reserve保留。

### R07 [x] 删除死路径、固定测试职责、文档清理（F11）

**文件：** `domain/transition.rs`、`persistence/{payload,database}.rs`、`telegram/{render,delivery}.rs`、`scripts/workbench-browser-smoke.mjs`、相关测试和docs。

1. 以非cfg(test)调用图为准，删除只由测试创建的DeliveryPayload::Entry/Image及完整entry重建、put_entry/put_interaction等写API；将必要fixture构造放test-only helper。正常增量`content::put_entry`和生产ImageAsset存储/查询不可误删。Interaction/Notice保留实际调用所需接口。
2. 删除始终true的Transition.view_changed，普通batch固定携带view；removed仍为None。同步Rust/TS验证，不再让合法普通batch无view却由消费者额外补救。无变化仍None transition，不增加revision。
3. `Parts::Legacy`改名为`Parts::Messages`，保留Notice/Interaction的具体Vec路径，不新增trait。为这两个生产入口统一限定渲染文本≤512KiB及既定interaction metadata预算；写入前超限返回typed TooLarge，不截断已归档内容、不提高上限。Turn严格流式，不退回全文render。测试若需大段Agent输出，必须使用Turn而非测试专用Notice旁路。
4. browser fixture显式消除默认favicon请求；保持生产CSP不变、console error零容忍。连续独立启动至少10次；删除空forbidden循环，import graph职责归audit，删v2/T04旧注释。
5. 当前设计文档只描述最终架构/命令/预算；执行计划只记录当前任务。历史测试证据保留原归属，不把旧suite路径写成本轮。

**验收：**生产调用图没有上述死变体/写入旁路；删除前后原子归档/image/Telegram tests通过；audit/check/format/Clippy通过；browser重复运行无favicon CSP误报。不能为了零unused删恢复/安全测试。

### R08 [x] 最终验收与发布决策

1. R01–R07逐项通过后运行`npm run test:rewrite`，必须本轮整条退出0；补跑子项通过不能把失败主命令改写成通过。
2. 执行`node scripts/workbench-startup.mjs`、`node scripts/workbench-scale.mjs`、600秒soak；使用package定义的实际soak命令，不把scale fixture setup耗时当API延迟。报告5次median/p95/RSS/VM steps，结构性硬上限优先。
3. GNU和musl都构建实际production产物并跑artifact/IPC/Telegram契约；offline真实Pi SDK显式执行。环境缺项列为未完成，不把默认ignored或历史证据当本轮执行。
4. Chromium加入本计划的交错矩阵；真实VS Code Extension Host做workspace trust撤销/重新授予、切换workspace、dispose/reopen及分页检查。未执行真实Bot/model需明确列出，不隐含已实测。
5. 新schema root先隔离验证；部署真实数据先export，回退binary同时回退root，不自动迁移/递归清空。未经用户授权不操作真实root、不push。
6. 交付表列每项提交、测试报告路径、未测边界、删除路径。发布标准：F01–F11关闭、资源硬门槛通过、整条门禁稳定；不以“文件更少/行数下降”替代正确性。

## 4. 已有验证与本轮新增验证的边界

上轮独立验收（当前实现）已完成：Rust daemon267+core2、TS188/30文件、runner42、production IPC20/Telegram15、SIGKILL3、startup、GNU打包/artifact、scale7场景各5次、`test:full`。报告：`.test-results/run-zQq65A/`、`.test-results/scale-6e842ee3-bec5-48fb-ad89-5271d7cd1286/`；日志 `/tmp/workbench-final-review/`。同轮`test:rewrite`首次因F11失败，不能称全绿。

本次细节扫描只新增可控竞态复现与隔离后端测试，没有重跑全套rewrite/scale/soak/musl/SDK。临时copy测试使用共享Cargo target，未来正式门禁必须从仓库manifest重新构建，不能把copy的test executable当成production产物。

本轮实现与验证已完成，未commit、未push；未访问真实业务 root。
