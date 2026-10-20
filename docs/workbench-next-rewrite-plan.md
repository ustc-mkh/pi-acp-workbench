# 下一版重构计划

> **状态：待执行。** 本文件是唯一的后续工作计划，统一管理功能差异、架构收敛、安全尾项和发布验收；不再另设事实表、阶段 checkpoint 或执行流水文档。目标是本版一起完成，不把既有功能差异默认延期。

## 1. 目标与执行约束

优先级：**不丢用户意图、不重复副作用、不破坏工作区 > 主流程体验对齐 > 可维护性 > 峰值吞吐 > 内部兼容性。**

- 使用 `main@4bf6f32` 的使用规范/测试作为体验参考，旧源码只用 `git show` 查阅，不重新接回生产。规范参考与真实界面对照必须区分。
- 保留单宿主、typed IPC、SQLite 增量提交/固定两 readers 一 writer、冷查询、原生 fork、revision/epoch fence、物理 join 和 Telegram FIFO/八 lane 底座，不再重写已经稳定的模块。
- 允许破坏性修改 wire/schema/内部边界；同一切换点同步 Rust/TS/fixture/manifest，不保留双协议、双写或长期旧 reader。不自动迁移、清空或修改真实 root/native 历史。
- 每阶段交付用户入口→持久结果→重开的一条完整流程；先减少主干缺口，不连续多轮只补辅助框架或已交付模块的边缘测试。
- 一阶段一个有限收尾清单。只有已复现的正确性/安全回归或必要依赖插队；不得用更多测试数量代替阶段进展，也不自行增加无限前置工程。
- 开发中跑定向检查，主流程集成跑完整门禁，候选发布补生产制品/真实环境/长期负载。同源码配置的有效证据可复用，不为更新文档重复全量构建。
- 当前行为只写在使用/协议文档；任务状态只更新本文件，原始日志保存在 `.test-results/`，不再向 `docs/` 添加按轮记录。完成阶段压缩为结果和测试入口，不追加聊天式流水。

## 2. 本版统一范围

已有会话/冷历史/操作恢复、文本附件、模型/mode、Plan、Diff/撤回、统计/命名/导出、Telegram 菜单/排队/历史/推送链路作为回归基线，不重复建设。下表的差异和未完成验证均纳入本版：

| 阶段 | 当前缺口或问题                                              | 本版完成目标                                                           |
| ---- | ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| M1   | 空闲 worker 永久占槽，新会话耗尽容量                        | 有限空闲保留、安全驱逐、可继续原生会话                                 |
| M2   | 附件拼接为纯文本，不支持图片 prompt                         | 有预算的 typed text/context/image 输入及真实能力降级                   |
| M3   | thinking/Fast/config options 未贯通                         | UI/领域/ACP/恢复/成功偏好一致                                          |
| M4   | Pi idle 通知没有独立自主轮次                                | 后台唤醒、授权、停止、审阅、用量与通知完整闭环                         |
| M5   | delta 各自成为消息，terminal 仅 metadata                    | 连续 Markdown、稳定逻辑消息、实际工具/终端正文                         |
| M6   | 会话所有权分散，热 owner 无总量淘汰                         | 单一 SessionRuntime、有界热状态、精简命令编排                          |
| M7   | 全历史筛选/清空缺失，Telegram 缺 Diff 摘要，显示/审阅有差异 | 一起补齐历史管理、手机摘要、列表/Plan细节及安全审阅能力                |
| M8   | 图片仅签名校验、通用留存回收及复杂 native cut 能力未闭合    | 明确媒体安全、typed reachability、provider cut 合同并完成相应实现/验证 |
| M9   | admission SLO、长驻 soak、真实环境及 musl 证据缺失          | 完整候选发布验收，不以 synthetic 或短循环替代                          |

### 必须保留的安全边界

这些不是待恢复的功能差异，不以“对齐”为名去除：

- prompt receipt 表示持久接受，不表示模型成功；未知结果查询原 operation，不换 ID 重发；收据过期保留防重 tombstone。
- 先 commit 后 publish；本地状态与其 terminal receipt 同事务；外部 configure/fork/撤回/topic 使用 prepare/settle，崩溃显式 uncertain/interrupted，不自动重试。
- 冷查询不建 worker；observer 取消不撤销已接受操作；fence 后停止并物理 join，再释放容量/lease。
- 输入只读取显式授权的来源；工具路径、URI、terminal metadata 不授权本地读写、联网或执行；保持 CSP 与 hard limits。
- 多文件撤回不是文件系统原子事务，不回退模型上下文；外部编辑器/残留后台进程不受宿主 gate 保证，必须明确提示。
- Telegram 发送仍为 at-least-once；partial/unknown HTTP 可能重复。停止不回滚文件或远端费用。不新增 main 未支持的 Telegram 图片输入或任意 provider fork 承诺。

## 3. 实施阶段与出口

执行顺序为 M1→M2–M5→M6→M7–M8→M9。M1 与 M4 先统一后台保活/回收语义；接口稳定后可分模块并行，不同时重写 runtime、存储、wire、UI 和 scheduler 才做第一次集成。

### M1 [ ] worker 容量与空闲回收

**问题证据：**隔离 `max_workers=1` 下 A 完成后仍占槽，B 获 Accepted 后失败为 `session mailbox is full`；cancel 空闲 A 返回 `no active turn`，删除 A 后显式重试 B 才成功。诊断入口：`node scripts/workbench-idle-worker-repro.mjs`（仅复现当前故障，不是通过门禁）。

**改动：** `app.rs` adapter map、`worker.rs` supervisor 和会话入口。

- 区分 starting/running/waiting-interaction/idle/stopping 和最后活动时间，定义总量与有限空闲保留策略，不靠提高 `max_workers`。
- 容量申请可驱逐安全空闲 provider；先 fence/停止/join，再交出槽位。活跃、授权等待、configure/fork、标题调用未收尾者不驱逐。
- 保留 native identity 和会话设置，下次显式输入原生 load，不回放旧 prompt。Pi 后台保活必须与 M4 协作，不能仅凭无用户 prompt 判断可终止。
- 容量不足用真实容量错误，不泛称 mailbox full；已接受任务后续失败不能改成输入未接受，也不能自动重试。

**出口：**一槽下 A完成→B完成→A继续，无须删会话；并发不超额、活跃/授权/不确定fork不被误驱逐；卡死、取消回收、shutdown均物理join。把诊断转成断言 B 成功的实际进程回归，删掉过期故障脚本。

### M2 [ ] typed prompt、附件与图片

**改动：** Webview composer/草稿、UI/IPC DTO、领域 Prompt、ACP initialize/prompt、归档/导出。

- 建立唯一的 text/context/image parts 合同、显式来源和总输入预算；删除生产中的附件字符串拼接路径，同步 Rust/TS/fixture。
- 保留 initialize 输入能力，按真实 provider/model 能力展示图片入口与拒绝原因，不伪造支持。
- 完成粘贴→预览/删除→MIME/尺寸/字节校验→持久接受→ACP image；不可变归档/引用，不把大 base64 放入 view 或无限草稿。
- operation 指纹覆盖 parts 顺序/身份；失败保留输入，迟到接受不能清掉新草稿；reload只查原ID。

**出口：**支持/不支持图片的synthetic peer、真实Pi图片与Codex/Claude差异；中文/emoji、越界/损坏/超限、切会话、断连/reload及附件更改期间迟到响应。

### M3 [ ] thinking/Fast/config options

**改动：** ACP settings/catalogue、SessionConfig、configure intent/receipt、桌面与Telegram设置。

- 受预算的 typed provider options，不再只投影 model/mode；只展示真实选项。
- 复用 prepare→远端调用→观察成功值→settle；只有成功应用的值写默认偏好，已有会话自身设置优先。
- thinking 与Fast独立；Pi Fast随原生会话/分支恢复，不成为新会话全局默认。Pi context仍为独立显式授权写入。
- 设置UI局部更新，不因stream delta重建当前交互；过期选项、失败和未知结果清楚可见。

**出口：**首任务前选择、双端更改、失败不保存、会话/默认优先级、成功后settle前SIGKILL、reload不重发；真实Pi Fast/thinking及其它provider catalogue逐项验证。

### M4 [ ] Pi 自主后台轮次

**改动：** `pi-session-runs.ts`、Pi扩展通知、ACP adapter、领域turn及审阅/授权/用量/Telegram。

- 显式autonomous start/finish协议，由owner分配独立turn/epoch；idle通知不丢弃、不借用上一轮ID。
- 与用户prompt竞争时明确持久接受顺序；冲突/拒绝的输入保留草稿或持久结果，不吞掉。
- 接通授权、停止、workspace before/after、用量和可靠通知。可能写工作区时持有gate；后台保活与M1容量/重载规则一致。
- 崩溃后仅显示committed事实/中断；只读attach不启动或续跑worker。

**出口：**真实Pi后台唤醒→授权→停止/完成→冷历史→显式继续；加用户输入竞争、旧epoch晚到、SIGKILL和回收竞争，不以adapter单测替代。

### M5 [ ] 连续消息、工具/终端与交互稳定性

**改动：** transcript显示投影、renderer、tool archive/terminal port、分页与导出。

- 存储entry仍不可变；按可信provider message ID、turn/角色形成显示消息，无ID使用保守边界，不跨工具或消息猜合并。
- 同消息delta连续Markdown，支持跨片代码块/表格/LaTeX/Mermaid；稳定DOM identity、焦点、选择/复制、滚动锚点、最终回答突出和轮次过程自动折叠。
- terminal reference接通受预算正文读取/归档；provider确无正文时明确降级，不猜路径读取。
- 调整“多个delta必须多个article”的测试oracle，保留不可变entry断言；复制/导出以完整逻辑消息为准。

**出口：**数百分片、多消息/缺ID/分页边界均正确；运行中展开与结束后折叠、切会话/reload、stdout/stderr有界正文；Chromium与真实Webview都验。

### M6 [ ] 单一会话所有者与有界热状态

**改动：** `app.rs`、`actor_registry.rs`、`actor.rs`、Reviews、epoch/fork controls及operation/store接口。

- 热view、worker/adapter handle、epoch/turn和短期协调归一个SessionRuntime；registry只路由/创建/淘汰，admission只授权/身份/配额/因果队列，不再解释第二套会话phase。
- 热owner总量预算与安全淘汰：无worker/活跃turn/pending interaction/config/fork/accepted write才drain退出。create成功不永久暖owner。
- provider长I/O通过带fence完成消息推进，不长await阻塞mailbox控制入口。
- 逐命令核验本地mutation状态+terminal receipt同事务，删除剩余begin→execute→finish重复编排/双提交窗口；外部副作用保留真实prepare/settle，不泛化为workflow engine。
- owner计算一次小型typed change，WriteStore做CAS/原子提交，再更新热态/发布。删除重复回复转换和被替代路径，保留生产故障隔离seam、合法ACP可选字段和native格式处理。
- SQLite仍用同文件WAL/固定两readers一writer、短快照、有界队列、FULL同步及物理join。先测SQL/反序列化/事务/队列，不能无证据分库或加动态连接池。

**出口：**大量不同会话反复create/load后owner/task/RSS平台化；冷读不建owner/worker；原子receipt、淘汰重载、迟到事件、observer取消、shutdown/lease、fork及双端控制全部回归。无测量不把结构性无界写成已测RSS泄漏。

### M7 [ ] 历史管理、Diff与显示差异统一补齐

**改动：**历史SQL/keyset和UI、批量管理操作、workspace review/undo、Telegram完成manifest与显示偏好。

- 全历史筛选能找到当前页外会话；过滤改变使cursor失效，不只过滤当前100条数组。恢复列表约4/10/16条高度选项，选择/刷新/发送不自动关列表，偏好重开保持。
- 清空共享历史必须范围预览、二次确认、明确全部任务停止范围；区分会话、归档、pending delivery和native。批量任务有durable identity、进度、中断/部分结果，不循环remove后伪报整体成功，不reset root/递归删native。
- Telegram完成消息加入已保存净Diff文件/增删行数与partial/unavailable；复用同一事实，不重扫工作区或塞完整补丁。定义审阅保存→完成投递顺序及重启恢复。
- 补链接文本Diff：只读取/展示链接本身，不跟随目标；保留路径/链接/硬链接防护和partial语义。
- 对超过当前单次undo 256文件/64KiB路径的完整快照，设计显式选择/分批确认与受预算结果，而非直接扩大单次上限。覆盖原本可审阅修改的安全撤回，不承诺多文件原子性；不完整/冲突快照仍拒绝。
- Plan固定卡片对齐状态样式、折叠偏好和约五项内部滚动；增量更新不丢展开/焦点。对照main真实界面验证，不将视觉差异默认为已接受。
- Telegram最近20/每批100条消息在raw-record scan预算下不能静默丢尾；明确continuation/可继续读取与filtered-page推进，维持有界扫描、稳定provider message分组、导出dedup和topic FIFO。
- 配置向导维持安全的显式user/chat allowlist、私有新文件和目录选择，不恢复first-sender配对或自动安装服务。

**出口：**页外筛选/迟到页、批量取消/重启/活跃任务/pending引用、手机成功/失败/取消Diff摘要、symlink文本与不跟随、超单批撤回的逐项结果；列表/Plan/原生对话框在真实Extension Host对照。差异默认在本版修复；确有provider或安全限制时用实际证据说明，不暗中降标。

### M8 [ ] 媒体、留存与native能力闭合

- 图片输入/输出建立完整解码/尺寸/像素/内存预算与必要的安全重编码策略，不把MIME/signature/hash检查称为sanitization；损坏、解码炸弹、超大/多帧输入有确定拒绝或受预算处理。
- 设计并实现显式typed reachability GC：保护history/archive、pending delivery、operation/去重tombstone、inbox offset/high-water、callback及native外部文件边界。先dry-run/确认，有界批次/崩溃恢复，不按mtime或字符串猜删除，不运行隐式启动清库或在线阻塞VACUUM。
- Pi native cut覆盖重复文本、tool/media与真实message边界；保持源文件不变、独立identity、继承billing不重复计。无可靠cut证据明确拒绝，不以timestamp、摘要或prompt重播替代。
- Codex/Claude/Pi分别明确plan、permission、elicitation、usage、cancel及可用native能力，保留typed fixture和实际集成；不支持的私有fork明确显示，不伪造与Pi相同能力。

**出口：**恶意媒体预算、GC误删/引用/重启/lease测试、真实Pi离线SDK/native-file与在线能力分开取证；各provider有明确支持/拒绝矩阵，桌面与手机看到一致事实。

### M9 [ ] 故障、性能、真实环境与发布验收

#### 故障与完整流程

- 实际宿主在commit/receipt/provider dispatch前后SIGKILL，本地状态与receipt原子，外部未知不重发；reload仅查原ID。
- 两端answer、answer/expiry/cancel、撤销trust、切会话旧页、配置成功settle前崩溃、fork完成adopt未确认、旧worker事件、反复shutdown取消。
- Telegram offset/分类/接受、HTTP成功ack前崩溃、multipart/429/rebind/源删除；同topic head不越过、独立ready topic不饿死。
- 用barrier/dispatch trace定位图片revision batch间歇15秒超时；重跑绿不是结案。

#### 性能与资源预算

版本化真实host mixed runner，固定机器/源码/数据集，至少五轮；10k会话、单会话100k entries、1MiB正文分页、4MiB图片、16活跃synthetic sessions、8 delivery lanes、2048 deferred topics，并发历史/媒体/导出和控制。分别报告每请求median/p95/p99/max、排队/SQL/序列化、队列深度、连接/线程、WAL/checkpoint和RSS趋势，不用五个运行均值当请求p95。

| 指标                                       | 验收门槛                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| loaded会话admission→durable fence/本地提交 | 混合负载p95≤100ms、p99≤250ms；物理stop另计                                            |
| 普通history/list页                         | p95≤200ms；同机空载对比无解释退化不得超过20%                                          |
| 公平性                                     | deferred topics不隐藏独立ready topic，普通流量不能耗尽控制/查询保留容量               |
| 读写隔离                                   | 大读取不再把writer阻塞在纯正文/图片解码后；用A/B证据确认收益                          |
| 资源                                       | 固定readers/writer、帧/页/缓存预算；热owner/worker有界，内存不随累计历史/投递线性增长 |
| 持续运行                                   | 600秒快速soak + 至少两小时单宿主混合soak，检查平台值/增长趋势、WAL/checkpoint及泄漏   |

现有storage-only mixed和每轮独立fixture的快速soak可作诊断/回归，不能替代以上SLO与长期趋势。硬件不满足初始值时先给瓶颈与调整理由，不事后放宽掩盖回归。

#### 真实环境与制品

- 真实Extension Host：单/多文件Diff、dirty buffer、trust/modal、clipboard/图片附件、设置/保存/目录对话框、resize/滚动/折叠。无display明确BLOCKED，不回退mock算通过。
- 使用专用授权账户/目录/chat与费用预算，分别验真实Pi/Codex/Claude和真实Bot完整流程；离线SDK不替代在线请求。
- GNU/musl各自生产artifact/IPC/Telegram契约，目标std/工具链先备齐；不用GNU替代musl，不擅自安装系统依赖或读取日常凭据。
- 删除被替代路径、旧协议/配置别名/测试专用生产API；不重建旧daemon或旧reader，不删安全回归降门槛。

候选门禁使用当前 `package.json`：

```sh
npm run test:rewrite
npm run test:workbench:startup
npm run test:workbench:scale
npm run test:workbench:mixed
npm run test:workbench:soak -- --duration-seconds 600
# 真实隔离图形环境
xvfb-run -a npm run test:extension-host
# 另补长期混合负载、各目标制品、真实provider/Bot和离线SDK
```

`test:rewrite`包含的check/audit/build/format/clippy/workspace/contracts/process-loss/Chromium/full/artifact不机械重复；未覆盖的平台/构建配置/故障窗口单独补。记录源码/构建配置、命令、结果与未跑项；环境缺失不是通过。

**出口：**M1–M8完成，已有用户主流程无回归，故障/资源/平台/真实环境证据齐全；仍只是一套候选版本，不自动部署。

## 4. 总体验收与交付

| 用户流程           | 必须观察的结果                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| 桌面对话/多会话    | Enter/IME、草稿、运行时切Harness/会话、关页面任务继续、重开授权/停止、容量周转                        |
| 输入/设置/自主轮次 | 真实能力下typed附件/图片、thinking/Fast恢复、后台独立轮次与冲突输入保留                               |
| 历史/内容          | 超200条及长归档冷查/筛选/完整导出、连续Markdown、可读终端、Plan/复制/偏好稳定                         |
| 审阅/管理          | 预存脏文件不误算、shell净变化、失败/取消审阅、安全撤回、批量历史清理；context只显式写                 |
| 用量/命名          | 模型/日期/会话、cache/缺失/未定价/覆盖价、标题独立费用，fork/load不重复计、manual-wins                |
| 手机独立使用       | 创建→首任务前选模型→A/B排队→授权→stop/interrupt→history/sync/偏好/预览→继续；断网/429/重启不重跑Agent |
| 生产与恢复         | 单宿主/唯一会话owner/typed边界无业务raw JSON、冷查询、原生恢复/安全fork、背压/join/lease、整组回退    |

不能以按钮存在、adapter有方法或测试全绿代替以上流程；provider不支持的能力要有明确可验证的拒绝/降级，不得默默吞输入。当前行为分别维护在[VS Code](workbench-vscode.md)、[Telegram](workbench-telegram.md)、[Diff/撤回](turn-diff.md)、[管理](workbench-management.md)和[持久恢复](persistence-recovery.md)。

交付时只更新本计划阶段状态及这些当前说明，不恢复多份验收ledger。发布按[切换与回退清单](workbench-cutover.md)执行：另行授权、旧组合备份验读、新隔离root、binary/VSIX/配置/root整组切换与回退；禁止旧binary打开新schema。体验对齐不保证旧任务跨版本自动续跑，也不代表自动迁移。
