# Workbench 后续重构设计与实施计划

> **状态：P0 已通过本地统一门禁；P1 核心回归修复、完整验收待 P6；P2 实现及本地统一门禁已完成，真实环境矩阵待 P6；P3 实现及有限本地验收完成，真实环境出口待 P6；P4 实现及有限本地验收完成，真实桌面/原生入口出口待 P6；P5–P6 待执行。** 下文审查发现是修复前基线，不代表全部阶段已修复。审查基线：`main@4bf6f32` → `rewrite/full-workbench@3273be5`。目标是简化实现、提高可靠性和性能，同时恢复既有用户流程；不兼容旧 wire、schema 或配置，但不擅自迁移、删除真实数据或部署服务。

## 1. 审查结论：保留底座，先修合同，再收敛所有权

当前重构方向合理：两个 daemon 合为单宿主；SQLite 替代文件快照/日志协调；冷查询不启动 provider；typed IPC、revision/epoch fence、原生恢复、可靠 Telegram inbox/outbox、物理 join 已有实现和相当多回归测试。**不建议再次整体重写存储、协议或 Telegram 调度器。**

但目前还不能认定“更简单且体验基本等价”：相对 main 为 491 个文件、+60,638/-47,370 行（净增 13,268 行，含测试/文档，不能直接当生产复杂度指标）。真正的问题不是文件数，而是一次操作仍跨多个生命周期所有者，且部分功能只完成了 DTO/方法，没有完成用户闭环。

原计划的主要问题：

1. 将所有权收敛放在图片、配置和自主轮次之后，会先在分散的生命周期上继续加功能，再重写同一批接口。
2. “单一 SessionRuntime”没有明确哪些必须统一、哪些应保留边界，容易把多个小模块合成更大的 `app.rs`。
3. 把不可重复副作用、主流程缺口、视觉细节、通用 GC、平台取证放进同一串阶段，缺少关键路径和有限出口。
4. “底座稳定”“不重复副作用”等描述过于绝对。外部 API 和多文件撤回不可能由 SQLite 保证 exactly-once；当前还有成功 no-op 未封存 receipt 的反例。
5. 遗漏斜杠补全、显式打开链接等旧体验；性能门槛也没有区分排队、持久 fence、provider stop 和远端模型耗时。

新顺序：**P0 修正确性合同 → P1 收敛生命周期/容量 → P2 输入和设置 → P3 自主轮次 → P4 消息投影和桌面体验 → P5 管理/手机/留存 → P6 发布验证。** 每阶段交付一条用户入口到持久结果、重开的完整流程，不先建设通用框架。

## 2. 证据与风险排序

证据标记：**复现**＝本次在隔离实际宿主验证；**静态**＝代码路径明确，但不声称跑过真实 provider；**待验**＝假设或环境验证任务，不当作已确认 bug。

以下 Rust 相对路径均在 `rust/crates/pi-acp-workbenchd/src/`。

| 优先级 | 证据      | 发现及定位                                                                                                                                                                                                                                                             | 处理                                                                           |
| ------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| P0     | 复现      | 冷会话以不同 operation ID 连续两次 `set_model` 为同一值，均返回 Accepted/revision 1；第一次 operation 为 completed，第二次却为 uncertain。`actor.rs::commit_command` 对无 change 直接返回；`app.rs::execute_journaled` 对成功设置又不 finish，Started 永久留下         | 所有成功操作（包括 no-op）必须有持久终态；不能靠增加 session revision 掩盖问题 |
| P0     | 复现      | `max_workers=1`，A 完成后 B 的 prompt Accepted，随后 Failed(`session mailbox is full`)；空闲 A 无法 cancel，删除 A 后 B 手动重试才成功。入口：`scripts/workbench-idle-worker-repro.mjs`；`app.rs::adapters` 保留 handle，`worker.rs::spawn_for` 仅 try-acquire，无回收 | 容量周转与正确错误分类；不能提高上限代替修复                                   |
| P0/P2  | 静态      | `domain/image.rs` 允许 4 MiB 原始图片，`worker.rs::MAX_FRAME` 仅 2 MiB，base64 后更大；当前输出图片合同也可能在合法上限前被 worker 拒绝，未来图片输入必然受影响                                                                                                        | 先统一端到端字节预算，不只在 UI 增加图片按钮                                   |
| P1     | 静态      | 生命周期分散于 ingress lane、registry/actor、`CommandCore.adapters`、fork controls、Reviews 和 supervisor。创建成功后还主动 LoadSession 暖 actor；registry 无热 actor 淘汰上限                                                                                         | 统一会话协调所有权，保留协议/存储边界；限制热会话数                            |
| P1     | 静态      | `acp/adapter.rs` 空闲通知以 `turn=None` 处理，除目录/配置等外不转领域事件；空闲请求直接 Cancel。Pi TS 已声明 autonomousRuns，但宿主未闭环                                                                                                                              | 独立后台轮次，不能把上一轮 turn ID 借给后台输出                                |
| P1     | 静态      | `src/workbench-input.ts::composePrompt` 将文件拼成纯文本；ACP prompt 固定单个 text block；settings 虽解码 config options，领域只保留 model/mode                                                                                                                        | typed prompt parts、受预算的实际 provider options                              |
| P1     | 静态      | `webview/workbench-main.ts` 按 entry 建 article，分片各自渲染 Markdown；链接统一 preventDefault。terminal 只存引用；领域保存 available commands，UI 无补全入口                                                                                                         | 共享消息分组规则，稳定 DOM，恢复确认打开链接/补全/正文读取                     |
| P2     | 静态      | `persistence/database.rs` Diff 页/正文每次取整行 JSON 并解码（存档上限 32 MiB），然后才分页；小响应不等于小查询成本                                                                                                                                                    | 先基准测量；达到瓶颈后再拆文件头/正文，不先重写数据库                          |
| P2     | 静态/待验 | ingress 的 control reserve 只保证有名额，不保证可越过同 session 的 discovery/configure/fork 长等待；`app_ingress.rs::lane` 仍按 FIFO 串行                                                                                                                              | 明确可中断边界和延迟口径；用 barrier 测试再修改，不宣称所有控制均能抢占        |
| P2     | 静态      | 通用 archive/operation/delivery GC 未实现；Telegram 只做局部 typed compaction。桌面全历史筛选/共享历史清空缺失；手机 history 每源 scan cap 200，消息可能跨批                                                                                                           | 按真实可达关系及 continuation 修复，不无限扩限或按字符串猜引用                 |
| P2     | 待验      | 媒体解码预算、provider native cut 边界、长期 RSS/WAL、真实 Webview/provider/Bot/musl                                                                                                                                                                                   | 分清实现缺口与验证缺口，不能用 synthetic 绿灯替代                              |

### 本次实际检查

- `npm run check`、`npm run audit:workbench`：通过。
- `cargo test --manifest-path rust/Cargo.toml -p pi-acp-workbenchd --lib -- --test-threads=4`：338 passed、2 ignored；忽略项不算通过证据。
- `npx vitest run test/workbench-{client,protocol,session,controller,browser,reconnect,recovery-races}.test.ts`：7 files / 76 tests 通过。
- `cargo build --manifest-path rust/Cargo.toml -p pi-acp-workbenchd`：通过；隔离实际 IPC 连续同值设置复现上述 uncertain。回归实现时将该场景固化进现有 replay/contract 测试。
- worker 故障脚本复现既有失败，不是通过门禁。
- 未跑完整 `test:rewrite`、Chromium smoke、真实 Extension Host、在线 provider/Bot、长期负载或生产目标制品。本次不是全量逐行审计，也不据此断言没有其它缺陷。

## 3. 目标设计：少一层编排，不是少一层安全

### 3.1 组件职责及唯一所有者

```text
VS Code / Telegram
       │ 授权、身份、输入分类
       ▼
有界 host admission ──────────────► QueryService ─► 两个固定 readers
       │ operation + session route
       ▼
SessionCoordinator（每个热会话一个）
  ├─ SessionView / turn / epoch / pending intent
  ├─ adapter handle / workspace lease / review 生命周期
  └─ 短操作提交；长操作以带 fence 的 completion 回来
       │                         │
       ▼                         ▼
WriteStore（一个 writer）     AcpAdapter / WorkerSupervisor
状态 + receipt + delivery     协议状态/请求相关性；进程槽位/物理 join
```

- **Coordinator 在现有 actor 上演进**，不额外长期保留另一套 runtime。它拥有领域热态及副作用的生命周期句柄，不拥有 JSON-RPC pending map、媒体正文缓存或 Telegram topic 状态。
- Registry 仅负责 get-or-load、路由、热会话预算和安全退场；admission 仅负责配额、身份及明确的入口顺序，不再解释第二套领域 phase。
- Adapter 保留 native protocol/session details、请求/响应配对及内容转换；完成消息携带 session、runtime generation/epoch、turn 或 workflow identity。Coordinator 验证后才提交事实。
- Supervisor 只负责全局进程预算、启动和 join。**会话是否可驱逐由 Coordinator 判定**，不能由 supervisor 猜测“进程无输出即空闲”。
- Reviews 的 before/after、gate lease 随 turn/workflow 生命周期；不能留一个与 worker 和 turn 各自推进的无界 session map。
- 冷 attach/list/history/export/统计不创建 Coordinator 或 worker；create 只写本地事实，不为了“可能下一步发送”永久暖 owner。
- Telegram inbox 是持久输入队列，outbox 是可靠输出队列；保留现有 topic FIFO/八 delivery lanes，不再增加第二套 sender、持久 workflow engine 或每分片 ledger。

### 3.2 操作提交合同

| 操作类型                                               | 提交方式                                                                                | 崩溃/重开                                                                |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 纯本地 mutation，如 create、元数据、冷设置、成功 no-op | 去重检查 + 本地变化（可为空）+ terminal receipt 同事务；无变化不发 batch、不增 revision | 原 operation 查询/同参重放得到原终态                                     |
| prompt/answer                                          | 持久接受与输入/答案、receipt、必要 delivery intent 原子提交；随后 dispatch              | Accepted 不代表模型执行成功；dispatch 失败记任务状态，不把输入改称未接受 |
| configure、native fork、外部 context、topic effect     | 持久 prepare → 一次远端尝试 → 观察结果 → settle；可用的本地结果和 receipt 同事务        | prepared 只证明可能执行；unknown/uncertain 不自动重发，保留可查询身份    |
| cancel/remove/undo                                     | 显式 fence/准备 → 物理 join 或受控文件副作用 → 持久结果                                 | stop 不回滚费用/文件；undo 多文件逐项结果，丢回执查原 operation          |

不将所有操作塞进统一 begin→execute→finish。特别是本地 no-op 不能因为没有 session change 就跳过 receipt；外部副作用又不能因“减少事务”而删除 prepare。清点每种 mutation 的 commit point、dispatch point 和恢复结果后，再删除旧编排路径。

### 3.3 容量、回收和控制

- **两个独立预算**：provider worker 数、热 Coordinator 数；再限制每会话 mailbox、在途长操作、媒体缓存。历史总量不计入热状态预算。
- Worker 明确 starting/running/waiting-interaction/idle/stopping，以及 pin 原因、最后活动时间。只有无活跃 turn/交互/config/fork/标题调用等且 provider 允许原生恢复时可回收。
- 先做压力触发的 idle LRU，再加有限 idle TTL；同一被选中 worker 只能有一次 eviction。标记 draining/fence → stop/join → 释放槽位 → 新启动，期间新输入要么排入有界等待，要么明确拒绝，不能落入已关闭 adapter。
- Pi 后台运行能力必须有明确 pin/释放合同。没有证据证明“无后台待唤醒工作”时，不把普通 Idle 当作可回收；全被 pin 时给出真实容量原因。不能一边承诺后台唤醒不丢、一边静默杀进程。
- Coordinator 淘汰还需无 worker、无未结算副作用/accepted write；drain/join 后才能替换，registry generation 防止退场旧完成消息污染新 owner。
- 长 provider I/O 不占 mailbox 控制入口：登记 intent 后启动受监管有界 job，以 completion 推进。FIFO 仍约束配置/分支/输入等因果顺序；cancel 可打断哪些等待必须逐项规定，不能任意越过 mutation。

### 3.4 消息、输入和预算

- 存储 entry 不可变，**显示消息不是 entry**。按 turn、role、可信 provider message ID 和明确边界生成逻辑消息；无 ID 不猜合并，跨 tool/图片/消息边界不乱拼。
- 桌面、Telegram、导出复用同一套可测试的分组语义（可各自实现投影，不新增跨语言服务）。分页带 continuation/边界信息；不能把一个 provider 消息在下一批当成新消息或截断后伪称完整。
- Prompt 为有序 text/context/image parts；context 只包含用户明确选取的内容和来源说明，image 用不可变 asset/ref。不将工具路径/URI 当成本地读取许可。
- **区分 raw bytes、base64 bytes、JSON envelope、UTF-8 字节、JS 字符/UTF-16 单元。** 编码扩张和 JSON 转义必须算入预算，失败必须在持久接受前可预见，或作为明确的已接受后失败事实。
- IPC 8 MiB、ACP 当前 2 MiB、image raw 4 MiB 需统一设计。选择受限的大媒体帧或合法分块/引用能力，不无上限扩大所有帧；最大合法中文文本、图片、tool output 都经真实 stdio 测试。
- 图片在输入/归档边界做完整解码、像素/尺寸/帧数/内存预算及必要重编码；signature/hash 验证不是 sanitization。解码不占 writer，不使用任意远程 URL 回退。

## 4. 实施阶段与可验证出口

阶段状态以各标题及有限验收结果为准；下列后续阶段仍待执行。实施中只在本文件更新有限状态/结果，日志保存在 `.test-results/`，不新增多份 checkpoint/ledger。

### P0 [x] 修正操作及边界合同

**涉及：**`app.rs`、`actor.rs`、`persistence/journal.rs`、transition/store、worker codec、现有 replay/contract 测试。

1. 固化 no-op 复现：不同 operation 的同值 model/mode，以及所有可能无变化的本地 mutation；返回成功后 status 必须 completed，重开/删除源后仍可查原 receipt，同 ID 异参 conflict。
2. 为本地 no-op 提供 receipt-only 原子提交，不伪增 revision；审计 mutation 分类，列明需要 prepare 的外部路径。纯本地路径逐步去掉多余 Started 事务，失败和未知结果不混淆。
3. 统一图片/文本/媒体的端到端预算，修复 ACP 合法 asset 到不了的上限冲突；测试最大合法帧及恰好越界，不只测试小 PNG。
4. 拆分 worker capacity、mailbox full、closed、provider unsupported 错误；保留 Accepted 后任务失败的语义。

**P0 实现与验收结果：**

- actor 对无 change 的成功命令提交 receipt-only transaction，不改 session revision、不发布 batch。冷 model/mode 与本地 Rename/Model/Visibility/Naming 经只读去重后直接进入状态/receipt 原子提交，不再提前持久化 Started；写入或 receipt 失败同事务回滚。create 保留已有单事务路径。
- 副作用分类：prompt/answer 保留接受前 prepare 与原子 Accepted，dispatch 在其后；warm configure 保留 Started + configuration intent；cancel/remove 保留 fence/stop/join；native fork/cancel-fork、外部 RefreshModels/Context 和 undo 保留 prepare，不把 unknown 当作可自动重发的本地失败。此轮不重写这些外部编排。
- ACP 普通 payload 仍限 2 MiB（不含换行）；仅 agent image notification 可使用 `ceil(4 MiB / 3) * 4 + 64 KiB` 有界大帧，且验证 raw/base64 与独立 envelope 预算。IPC 8 MiB 不变；出站超限在 worker mailbox/stdin 前拒绝。覆盖 4 MiB asset 的实际 stdio、raw 恰好越界、2 MiB 文本帧与恰好越界、最大中文/emoji/JSON 转义 prompt；完整图片解码/像素 sanitization 仍待后续阶段，不以本轮 signature 检查冒充。
- worker capacity、mailbox full、mailbox closed、unsupported feature 分开；回归确认容量失败保留已接受输入和 Completed receipt，失败写入任务状态。不提高 worker 上限，不在 P0 引入 P1 回收。
- `npm run test:rewrite` 最终全通过：check/audit/build/format/clippy；workspace 宿主 345 passed、2 ignored（另一个 crate 2 passed）；实际 IPC 21 项、Telegram 28 项、SIGKILL/process-loss 3 项、Chromium 13 项；full runner；GNU release artifact/package/smoke。no-op 用例覆盖不同 ID 同值、零 batch/revision、删除源/重启后 replay、异参 conflict；本地提交前重启和 receipt 故障回滚由 SQL 故障用例验证，丢回执/断连与提交后 SIGKILL 由实际宿主验证。
- 日志：`.test-results/p0/rewrite-final.log`（全量最终门禁）；其中 full runner 的细分日志为 `.test-results/run-EaGWTE/`。首轮失败及修正过程日志保留在同一 P0 目录。未跑真实在线 provider/Bot、Extension Host、musl、两小时 mixed/soak，不据此宣称这些已验收；未部署或操作真实数据。

**出口：**真实宿主定向契约复现从红转绿；commit 前/后丢连接和重启得到同一终态；no-op 零 session batch；超限输入有确定错误且无副作用。此阶段不顺便重写全部 actor。

### P1 [~] 生命周期与容量周转（核心回归已修复；完整收敛待续）

**依赖：**P0 receipt 合同。

**验收分层：**P1 实现阶段保留快速定向回归（单 worker A→B→A、基本 cancel/shutdown、epoch 拒绝旧事件）；其余重型矩阵集中到 P6 最终验收统一运行，不在 P1 每次实现时重复跑。P6 增补并发回收/不超额不双启动、授权与不确定 fork/pin 保护、旧 epoch/generation 迟到事件、discovery/config/fork/title barrier 公平性，以及大量会话 owner/task 平台化与限定时长 RSS soak。只有这些最终证据通过后，才将 P1 验收状态改为完成；若测试暴露实现缺陷，需回到 P1 修复，不能用“延期验收”豁免正确性。

**P1 当前实现与验收结果：**

- 冷创建不预热 actor；session-scoped 命令按需加载，外部管理动作先加载持久 owner。
- worker admission 串行化；容量满时只回收可恢复、无活动轮次/交互/配置意图、后台安全且无标题 pin 的 idle worker，并 join 后重试。Pi 的 `autonomousRuns` 能力用于保守判定后台安全；未知能力不驱逐 Pi 会话。
- ingress 保持显式生命周期 lane；可中断的发现/配置/原生 fork 工作被 Cancel/Remove 抢占，执行任务在 lane 排空时 join。
- `SessionCoordinator` 统一持有 adapter handles、worker supervisor/admission、fork controls、review manager、stop token 和 adapter task scope；`CommandCore` 保留命令编排与持久化，不再各自持有这些生命周期资源。idle 回收按最近使用序号选择 LRU 候选；输入/发现会触碰活动 adapter。
- actual host 单 worker A→B→A turnover 纳入 `test:rewrite`，断言同一 native session 恢复、每次输入仅提交一次、会话保留。日志：`.test-results/p1-capacity.log`、`.test-results/p1-coordinator-final-gate.log`。
- 统一门禁通过，Rust 宿主 345 passed、2 ignored。未运行真实在线 provider/Bot 或 soak，未部署、未操作真实数据。

- 统一门禁通过，Rust 宿主 345 passed、2 ignored。P1 重型矩阵计划在 P6 最终验收统一执行；未运行真实在线 provider/Bot 或 soak，未部署、未操作真实数据。

**待最终验收（P6）：**并发回收压力、授权/不确定 fork 下回收保护、旧 epoch/generation 晚到隔离、长期大量会话 owner/task 平台化及 RSS soak；provider barrier 公平性专门注入矩阵。

1. 明确各状态、pin、completion fence、控制抢占点；在既有 actor 中收拢句柄和 turn/workflow 生命周期。协议状态仍留 adapter。
2. 加压力 LRU、有限 TTL、join 后交槽；一槽 A完成→B完成→A原生继续，不删会话、不回放 prompt。无安全 idle 候选时快速给出容量原因，不把新输入无限挂起。
3. 去掉 create 后 advisory warming，给 Coordinator 总量预算及 drain 淘汰；读取不暖 owner。
4. provider job completion 不长 await 堵控制 mailbox；对 discovery/config/fork/标题卡住分别注入 barrier，验证 cancel/shutdown 和跨会话公平性。
5. 保留当前 SQLite WAL、FULL、固定两 readers 一 writer、短快照、有界队列和物理 join；不引入动态连接池、分库或通用任务框架。

**出口：**将 idle repro 改成断言成功的实际进程回归并接入门禁；并发回收不超额、不双启动；授权/不确定 fork/标题和后台 pin 不误驱逐；旧 epoch/generation 晚到无影响；大量会话反复 create/load/淘汰后 owner/task 数平台化。只测到结构有界时不声称已测无 RSS 泄漏。

### P2 [x] typed 输入与 provider 设置纵向贯通（实现/本地门禁完成；真实环境出口待 P6）

**依赖：**P1 生命周期接口。Prompt parts 与设置可分两条小变更，分别集成，不一起重写 UI/存储/adapter。

- typed text/context/image：粘贴/选择→预览/删除→验证和预算→不可变归档→持久接受→ACP。operation 指纹覆盖 parts 顺序/身份；历史/复制/导出保留来源和媒体语义，生产删除字符串拼接附件路径。
- 保留 initialize/model 实际能力，入口展示真实拒绝/降级，不伪造 provider 图片支持。图片不进入 SessionView 或无限草稿；临时未发送 asset 有可识别清理生命周期。
- config options 用受预算的 typed select（后续实际需要其它类型再加），保留 option ID/category/choices/current value，不用任意 JSON 配置包。Pi thinking/Fast 分开，桌面和 Telegram 同源。
- configure 只有观察成功值才能 settle 和更新偏好；失败/未知不保存默认。已有会话设置优先；新会话用最近成功 model/thinking；Fast 随 native session/fork 恢复，不成为全局默认。context 仍需独立明确授权。
- 用 draft generation + 原 operation 身份处理迟到接受；失败保留输入，迟到响应不能清除新草稿。stream delta 不重建正在操作的设置表单。

**出口：**支持/不支持图片 peer、最大中文/emoji/图片、损坏/超限、切会话/reload/断连；设置首任务前生效、双端更改、失败不保存、成功 settle 前 SIGKILL 后不重发；分别验证真实 Pi/Codex/Claude 可用项，记录拒绝，不承诺能力全等。

**P2 当前实现与有限验证范围：**

- 生产 prompt wire 仅接收有序 text/context/image parts，拒绝旧字符串形式；附件不再拼接成一条业务 prompt。文件与编辑器选择保留来源/身份，归档分 part 写入，同事务提交 Accepted 与正确 entry/seq 的有限 input delivery intents；operation 指纹覆盖原始顺序/身份。ACP 支持 embedded context 时使用 resource，否则显式带来源的 text block。
- 图片选择/粘贴、Blob 预览/删除、每输入一张/每草稿 4 MiB/四个临时图片草稿；未发送图片只驻内存，重开丢弃，不写 SessionView。宿主在 writer 外做完整静态解码（8192 单边、1600 万像素、64 MiB decoder allocation、两个并发 job），拒绝动画/损坏/超限，重编码为最多 4 MiB PNG 后归档/接受。显式 discovery 检查 initialize 的真实图片能力，不支持则拒绝并保留草稿。ACP 仅图片输入 request 有 base64+1 MiB 有界媒体帧，普通 2 MiB 与输出图片 64 KiB envelope 不放大。
- 保留最多 32 个 typed select、每项最多 500 choices、总 128 KiB，端到端保留 ID/category/current value。桌面显式 Discover 可在首任务前加载真实选项；Thinking/Fast 独立；Telegram `/status` 与 `/setting ID VALUE` 使用同一 catalogue/configure 链。配置 prepare/已知 baseline → 观察成功 → settle；显式 discovery 可恢复悬而未决 baseline，不重发旧 operation。成功 model/thinking 与状态同事务保存到 `provider_preferences`；已有会话优先，Fast 不成为全局默认；context 仍独立授权。缺新表的旧实验 root 明确拒绝，不迁移/清空。
- 草稿使用原 operation + 单调 generation，提交及编辑/附件变化均推进 generation，迟到接受不能清除新草稿（包括编辑回相同文本）；失败保留输入。未变的设置定义不因输出 delta 重建 DOM/焦点。
- 新增实际 stdio/宿主测试覆盖有序 context/image、unsupported peer、损坏/像素预算/重编码、最大 4 MiB ACP 图片输入与中文/emoji、首任务前设置、失败不保存/成功偏好/Fast 隔离、重开原 receipt；增加 Chromium 首任务设置/Blob 图片输入和实际三 synthetic profile configure-SIGKILL 不重发。`npm run test:rewrite` 最终通过：check/audit/build/format/clippy、Rust 宿主 351 passed/2 ignored（core 另 2 passed）、IPC 21 项、Telegram 28 项、容量周转、三 synthetic profile 的 configure-SIGKILL/原 operation 不重发、Chromium 15 项、full runner 与 GNU release artifact/package/smoke；忽略项不算通过证据。full runner 的 TypeScript 为 37 files/239 tests，最终 Workbench 定向集为 14 files/108 tests；补充有效 CRC PNG 的 8192/8193 尺寸边界及像素超限，而非用损坏 header 冒充像素预算证明。统一测试修复多 part manifest 的 entry/seq 绑定、失败配置后 discovery 恢复入口、表单缓存漏模型可见性；Telegram 图片等待超时追到已结束用例仍关闭的全局 configure fixture gate，新会话继承成功 model 后会触发该 gate，现显式释放，未放宽超时。日志：`.test-results/p2/rewrite.log`（最终全量）、`.test-results/run-bek7Fa/`（full runner）、`.test-results/p2/workbench-ts-final.log`、`.test-results/p2/image-boundaries-final.log`；首次失败日志保留在同一 P2 目录。源码为 `e7a6ef3` 上的本次工作树，不是已发布版本。
- 未运行真实在线 Pi/Codex/Claude、真实 Bot、Extension Host 剪贴板/窗口重开或长驻 soak。以上 synthetic/Chromium 证据不替代真实 provider 可用项与 Fast/native fork 恢复验收，仍在 P6 明确取证；未部署、未操作真实数据或日常凭据。

### P3 [x] Pi 自主后台轮次闭环（实现/有限本地验收完成；真实环境出口待 P6）

**依赖：**P1 pin/回收合同，P2 设置恢复。

- TS Pi bridge 与 ACP adapter 显式 start/finish，Coordinator 分配新 turn/epoch；没有边界证据不能从 idle 文本推断自主轮次。
- 与用户 prompt 竞争有确定串行点；保持 main 的自主轮次忙时拒绝用户输入并保留草稿，不暗改为 steering/follow-up。
- 接通授权、停止、独立用量/历史/Telegram 完成通知。当前轮次不重新折叠上一轮最终回答或重复计费。
- 整轮 workspace before 必须在可能写文件之前采集并持 gate；如果桥接只能事后通知，不承诺完整净 Diff，明确 unavailable/partial。main 的自主轮次本就不保证整轮 workspace 基线，不为“增强”制造错误快照。
- provider 明确报告后台 pin 的取得/释放；没有该能力时展示有限能力/容量限制，不能靠一次超时认定后台任务不存在。

**P3 当前实现与有限验收：**沿用 bridge 的显式 run start/finish 与 live ID，adapter 保留协议身份，actor 原子分配/提交独立 turn，授权与完成复用现有持久链路。忙时拒绝输入；最后一刻 provider 抢占保留 Accepted 输入并追加 rejected marker，不伪称执行，桌面保留匹配 generation 的草稿。按本轮 assistant message_end 累计并在 finish 报告 usage，删除 native-file tail 计费路径，避免后续唤醒串账。控制 RPC 期间显式 live 事件有界保留后处理，不将 load 历史 replay 认成唤醒。自主轮次整轮 Diff 明确 unavailable，worker-lifetime workspace gate 保留。Pi 无可信未来唤醒 pin 释放能力时保守不回收，并提示容量限制；显式停止可 join 空闲 Pi worker，不删除会话。

- 统一检查后修复 UI 消息类型、拒绝提示被 render 覆盖和空闲 stop 的旧测试 oracle。`npm run check`、`npm run audit:workbench`、`npm run build`、Clippy all-targets（warnings denied）通过；Rust 库首轮 352 passed / 1 failed / 2 ignored，修正空闲 stop 断言后重跑受影响宿主集为 67 passed / 1 ignored，新增自主轮次两项补充断言后再次通过。受影响 TS 6 files / 55 tests、adapter seam 2 tests、实际宿主 Chromium 15 项通过。用例覆盖独立两次唤醒、授权、忙时无 revision 变化、最后一刻抢占、迟到/无 run ID 输出隔离、独立用量总计、持久 Turn delivery、unavailable Diff、取消/空闲停止、冷历史重开与显式继续。未机械重跑全库、`test:rewrite` 制品或 soak。日志：`.test-results/p3/{static-build-final,rust,rust-app-final,clippy,ts-final,adapter,browser-host}.log`；首轮失败日志保留在同目录。最终补查修复异步 context stats 在 finish 后被 live fence 丢弃的问题：仅同 run 的占用率允许收尾更新，不接收正文或新增推理用量；新增断言后 P3 两项、领域回归与 Clippy 再次通过，日志 `.test-results/p3/occupancy-final.log`。
- 没有使用日常凭据或在线 Pi/Bot；未部署、未迁移/删除真实数据。Pi 尚无可信动态 pin 释放证据，本轮交付的是明确的保守 pin/显式 stop 合同，不宣称已验证无后台工作的自动回收。

**出口：**真实 Pi 后台完成→独立唤醒→授权→完成/停止→冷历史→显式继续；用户输入竞争、SIGKILL、旧事件与回收竞争均覆盖。只读 attach 不触发唤醒/续跑。真实在线 Pi/Bot、SIGKILL 与并发回收矩阵仍须 P6 单独取证，不能以 synthetic 本地用例代替。

### P4 [x] 消息投影、终端和桌面交互对齐（实现/有限本地验收完成；真实环境出口待 P6）

**依赖：**P2 内容合同；与 P3 共享独立 turn 边界。

- 增量逻辑消息投影和稳定 DOM identity：同消息连续 Markdown、跨片代码块/表格/LaTeX/Mermaid；复制/导出完整逻辑消息，过程/Thought 默认折叠及轮末折叠保留用户选择。
- 不以每 delta 全文解析/全 DOM 重建换取正确显示：合并同一渲染帧更新、只更新变化消息，长内容有预算；测 1000 分片时渲染耗时和输入响应，避免累计 O(n²) 工作。
- 分页继续/截断有清楚提示和读取方式；当前页 200 raw entries 不应让长回答看似只剩尾部。保留 DOM 焦点、文本选择、复制、滚动锚点及设置/授权草稿。
- terminal 在协商支持的 ACP port 中读取并归档受预算 stdout/stderr/退出状态；不按 terminal metadata 猜路径或执行命令。不支持时明确 metadata-only。
- 恢复 ACP available commands 斜杠补全，覆盖键盘/IME/空目录；只展示 provider 声明的命令，不能发明内部命令。
- 链接由显式点击请求宿主确认，展示规范化目的地（含 punycode），只允许约定 scheme、拒绝凭据 URL/command/javascript；可复制替代打开。本地文件链接如恢复，必须重新授权工作区归属，不恢复任意路径读取。
- 历史列表约 4/10/16 高度、选择/刷新/发送不自动关闭；Plan 固定卡片状态、约五项内部滚动、折叠偏好与长标题。恢复 composer 可用布局/resize，真实窄侧栏核验。
- 登录入口对齐实际用途：显式确认后按受信 provider profile 打开对应原生登录终端，不执行模型给出的命令、不自动传入凭据；若保留“仅说明”的产品降级需明确确认，不能默认算体验等价。

**出口：**修正“每 delta 多 article”的旧测试 oracle，保留不可变 entries 断言；Chromium 验证流式/分页/键盘/链接，真实 Extension Host 验证剪贴板、滚动、resize/原生对话框与登录入口。Preview demo 等非主流程开发工具可明确退休，不为兼容恢复旧源码。

**P4 当前实现与有限验收：**

- `workbench-messages.ts` 提供唯一 TS 分组规则和小型增量投影：只追加新 entry，按 provider identity/turn/role/连续 seq 分组，无 ID、图片、序号缺口是硬边界。翻页 prepend/窗口移动以仍可见的不可变 entry 保留消息 key；不改写持久 entries。显示、复制、Markdown 导出共用规则；Telegram TurnStream 使用同一领域谓词，不再将无 ID 的正文悄悄粘连。复制按冷页寻找消息两端并验证归档正文，1 MiB 超限指向完整导出；导出只在磁盘暂存有界页头，正序流式读取归档，跨页不插入破坏代码块的标题。
- 每帧合并更新，turn/article/Markdown prefix 做就地 DOM reconcile，未变消息不解析或脱离 DOM。活跃 Agent/Thought 的 Markdown prefix 按几何增长更新（128 KiB 上限），其余可见尾部为有界纯文本，结束后完整消息在 256 KiB Markdown 预算内解析；用户消息不走流式截点。复用未变 prefix 的 DOM，避免每帧重新解析相同 HTML。Thought/过程默认及轮末折叠保留显式用户选择。显示窗口为 2000 entries/4 MiB，早页 prepend 保留当前回答；continuation/预算提示及完整复制/导出入口明确，不把最近 200 条伪称完整回答。
- 斜杠补全只来自当前 catalogue，支持上下键/Tab/Enter/Escape、IME 和空目录。外链只经显式点击到 host 端再次校验，modal 展示规范化/punycode 目的地，提供打开/复制/取消；仅 credential-free HTTP(S)/mailto，不恢复任意本地文件读取。列表提供 4/10/16 行，Plan 内部约五项滚动，composer 使用现成的指针/键盘 resize 并保存高度。登录改为明确确认的受信内置 Pi/Codex/Claude 原生 CLI profile，不接受模型命令或传递凭据。
- 终端能力的明确边界：当前 ACP 客户端实际声明 `terminal: false`，没有已协商的 terminal output port；UI 直接标明 metadata-only、未捕获 stdout/stderr/退出状态。不从 terminal metadata 猜路径、执行命令或假装有正文。此轮不额外建设第二套命令执行/进程监管器，不宣称已具备原生终端正文能力；真实 peer 能力和桌面原生入口仍需 P6 验证。
- 集中门禁：check/audit/build 通过；受影响 TS 8 files / 61 tests 通过，UI 收尾后 21 项消息/浏览器单测再次通过；Rust Telegram 79 passed，Clippy all-targets（warnings denied）及宿主构建通过。Chromium 实际宿主主流程及独立显示负载 17 项通过；修正旧 entry/article 与无 ID 粘连 oracle，工具入口按确切 turn 定位而非在宿主 Idle 早于 UI 更新的窗口点上一轮。性能用例也暴露并修复了用户消息错误套用流式截点。未机械重跑全库/制品/soak。
- Chromium 1000 分片（每帧约 10 个状态更新，最终 2 条逻辑消息）：102 次 render，p95 2.70 ms/max 20.70 ms；9 次 Markdown parse，max 12.20 ms；100 次 input handler p95 0.10 ms/max 0.20 ms，input→下一 rAF p95 19.70 ms/max 31 ms；观测到 8 个 long tasks，max 71 ms（含注入/全状态解码/调度，未归因成纯渲染，也不宣称零长任务）。焦点、未改消息文本选择及跨片代码块验证通过；原生 textarea 编辑会正常清除文档选择，用例分别验证渲染保持选择与重新选择，不要求编辑时违反浏览器行为。这是单机单轮有限基线，不替代 P6 五轮 mixed、真实硬件输入延迟或长期 RSS。
- 日志：`.test-results/p4/{final,ui-verified,close,rust-close}.log`；前序失败/修正日志保留同目录，性能明细为 `test-results/workbench-browser/p4-render.json`。真实 Extension Host 的 clipboard/滚动/窄侧栏/resize/modal、真实 CLI 登录及在线 provider/Bot 未运行，留待 P6，不以 Chromium host-port mock 冒充原生对话框验收；未部署、未迁移/删除真实数据。

### P5 [ ] 历史管理、审阅、手机与留存收尾

**依赖：**P1 生命周期、P4 消息边界。拆成以下四个有限交付，不扩成第二次重构。

1. **历史查询与清空：**筛选下推 SQL/keyset，cursor 绑定筛选条件，能找到当前 100 条以外的会话。批量清空先预览范围/二次确认，明确是否包括全部 harness、Telegram 活跃任务及 pending deliveries；冻结目标集合和 durable job ID，有界逐批 fence/join/删除，保存进度/部分结果，重启只续未完成本地步骤。不递归删 native、不 reset root；保留 usage/dedup/已接受 delivery 所需引用。
2. **Diff/撤回：**完成推送复用已存净 Diff 摘要（文件/增删行、partial/unavailable），明确审阅保存先于完成通知，崩溃无快照时不假造。链接只显示链接文本、不跟随目标；普通文本安全撤回仍校验 dirty buffer/路径/硬链接/权限/当前内容。超过 256 文件/64 KiB 路径单次预算时显式选择、逐批确认、逐项结果，不直接放大限制，不承诺多文件原子或上下文回退。Diff 分页整行 JSON 成本先测，必要时迁移为文件头和正文引用，保持一个数据库/一个存档事实。
3. **手机历史/同步：**raw scan 预算与可见消息目标分离；filtered page 必须推进、跨批同消息有 continuation，不能静默丢尾。保留共享 dedup、通知/静默偏好、immutable export、topic FIFO 和八 lane；完成/失败/取消的摘要均回归。配置向导保留明确 allowlist、私有配置和目录授权，不恢复 first-sender 自动配对/自动安装服务。
4. **留存与媒体安全：**先定义 typed roots（live history、fork 共享 entries、pending/accepted export、delivery manifest、operations/tombstones、inbox high-water、callbacks），离线 dry-run 给出字节/对象/引用理由；再实现同 lease 下有界事务批次、可重入 GC。先清可证明孤儿/过期非防重数据；operation/delivery 去重身份没有安全压缩合同就保留，不能为磁盘数值删除。native 外部文件不在 GC 删除范围；不隐式启动清库、不在线阻塞 VACUUM。保留数据增长/磁盘不足提示和显式维护入口。

**出口：**页外筛选/旧页迟到、清空中断/重启/活跃任务/pending 引用、手机摘要与消息跨批、symlink 不跟随、超预算撤回及冲突逐项结果、GC 共享引用/导出引用/幂等/防重/崩溃测试。保留一般 GC 的不可压缩身份成本，不虚称无限期固定磁盘。

### P6 [ ] 故障、性能、真实环境和制品验收

#### 6.1 provider 能力与体验矩阵

以 `main@4bf6f32` 使用规范、测试和真实界面为参考。规范存在不等于当前实现可用；没有运行证据标待验。Pi/Codex/Claude 分别记录 prompt/image、model/thinking/Fast、Plan、permission/elicitation、terminal、usage、cancel、load、native fork、自主唤醒的支持或明确拒绝。

Pi native cut 继续要求真实 message 边界证明：重复文本、工具/媒体、独立 identity、源文件不变、继承 billing 不重复计；不靠 timestamp/摘要/prompt 重播猜 cut。不承诺其它 provider 的私有 fork；在线请求、离线 SDK/native-file 测试分别取证。

必须验用户流程：

| 流程         | 结果                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| 桌面对话     | Enter/IME、草稿和附件、运行中切会话/harness、关页任务继续、重开授权/停止、worker 容量周转            |
| 设置/后台    | 首任务前选择、成功偏好/会话优先、Fast 恢复、独立自主轮次和冲突输入保留                               |
| 阅读历史     | 全历史列表/筛选/导出、连续 Markdown/复制、正文终端、Plan/折叠/高度/布局偏好、显式链接                |
| 审阅管理     | 预存脏文件不误算、shell 净变化、失败/取消审阅、dirty buffer 拒绝、安全撤回/部分结果、共享清空        |
| 统计命名     | 模型/日期/会话、cache/缺失/未定价/覆盖价、标题独立费用/manual-wins，fork/load 不重复计               |
| 手机独立使用 | 创建→发现/选设置→A/B 排队→授权→stop/interrupt→history/sync/偏好/预览→继续；断网/429/重启不重跑 Agent |
| 运维恢复     | 冷查不建 worker、单 owner、epoch/receipt 防重、背压/join/lease、容量/磁盘错误可诊断、整组回退        |

没有用户同意，不默认删除上述既有能力；安全/provider 限制则给出明确受限体验，不伪装完成。

#### 6.2 故障窗口

- 实际进程在 commit/receipt/dispatch 前后 SIGKILL；no-op、本地 mutation、configure settle、fork 完成 adopt 前、undo 部分发布分别验证。恢复只查原 operation，不换 ID 重发。
- 两端 answer、answer/expiry/cancel、trust 撤销、切会话旧页、旧 worker completion、回收与新输入、shutdown 调用取消/重试。
- Telegram offset/分类/接受、HTTP 成功 ack 前、multipart/429/rebind/源删除；同 topic head 不越过、独立 ready topic 不饥饿。
- 图片 revision batch 间歇 15 秒超时用 barrier/dispatch trace 定位，重跑绿不是结案。
- 外部发送 at-least-once、外部未知不自动重试；进程组 join 不等于宿主能控制逃离进程组的后台程序或外部编辑器，保留风险说明。

#### 6.3 性能：先可归因，再优化

保留一个版本化实际 host mixed runner；固定机器、源码、构建配置、数据集、预热/采样时间，至少五轮，同时报告每请求分布而非五个均值的 p95。阶段 P1/P4 就采集基线，不能所有性能工作推到最后。

数据集：10k 会话、单会话 100k entries、1 MiB 正文分页、4 MiB 合法图片、16 活跃 synthetic sessions、8 delivery lanes、2048 deferred topics；并发历史/媒体/导出和控制。用独立空闲会话测设置/准入，活跃会话测 cancel fence，拒绝请求不混进成功延迟。

| 指标                                       | 初始目标/判定                                                                                                           |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| loaded 会话本地接受或 cancel durable fence | mixed p95 ≤100ms、p99 ≤250ms；分别记录 admission queue、owner queue、SQL/commit；workspace 基线、冷启动和物理 stop 单列 |
| 普通 history/list 页                       | p95 ≤200ms；同机与 P0 基线相比 >20% 退化必须解释；单独测 Diff 整行解码和大媒体 reader 占用                              |
| UI                                         | 1000 分片连续渲染时输入/选择/复制可用，报告单帧耗时、重绘/Markdown 次数及长任务，不用 DOM 个数当性能证明                |
| 公平性                                     | 独立 ready topic 不被 deferred topic 隐藏；普通请求不耗尽控制/query reserve；同 session 长等待另外测可中断边界          |
| 热资源                                     | worker/owner/task/媒体缓存有上限且回落；RSS 不随累计已访问会话线性增长；同时报告连接、线程、队列、WAL/checkpoint        |
| 长驻                                       | 600 秒快速 soak + 至少两小时同一宿主持续混合负载，检查趋势/平台值；每轮重建 fixture 不能证明长期稳定                    |

以上是待校准目标，不是本次已测结果。达不到时先给瓶颈/硬件/样本证据；不能事后放宽掩盖回归。不为优化引入无依据分库/连接池，也不为“少代码”删去安全限额和恢复状态。

#### 6.4 门禁及发布

开发阶段跑受影响定向测试；阶段集成跑主流程；候选发布跑：

```sh
npm run test:rewrite
npm run test:workbench:startup
npm run test:workbench:scale
npm run test:workbench:mixed
npm run test:workbench:soak -- --duration-seconds 600
# 真实隔离图形环境；缺 display 标 BLOCKED
xvfb-run -a npm run test:extension-host
# 单独补两小时同宿主 mixed、在线 provider/Bot、离线 SDK、GNU/musl 各目标制品
```

- `test:rewrite` 已包含 check/audit/build/format/clippy/workspace/contracts/process-loss/Chromium/full/artifact，不机械重复同配置证据。静态 audit 是 tripwire，不是运行正确性证明；修改合同要同步 audit/fixtures，不能绕开它。
- 真实 Extension Host 补单/多文件 Diff、dirty buffer、trust/modal、clipboard/图片、目录/保存/设置/resize；现有 basic smoke 不代表全矩阵。
- 在线 Pi/Codex/Claude、真实 Bot 使用专用授权账户/目录/chat 和费用预算；不读日常凭据，不自动安装系统依赖。缺环境标 BLOCKED，不用 mock 代替通过。
- GNU/musl 各自生产 artifact/IPC/Telegram 契约，目标工具链缺失单列。记录源码、构建配置、命令、结果、未跑项。
- 开发期破坏性 schema/wire 同步 Rust/TS/fixture/manifest；一个切换点只有一套生产 reader，无双写/兼容别名。旧 root 不迁移、不清空，binary/root 一起保留。

**出口：**P0–P5 的关键流程与边界修复有证据，能力差异和环境阻塞显式可见；仍只是候选版本，不自动部署。发布依据[切换与回退清单](workbench-cutover.md)另行授权，binary/VSIX/配置/root 整组切换与回退，禁止旧 binary 打开新 schema。

## 5. 控制范围与完成定义

- 不重建旧 daemon、旧 wire、旧 reader；不以兼容为由保留被替代路径。
- 不做泛型 workflow engine、全量 event sourcing、跨语言 UI 服务、按 delta 持久投递或未经测量的数据库拆分。
- 每个改动须说明：替代哪条旧路径、减少哪个重复决策点、commit/副作用在哪里、如何冷恢复、资源由谁 join/回收；允许为正确性加少量代码，但必须删除失效编排。
- 功能差异默认补齐；确需降级要写出实际 provider/安全证据和用户可见提示。不能以“按钮存在”“方法可调用”“测试数量多”结案。
- 当前行为更新到[VS Code](workbench-vscode.md)、[Telegram](workbench-telegram.md)、[Diff/撤回](turn-diff.md)、[管理](workbench-management.md)、[持久恢复](persistence-recovery.md)；本文件只保留设计、待办和有限验收结果，不追加逐轮聊天记录。
