# Changelog

## 2.0.8 — 2026-10-26

- 切回会话显示最近 3 轮完整对话，“加载更早消息”每次补充 20 轮；按回合边界分页，展开历史期间继续接收实时输出。
- 自动读取并校验归档消息正文，拼接完整 Markdown/LaTeX 后显示，修复长回复和数学公式被片段分页截断；超出显示预算时保留显式导出入口。
- 移除重复的“回到最新消息”按钮，底部箭头在展开历史后重新加载最新 3 轮。
- 已结束回合自动显示本轮修改，零文件结果也显示；“重用”固定在用户消息右下角，移除模型页重复的“会话命名与其他设置”区域。
- 本地验证包含 TypeScript 277 项、Chromium 22 项及隔离原生插件基础检查；发布制品另经本标签干净 CI 和实际安装包验证。沿用 2.0.x 数据合同，安装前停止并备份现有 root，不重放旧任务。

## 2.0.7 — 2026-10-26

- 发布经典界面恢复及严格对齐：模型/thinking/Fast 选择器、历史伸缩、自动逐轮 Diff、总 Diff 和安全撤回。
- 修复发送后草稿残留，新会话自动加载设置并继承按 Agent 保存的模型/thinking，错误提示可关闭。
- 默认最多 16 个驻留 worker，按接受的用户输入排序，最近 8 个保留 4 天、其余 1 天；空闲释放保留原生历史，运行和交互保护不变。历史编号显示真实留存等级，新增手动释放。
- Telegram 新会话使用独立话题，桌面会话在唯一已授权 forum 中自动镜像；统一编号/标题同步，打开既有会话返回原绑定，保留不确定创建和投递防重。
- 配套更新 VSIX 与单宿主；沿用 2.0.x 的 IPC/storage/root 合同，不导入或重放 1.x 旧数据。安装前停止并备份当前 root；新增留存字段要求客户端与宿主同时升级。
- 本地源码验证：Rust 383 通过/3 既有忽略、TypeScript 272、Chromium 20、Telegram 本地 HTTP/IPC 29、原生 VS Code 15；发布标签另外通过干净 CI、musl 制品与配套 VSIX 校验，不冒用历史候选散列。

## 2.0.6 — 2026-10-26（未发布）

- 干净 CI 发现自动 Diff 查询将 DOM 字符串直接传给品牌类型 ID，类型检查失败；未生成公开 release，保留失败标签，修正随 2.0.7 发布。

## 2.0.5 — 严格经典界面对齐（本地候选，未发布）

- 直接复用 v1.0.0 的页面布局和样式，恢复原版工具栏字符/SVG、会话编号、空白欢迎与离线预览、80px 默认输入区和原版分隔线。
- 恢复供应商折叠模型分组、四价格网格、统计汇总卡片/切换标签/时间图；保留 v3 独立配置与 UTC 统计语义。
- 中间回复、思考和工具过程按原版折叠，最终回答和输出图片保持直接可见；恢复待办样式与逐文件折叠 Diff。
- 新增原版安装包截图对照门禁：同内容、同主题、320/460px 两种宽度，检查几何偏差不超过 2px、主要页面像素差异低于 1%；额外保存历史/设置/统计/授权/待办/运行中截图。

## 2.0.4 — 本地界面修复（未发布）

- 以 v1.0.0 为基准恢复紧凑工具栏、折叠会话历史、底部固定输入框、上下文圆环与原版原生下拉控件。
- 模型和统计恢复为独立页面；诊断与低频会话操作收进菜单，对话中保留授权、待办、停止和工作区变更入口。
- 保留 v3 宿主和操作回执语义；切换 Harness 仅切换观察，不取消、创建或重放后台任务。

## Unreleased

## 2.0.3 — 2026-10-24

- 浏览器工具面板验收先等待页面空闲状态，并只在折叠时点击展开；保留运行中默认展开的产品行为，避免盲点 summary 反而关闭面板导致偶发超时。
- 修正干净发布环境的报告输出：制品 smoke 在验证成功后创建报告父目录，不再依赖本机已有 test-results；v2.0.2 的实际 smoke 通过但报告落盘失败，未生成公开 release。

- 修正 Chromium 验收夹具：直接加载带受控 blob favicon 的 HTML，避免将 CSS 文档替换为页面后迟到的默认 favicon 请求触发 CSP 错误；产品 CSP 与零错误断言保持不变，17 项实际浏览器流程通过。
- v2.0.1 标签因上述测试夹具问题未生成公开 release；保留原失败标签，不移动历史标签。

- 修复发布审计发现的依赖漏洞：DOMPurify 3.4.17、markdown-it 15.0.3、Zod 4.6.7、rustls-webpki 0.103.16 和 webpki-roots 1.0.10；ACP SDK 保持原版本，实际使用的 Zod v4 路径统一到补丁版并执行回归。
- v2.0.0 标签的首轮安全审计失败、未产生公开 release；保留该失败记录，本次以新补丁标签发布，不移动历史标签。

- **不兼容升级**：重写为唯一 `pi-acp-workbenchd` 单宿主，统一 SQLite 持久化、IPC v3、会话/worker 生命周期和 Telegram 调度。旧 binary、VSIX、配置与 root 必须成组保留；没有自动旧格式导入器，新版使用独立空 root。升级前阅读 `docs/workbench-data-migration.md` 和切换/回退清单，不直接打开或清空旧业务数据。
- 完成 typed 文本/上下文/图片输入、provider 设置与恢复、Pi 自主轮次及标准 Form 交互、Plan 投影、安全 native fork、usage/标题、全历史管理、Diff 与显式撤回、Telegram 独立手机流程。
- 修复 IPC 半帧取消、provider fork 源 worker 保护、空闲 owner 有界回收、旧 epoch 事件隔离、deferred topic 公平调度、大 outbox 读取及长驻 WAL 复用等问题，保留 receipt 防重与未知外部效果不重放语义。
- P6 原计划 23 项有限验收完成：两平台生产矩阵、真实 Pi/Codex/Bot、原生 VSIX/Trust、故障切点、同机普通读取 P0 对照、五轮 mixed/600 秒 soak 和 GNU 同宿主两小时；范围和历史负例见 `docs/workbench-p6-validation.md`。本 release 标签的制品另由 CI 干净构建并验证，不将本地候选散列冒充发布散列。
- 明确能力边界：Claude 本次真实在线验收由用户排除；Telegram 入站照片尚未实现，terminal:false 不提供终端正文，Pi stable profile 不提供 Fast。不会将这些能力标为成功通过，也不自动部署或迁移数据。

## 2.0.2 — 2026-10-24（未发布）

- 浏览器修正通过，musl 制品 smoke 因报告父目录不存在未能落盘；2.0.3 修正后发布。

## 2.0.1 — 2026-10-24（未发布）

- 安全依赖修复与服务回归通过，浏览器 favicon 夹具错误阻止发布；修正后由 2.0.2 发布。

## 2.0.0 — 2026-10-24（未发布）

- 首轮发布审计失败，未生成公开 release；内容及补丁随最终 2.0.x 公开版本发布，原标签和工作流失败记录保留。

## 1.0.0 — 2026-10-15

- 首个稳定大版本：支持 Pi、Codex、Claude ACP harness，跨会话历史与共享 session daemon，后台自主轮次与安全取消、权限交互、todo / 扩展输入、模型与用量统计、图片及流式 Markdown 渲染。
- 服务协议与运行时进一步强化：自主轮次事件、Fast mode、模型上下文与 usage inspection，改善 worker 生命周期、并发队列、重启恢复、图片处理和服务状态同步。
- 图片刷新仅替换已变化内容，保留旧图直至新图加载；新增 Pi 扩展提问及 todo UI 与真实 RPC 桥接支持。
- 用量归档改为全局账户级存储，多窗口在锁内合并去重记录并按 session 更新元数据；无效或损坏文件拒绝覆盖，标题和编号支持增量删除。
- 补充用量、todo、扩展问题、自主轮次、图片和服务协议回归测试；本地全量验证通过。

## 0.12.16 — 2026-10-15

- 会话服务 `maxWorkers` 默认值由 3 调整为 16，示例配置同步更新；该值为执行中与空闲驻留 worker 的总数上限，进程仍按需启动。已有显式配置保持不变；若需增加容量，请将 `sessions.json` 中的 `maxWorkers` 改为 16，并在任务结束后重启会话服务。
- README 聚焦现有核心功能与安装入门，新增桌面使用指南，按使用、运维、开发和历史记录重组文档索引，清理过时迁移与逐次修复描述。
- 明确 worker 容量与空闲回收的关系：前 8 个进程空闲超时为 16 天，其余为 1 天；达到容量上限时仍可提前回收空闲进程。
- 配置回归覆盖默认 16、显式容量保留及 1–16 范围校验。
- Rust TLS 依赖 `rustls` 更新至 0.23.46，修复 RUSTSEC-2026-0346、0347、0348、0349 安全通告。

## 0.12.15 — 2026-10-13

- 客户端价格、模型显示与所选 Agent 偏好统一保存到本地 `~/.pi/pi-acp-workbench/preferences/`，跨 VS Code Profile 和工作区共享；旧 Profile / 工作区设置不导入。
- 模型价格并发保存增加逐模型版本校验，拒绝过期窗口覆盖；全局文件读取异常时保留最近成功读取值，损坏或已知文件丢失时拒绝覆盖 / 静默重建。
- 强化价格、模型显示与客户端设置文件的并发锁、符号链接和非普通文件保护。

## 0.12.14 — 2026-10-13

- 修复实时会话推送覆盖历史列表驻留信息导致会话编号绿色闪烁的问题；继续接受服务列表返回的驻留档位变化和进程退出状态。
- 每次打开模型设置或用量统计都同步当前会话状态并读取最新元数据；忙碌时支持不进入任务队列、不改变运行 phase / 授权的只读 inspection。模型目录和选择值在不能重载配置时也重新读取，保留 Fast mode 控件；切换会话后的旧请求不吞掉新页面刷新。
- 加固会话状态订阅与会话挂接的并发时序，修复快速切换订阅 / 会话时旧响应覆盖新状态的问题；修复连续分块响应间错误继承超时的问题。
- 防止读取工作区内的 FIFO 图片时阻塞；新增边界和竞态回归测试。

## 0.12.13 — 2026-10-13

- 支持 Pi 扩展通过 `sendMessage(..., {triggerTurn:true})` 自主唤醒：同步忙碌状态、取消与授权，显示 custom 完成消息，周期检查点与最终持久化共享历史，并发布独立的后台轮次完成事件。
- 隔离自主轮次与用户请求的生命周期：旧 `agent_settled` 的元数据 I/O 不再结束新轮次；自主轮次忙碌或提交窗口被唤醒抢先时，用户输入明确报“发送失败”，对应消息左侧显示淡红色感叹号，不进入 follow-up/steering 队列，也不在空闲后自动重发。失败草稿按请求与会话作用域恢复；拒绝不会打断自主输出或授权，持久收据阻止失败请求重放。取消同时清理插件原生队列，迟到的取消不停止新唤醒。
- 恢复 worker 时缓存有界的早到事件，区分实时自主事件与历史 replay；worker 代际过滤旧进程通知。远程 / 自主回复结束后自动刷新统计，并避免 inspect 自身的 busy / ready 推送形成刷新循环。
- 新增真实 Rust daemon + 构建后 ACP 适配器 + 可控 Pi RPC worker 的唤醒 / 输入 / 取消 / 授权 / 恢复交错回归测试。

- 模型可见性迁移到全局扩展存储目录的 `model-visibility.json`，通过跨进程锁和 durable 原子提交合并多窗口设置；旧 Memento 偏好仅在首次成功写入时导入，显示路径不再异步写回旧缓存。
- 模型勾选和供应商批量显示改为带会话标识的目标模型增量更新；拒绝旧页面的全量提交，避免目录新增模型被误隐藏，保留暂时离开目录的隐藏设置。
- 价格文件损坏提示与服务端用量提示合并，正常刷新不再清掉存储错误；文件恢复可读后移除错误提示。
- 补充真实子进程可见性并发写入、旧缓存迁移 / 重置、目录变化 / 迟到页面、写入失败 / 损坏文件及价格错误提示恢复回归测试。

## 0.12.12 — 2026-10-13

- 发送 / 停止按钮与正常 context 占用圆环共用未压暗的主题色，提高按钮亮度；保留悬停反馈、禁用变淡及高占用圆环的警告色，并补充深浅主题浏览器校验。

- worker 崩溃或关闭后继续清理整个进程组；SIGKILL 前保留未回收的组长 PID，避免延迟信号误伤复用的 PGID，daemon 关闭等待所有 worker 完成清理。初始化 / 恢复阶段的强制取消保留清理所有权，失败路径等待 stop，避免 daemon 先退出留下忽略 SIGTERM 的 worker。
- 空闲回收在分配锁内重新计算活动时间与驻留档位，核对 runtime Arc 身份，并原子检查 busy / 移除目录项；既不会用旧引用删除同 ID 的新 runtime，也不会用旧过期判断淘汰刚完成任务或晋升驻留档位的 runtime。
- 导出对话在保存对话框前捕获会话、generation 与 cwd，确认和分页完成后再次校验，切换后取消写入。
- 模型价格偏好迁移到工作区扩展存储目录的独立 price-overrides.json；通过跨进程锁、最新文件读改写和 durable 原子提交合并多窗口设置，不依赖 Memento 的整对象写回。旧聚合表 / 分模型键只在首次提交时迁移，恢复默认保留重置标记；冷启动先加载用量记录再计算兼容价格，避免误删其他已计费模型的旧价格。

- 修复 Pi 适配器前置 RPC 与实际轮次启动之间的取消窗口，停止后不再发送模型 prompt，后续新轮次仍可正常执行。
- 超大成功结果以 SHA-256 引用保存到收据结果正文，避免合法模型目录超过 256 KiB 导致操作已成功却报告失败；缓存结果跨重启/删除仍可返回，损坏或缺失绝不重跑。新增 `completed_ref` 磁盘状态，旧 daemon 将拒绝读取，回滚需恢复升级前备份。
- 重复停止不再重置 5 秒强制终止计时器，避免不响应取消的 worker 和会话删除被持续拖延；停止或结束后的迟到授权请求直接取消，不再发布新的授权卡片。

- 修复 prompt 等待 runtime / 工作进程分配期间的取消竞态；取消代际贯穿分配与加载，尚无 runtime 的排队任务也正确确认停止。
- 删除运行中的单个会话先停止当前任务并取消旧排队请求，再串行删除；后续停止操作不会取消删除本身。
- 客户端忽略被新推送、新查询或会话切换取代的迟到状态查询；修改模型 / 模式后以服务端状态收尾，不再用本地 ready 或旧目录覆盖其他客户端的 busy 状态。
- worker stderr 单行缓冲限制为 16 KiB，超长行保留前缀并标记截断，持续排空后续内容，避免无换行日志耗尽 daemon 内存。
- 补充取消 / 删除交错、迟到 socket 回复、设置完成后的 busy 状态，以及 stderr 超长行 / UTF-8 边界回归测试。

- 会话任务队列改用 Drop guard 回收全局与 lane 槽位：运行中的任务被中止或 panic 不再泄漏排队计数，关闭时 `close()` 不会永久等待；请求收据的 in-flight 去重改用弱引用检测执行者存活，owner 中止后相同请求 ID 的等待者与后续调用由持久收据裁决，不再死等。
- 适配器会话重建后（codex `remoteSessionId`）的 update 事件按本地 sessionId 路由，订阅者不再丢事件；40ms 合并状态推送改用可中毒恢复锁，worker 回调 panic 后该会话的推送不再停摆。
- 损坏 / 过大的模型价格文件不再阻止扩展激活：显示路径回退到 Memento 旧值并以提示展示原因；写入仍在锁内重读并中止，原文件不被覆盖。
- 会话客户端 socket 同步创建失败后不再永久拒绝后续调用；断连错误保留底层原因（如 ECONNREFUSED）。
- 用量记录只保留最新 5000 条，防止工作区状态无限膨胀。
- diff 变更列表的资源 URI 现在返回修改后内容（删除文件取修改前），点开不再是空文档；标题生成跳过 stdout 中的非 JSON 诊断行；清理 native 分支恢复路径的空 try 死代码。
- 新增 owner 中止后的 in-flight 回收与唤醒、信封 sessionId 事件路由、损坏价格文件降级、用量上限与非 JSON 标题输出回归测试。

## 0.12.11 — 2026-10-13

- 修复服务端撤掉最后一个模型价格后客户端仍使用旧价格的问题：省略 `prices` 保留已知价格，显式 `{}` 清空服务端默认价格，用户覆盖价格仍保留。
- TypeScript / Rust 统一目录合并规则：省略字段不覆盖已知目录；冷启动、加载与分支握手遇到空目录时回退到快照；运行中的配置响应与更新可用 `[]` 明确清空，并原样推送客户端。
- Pi 模型目录暂不可用时避免推送缺少模型选择器的目录；历史列表正确传递工作进程驻留天数。
- 流式输出重绘按 80ms 间隔合并，减少长消息 Markdown 重复解析；完成输出与切换会话时立即安排重绘，不等待节流窗口。
- 新增价格省略/清空、目录冷启动/运行中合并与推送、流式重绘节流回归测试。

## 0.12.10 — 2026-10-12

- 工作进程上限提升到 16，空闲进程按最近提交任务的时间分层回收：前 8 个驻留 16 天、其余 1 天；`idleMs` 仅控制扫描周期；只有提交 prompt 计入活跃，浏览与设置修改不续命。
- 历史会话列表用编号颜色标记进程驻留状态：绿色为 16 天档、黄色为 1 天档、默认色为未驻留。

## 0.12.9 — 2026-10-12

- 放宽适配器会话重建条件：会话在没有 assistant 输出前即可安全重建（此前放宽到“无 user 消息”，会导致首轮挂起/取消后的会话无法恢复并持续报错）；有真实回复的会话仍拒绝静默替换。

## 0.12.8 — 2026-10-12

- 修复模型显示设置偶发全部失效的问题：适配器响应或通知缺少 `configOptions` 时不再清空模型目录；目录未知期间可见性保持「全部显示」并拒绝写入隐藏名单，避免缺失窗口被误存为全部隐藏。

## 0.12.7 — 2026-10-12

- 修复 Codex / Claude 新建会话完全不可用的问题：适配器无法 `session/load` 从未产生过消息的新会话（如 codex "no rollout found"），daemon 现在在会话尚无用户消息时回退到 `session/new` 并以 `remoteSessionId` 记录适配器侧会话，后续模型切换、对话、取消与标题均正常使用；已有用户消息的会话在加载失败时仍然拒绝，不会静默替换历史。
- 模型设置页每次打开会重新同步 Pi 模型目录，运行中新加入的 provider / 模型立即可见。
- 模型显示设置改为隐藏名单：新加入的模型默认显示；会话名压缩模型列表与对话模型选择器同步应用显示设置。

## 0.12.6 — 2026-10-11

- 历史列表移除独立的加宽滚动条样式，与对话、输入框及统计页统一使用 6px 滚动条；仍可滚动访问全部会话。
- 浏览器回归统一验证各区域滚动条宽度。

## 0.12.5 — 2026-10-11

- 统一柔化输入框、用户消息、选中会话、模型设置、统计页与悬停提示的高亮背景，向对话底色混合，保留主题色调；按反馈进一步轻微压暗。
- 同步降低按钮、悬停状态、聚焦边框及代码背景的突兀感，保留选中状态辨识度与文字对比度。
- 新增深浅色主题背景一致性及文字对比度浏览器回归，并渲染接近参考主题的预览图。

## 0.12.4 — 2026-10-11

- 修复历史列表截断至前 16 条会话的问题：保留全部会话供滚动查看，4 / 10 / 16 档位仅调整列表高度，并增强右侧滚动条可见性。
- 用量统计统一排除没有有效插件会话编号的记录，覆盖总计及按模型、时间、会话视图；不删除原始计费记录。
- 发送箭头与终止方块改用 Agent 输出区域背景色；历史上下按钮去掉圆形底色与描边。
- 新增全部历史可达性、外部会话统计过滤及深浅色按钮样式的浏览器与单元回归。

## 0.12.3 — 2026-10-11

- Context 输入框与上方“非缓存输入”输入框等宽对齐，适配双列及四列模型卡片。
- 用量统计按模型以估算费用降序排列，按会话以会话编号降序排列；未编号会话置后，同值时以标识排序。
- 新增统计排序、价格刷新及窄屏/宽屏输入框对齐回归测试。

## 0.12.2 — 2026-10-11

- 悬停提示在鼠标离开对应元素时立即隐藏，移除消失延迟和提示框悬停续显；提示框不再接收鼠标事件，保留键盘聚焦提示。
- 新增离开触发元素、移入提示框及元素内部移动的单元测试和浏览器回归。

## 0.12.1 — 2026-10-11

- 模型设置与用量统计改为并列页面，修复历史记录不能返回对话、页面按钮高亮缺失或残留；所有入口进入模型设置后均返回对话。
- 移除模型设置的“显示全部 / 仅保留当前模型”按钮，保留供应商批量操作和逐模型可见性设置。
- Context 输入改为 k tokens（256 即 256K），缩短输入框，隐藏各模型五个数值框的增减按钮。
- 模型设置与统计页使用全宽吸顶功能栏，替代单个悬浮返回按钮；新增导航、单位换算和栏布局的浏览器回归。

## 0.12.0 — 2026-10-11

- 模型设置按供应商默认折叠，新增供应商批量显示/隐藏及恢复默认，模型设置与统计页提供固定返回按钮。
- 统计页移除独立价格入口和名称悬浮框，保留模型名跳转；费用按天/周/月显示柱状图，会话行显示稳定编号。
- Pi 首条输入即生成简短会话名，可单独选择压缩模型或关闭；调用不含工具和项目上下文，不写入聊天，失败回退短文本且不自动重试。daemon 持久化标题与模型偏好，保留适配器原生标题，标题调用返回的用量纳入统计。
- 修复 `**注意：**正文`、`这是**“重点”**文字` 等中文标点旁的 Markdown 加粗，保留代码、转义、嵌套强调与数学解析边界，并明确加粗字重。
- 将模型价格和显示模型页面合并为“模型设置”：紧凑单标题卡片、右上角显示勾选、四项价格、左下 context 长度及右下统一保存/恢复默认；保存采用带确认结果的单请求，后台刷新不覆盖待保存输入。

- 服务协议升级为 v4：实时历史窗口与按 entry ID 分页，Diff 正文独立保存并按需加载；插件、session daemon 与 Telegram relay 必须配套更新。
- 文件撤回下沉 daemon，按已提交会话/条目 ID 操作，复用 durable 防重放收据；工作目录共享/独占许可协调多客户端任务与撤回，覆盖父子目录。
- 撤回使用非跟随目录描述符、有界读取、发布前设置权限的私有临时文件，不再由扩展直接执行 Git；明确多文件中断可能部分恢复，不自动重放。通过 Linux syscall 调用 renameat2，兼容未导出该函数的 musl 发布环境。
- 历史活动组与工具输出延迟渲染；抽离 Webview 状态接收及分页、服务帧编码和 Diff 内容存储模块。
- 增加启动可达性清理与持久化故障恢复契约；删除历史后的孤立 Diff 内容在下次正常启动清理，引用损坏时保留证据。

- 安全：聊天中的 http(s)/mailto 链接需模态确认后打开（显示 punycode 规范化地址，可改为复制），拒绝带用户名/密码的链接。
- 安全：Telegram systemd 单元（示例与向导生成）增加 NoNewPrivileges、系统调用架构/地址族限制等无需 root 的加固项。
- `npm test` 改为运行全部 Vitest 测试，原按改动选择的行为移至 `npm run test:changed`；`npm run package` 输出到仓库根目录。
- 适配器测试改为构建到临时目录，不再改写 `dist/`。
- Rust 非测试路径去除可避免的 `unwrap()`；UI 请求的失败结果回填改由各 handler 的 `fail` 钩子声明。
- 修复删除/清空历史等待服务确认期间，迟到的历史刷新重新填回用量标题的竞态；确认删除后才清理标题，保留计费记录与价格。
- 依赖：`@agentclientprotocol/sdk` 1.8.0、`highlight.js` 11.12.0、`mermaid` 12.1.0、`@playwright/test` 1.64。

## 0.11.7 — 2026-10-10

- 修复冷会话 / 插件重载后默认模型价格为空、恢复默认不重新读取 Pi 单价的问题；打开价格页或显式刷新会加载实时目录，恢复默认清理对应旧版裸模型 ID 覆盖，保留其他已知模型的设置，并显示读取失败原因。
- 修复 Pi 模型 context 长度修改后 RPC 模型快照及上下文圆环分母未同步的问题；闲置时重新加载模型配置，保留 thinking / Fast。
- 模型管理页显示 Pi 各模型 context 长度，支持按 tokens 保存或恢复默认；写入 Pi `models.json`，运行中禁用修改，不改变服务商真实上限。

## 0.11.6 — 2026-10-10

- Telegram `/menu` 按位置分为 General 管理菜单与 Topic 会话菜单，回调校验话题 / Session 绑定及权限边界；移除 `/settings`，旧命令只提示使用 `/menu`。
- Topic 菜单仅保留模型、思考强度、状态、停止任务、同步最近的消息（等同 `/history`）和刷新面板；General 第一行并排新建 / 已有会话，其后提供 `/sync`、全局推送、静音和帮助，创建 / 打开后提供 Topic 链接。
- Telegram 输出与历史同步支持 ACP / 工具 / 嵌入资源，以及内嵌或会话工作目录内的 raster 图片；PNG / JPEG 上传为照片，GIF 为动画，WebP 或不符合照片尺寸要求的图片为文件。不下载远程图片、不支持 SVG，限制格式、真实路径、文件大小、数量及发送速率。
- 终态事件保存本轮图片 entry ID 引用；文本与图片独立记录持久发送检查点，图片失败可重试且不重新执行模型，遵守推送与静音设置。消息送达但检查点未落盘时崩溃仍可能重复，手机图片输入尚不支持。
- 桌面发送箭头缩为 16px，保留 26px 按钮及防挤压修复。

## 0.11.5 — 2026-10-10

- 输出页面显示 Agent / 思考 / 工具返回的图片，以及 Markdown 内嵌和当前会话工作目录内的 PNG、JPEG、WebP、GIF 图片；本地读取检查工作区信任、会话代际、真实路径、文件签名和 3 MB 上限，限制并发与缓存；不自动请求远程图片，失败可重试。
- 发送 / 停止按钮统一为 26px、同色圆形，箭头放大并修复通用内边距导致 SVG 被挤小的问题；停止方块与箭头同色并居中。上下文圆环微缩并加粗。
- 历史展开 / 收回按钮缩为 20px，间距 12px，使用更大的无尾上下尖角；取消历史列表悬浮详情。
- 历史档位改为 4 / 10 / 16 条，已保存的 20 条档位自动兼容为 16 条。
- 修复矮窗口及较高输入区下历史列表被压至不可见、底部越界的问题；列表滚动与收回按钮保持可达。
- 明确常规发布不重复完整浸泡；0.11.3 / 0.11.4 历史浸泡仅覆盖各自版本与二进制。

## 0.11.4 — 2026-10-10

- 修复历史列表只有当前会话显示运行圆环的问题：服务历史列表提供所有会话的实时 busy 状态，前台和后台会话均显示运行圆环，结束后取消。
- 历史列表底部改为上下箭头圆形按钮，显示档位为 4 / 10 / 20 条；20 条不可继续展开，4 条时向上关闭历史面板。档位在刷新和切换会话时保留。
- 发送按钮改为圆形；停止按钮改为红色圆形配白色方块，移除可见文字，保留无障碍标签与提示。

## 0.11.3 — 2026-10-10

- 修复 PATH 空项、`.` 和相对目录可从不可信工作区劫持 Pi 启动及登录可执行文件的问题；找不到可信可执行文件时不再回退裸命令以免再次触发不安全 PATH 搜索；显式配置的相对路径仍保留，增加安全回归测试。
- 切换 Pi 模型时保留原 thinking 档位（目标模型支持时）及原生 Fast mode 设置，不再因模型默认值重置为 low。
- 活动会话身份、连接与取消代际集中到 ActiveConversation，统一重置，协调器改用本地窄接口，移除对 ChatProvider 的反向依赖；迟到的启动或分支失败不再恢复已删除会话。请求互斥收口到 ConversationLifecycle，分发使用 handler 元数据和统一参数 schema。
- 会话协议、快照及共享工具移入 pi-acp-core；两个 Rust daemon 共用类型，Telegram 状态与会话列表使用 serde 解码；ACP 消息内容热路径开始采用结构体。
- 隔离适配器测试中的宿主托管安装环境，明确安装目录优先于数据目录；升级 Vitest、vsce 和 esbuild，增加开发依赖审计并突出 Telegram 任意目录执行风险。

## 0.11.2 — 2026-10-09

- 计费统计移除内置静态价格表，默认单价直接读取 Pi 模型配置并随刷新更新；用户自定义价格优先，恢复默认使用 Pi 的最新价格，缺失价格明确显示未定价。
- Pi 每次启动动态检索可执行文件：有效显式配置优先，其次 PATH、当前账户的 Pi 托管安装、Node 所在目录与 npm 实际全局 prefix。过期的显式路径自动回退并输出诊断提示，兼容受限 systemd PATH 与新安装目录；新建、恢复、原生分支及登录使用相同查找逻辑。
- 增加价格刷新 / 自定义覆盖 / 恢复默认及 Pi 路径查找的回归测试。

## 0.11.1 — 2026-10-09

- 桌面消息流在工作时直接显示模型输出，连续工具调用与思考默认合并折叠；工作结束后自动折叠整轮执行过程，保留最终回答及本轮 Diff。最终回答后的工具状态更新不会隐藏回答。
- 历史列表仅由历史记录按钮控制开关，选择会话、刷新、输出、连接变化和界面重新加载保留展开状态。默认显示最新 4 个会话，底部支持展开更多与收回，保留增量更新时的行与滚动位置。
- 修复运行中无法新建或切换会话的问题，同时允许切换 Harness；原任务继续后台执行，切回后可查看进度或停止。请求锁按操作隔离，旧轮次不会干扰新会话，导航失败保留原运行会话。
- Pi 的 `/compact` 成功后只显示压缩成功，不再输出内部上下文摘要；及时清除压缩前的占用，未知占用明确显示等待下一次模型回复更新，回复后恢复实际数值。压缩失败继续返回错误。
- 增加消息流、历史展开、后台会话切换、导航失败及压缩占用更新的回归测试和浏览器截图检查。

## 0.11.0 — 2026-10-08

- Telegram 新增话题内按钮面板（/menu、/settings）：真实模型与思考强度选项分页选择，当前值标记、模型切换后依赖选项刷新，与桌面共享服务端偏好；执行/排队期间拒绝修改。
- Telegram 新建会话改为目录与 Harness 按钮向导，支持 Pi / Codex / Claude、最近目录、回复输入新目录、沿用项目切换 Harness、取消与重复点击保护。新建及打开后显示设置卡片，按钮校验用户/话题/消息/版本并有过期恢复提示。
- /sync 与 setup 统一同步摘要：按更新时间排序，最新 5 个会话各取最后 10 条文字消息，其余各取最后 2 条；去重前截取、跨重启保存同步位置，提示 /history 与 /history all 手动获取更多内容。移除 /syncall 全量同步功能。

- 历史版本曾提供 `telegram:setup` 交互配置向导；当前单进程 workbench 发布包不包含该旧入口。请使用显式配置文件、环境变量和唯一的 `pi-acp-workbenchd` unit。

- 删除旧 Pi modes 思考等级推断、旧客户端全量状态订阅和复制完整对话的后台消息；状态订阅统一使用带版本的增量协议，插件与服务需一起更新。
- Pi 增加按会话原生分支持久化的 Fast mode 开关，适用于 OpenAI / Codex Responses 优先级请求；不支持的模型不显示，扩展加载或原生节点 RPC 失败明确报错。模型管理按钮移到右上角，替换复制完整对话按钮。
- 服务示例默认从 PATH 查找 Pi，移除强制填写绝对路径的示例与文档要求；systemd PATH 使用 `%h` 支持不同账户的用户安装，保留可选显式覆盖。

## 0.10.0 — 2026-10-08

### 服务与兼容边界

- 会话服务和 Telegram relay 收敛为 Rust 单一生产实现。VS Code / 手机统一经 v3 socket 操作 Pi、Codex 和 Claude，会话队列、worker、历史、偏好、授权和每轮 Diff 均由 daemon 管理；移除 TS 服务入口、委托快照写入、客户端文件租约及直接写入降级。
- 升级须配套更新插件、会话 daemon 与 Telegram。只接受完整快照和带请求指纹的收据；不兼容数据报错保留，不推断、自动迁移或静默清除。旧实现从历史 release / commit 及备份回滚。
- worker 池、会话操作、轮次与 phase 拆分职责；Telegram 接收、命令、投递、历史与授权独立模块，状态写入收口至 StateStore。OwnedTask / TaskScope 跟踪本地任务，关闭时拒绝新任务并有界回收。
- Codex / Claude 用量按模型规范化并持久化，分页、重启后可查询，累计消费与上下文占用分离；缺失数据不回填原生历史，不将费用估算当成最终账单。

### 稳定性与持久化

- accept 系统错误记录日志并退避 100 ms；连接满额尝试返回关联请求的 busy 错误，关闭信号可中断等待。同步短临界区统一使用 lock_unpoisoned，worker / 操作边界捕获 panic，恢复已提交会话快照并关闭对应 worker，避免连锁失败。
- UI 操作在首次等待前同步保留门控，阻止并发发送、会话操作及设置 / harness 切换；取消与授权继续可用，失败后释放门控。
- socket 在私有目录绑定、设置 0600 后原子发布；显式订阅、UTF-16 分块、背压和资源预算隔离违规连接。超大响应或广播返回局部错误，半帧与分块停顿有界超时。
- 新建、提示词、原生分支与设置持久化去重，请求 ID 绑定方法 / 参数指纹；收据、历史、偏好、Telegram 游标与最终 outbox 同步文件和父目录。初始写失败不执行，终态 outbox 写失败传播为 interrupted，不自动重放。
- 收据到期清理、逐文件 outbox 读取、预览独立缓冲和周期写入合并控制资源增长；超时释放客户端 pending 槽位，worker 退出与闲置回收等待进程组结束。
- Telegram update 和游标原子入队，pending 重启后可继续，started 未完成记录提示结果不确认并禁止自动重放；控制操作预留容量，停止丢弃旧排队提示词。话题绑定、投递确认和通知开关经 durable 事务提交。
- Telegram 支持安全 Markdown entities、长代码 / emoji 分块、实时静音与显式目录限制；生产固定官方 API，模拟传输只在隔离 contract-test 构建中启用。过期授权、重复投递 / 确认、历史分批及重启均有回归。

### 桌面、适配器与构建

- Mermaid 使用本地 ESM 按需分块，构建清理旧分块，保留净化、错误源码回退和 CSP；VSIX 明确排除 source map 与原生服务。
- 原生历史与 Pi RPC 消费字段补最小类型，清理未使用导出、无用参数和直接 @types 依赖；补严格断言补丁的上游升级流程。许可证固定遍历顺序、统一换行、内容变化才写入。
- socket 客户端、状态增量和 RemoteAgent 使用明确的帧 / 事件 / 响应类型，未声明的扩展结果默认为 unknown；清理源码和测试中的其余显式 any，测试模拟对象沿用生产契约。
- Tokio 按 crate 收窄 features，服务构建 / 打包只支持 Linux x86_64 GNU / musl，记录真实 ABI、源码指纹、生产 features 和 SHA-256；生产 smoke 与回滚使用隔离数据目录。
- npm overrides 统一 mermaid 传递的 KaTeX 到 0.19.0，包含 GHSA-238p-pmpm-9mq7 修复。

### 验证与文档

- verify 包含 clippy、完整服务 test:full 和浏览器冒烟。test:full 一次准备 debug / contract 产物、有界并行、独立日志与失败汇总；日志默认保留最近 5 次，保护活动运行。
- CI Actions 固定 commit SHA，增加 Rust 缓存，下载固定版本 cargo-audit，共享一次 npm 安装 / JS 构建给服务、浏览器和生产 job；Rust 与生产 npm 锁文件审计失败即阻止流程。
- 标签 CI 自动发布配套 VSIX / musl 服务包，核对版本、生产源码提交和包内容，上传草稿后下载复核 SHA-256 再发布。
- 冻结 Wire / 磁盘规范、协议类型漂移检查与原生分支样例；Rust 单测、黑盒契约、双服务集成、内存及浏览器覆盖当前单一实现。
- 删除已完成的迁移计划归档及打包依赖，新增文档索引，更新部署、架构、协议、数据格式、测试与发布指南。验收记录区分当前回归、历史产物和未完成的长时间 / 外部发布范围。

## 0.9.4 — 2026-10-05

- 历史列表直接读取原子提交的索引，不再等待正在进行的历史写入和跨进程写锁，减少刷新阻塞。
- Pi 会话工作进程重新启动时恢复已保存的模型与思考设置，避免适配器默认值覆盖会话选择。
- 本轮 Diff 的文件列表默认折叠在“全部修改”中，空结果和采集范围说明直接显示。
- 发送消息后自动回到底部并恢复跟随新输出。

## 0.9.3 — 2026-10-04

- 合并进行中的后台历史刷新，避免慢查询时定时轮询持续排队。
- 连续相同后台错误只提示一次，恢复后再次失败才重新提示；手动刷新仍报告失败，查询失败时保留已有历史。
- 会话服务超时提示包含请求类型和等待时长，历史刷新错误写入插件日志，便于继续定位首次超时原因；不自动重发任务。

## 0.9.2 — 2026-10-04

- “查看总 Diff”直接打开 VS Code 原生多文件对比视图，使用本轮开始/结束的只读快照，支持新增、修改和删除文件。
- 保留各文件完整相对路径，区分不同目录中的同名文件；未保存完整文本的文件给出提示，不将其伪装成空文件。

## 0.9.1 — 2026-10-04

- 删除当前会话或清空历史后返回开始页，忽略已删除会话的迟到结果与错误；删除其他历史不影响当前任务。
- 每轮改动总结的空结果与范围说明默认折叠，展开“改动说明”后查看。
- 总 Diff 文档移除重复摘要和范围说明，显式使用 VS Code Diff 语言模式，改善补丁显示与增删行高亮。

## 0.9.0 — 2026-10-04

- 从 `ChatProvider` 拆出历史存储/轮询/删除协调与用量/价格统计协调，保留 UI 和 Agent 生命周期边界。
- 模型/thinking 改为账户目录 `preferences/{harness}.json` 持久原子保存，跨工作区的新建会话读取最近组合；Pi 桌面与 Telegram 共用服务端记录。恢复旧会话不覆盖默认，实际使用才更新；不迁移旧 workspaceState 偏好，不全局继承权限模式。

- 每轮输出末尾新增总 Diff 卡片：按工作区开始/结束内容汇总文件、文本增删行数、权限变化及补丁，支持打开总补丁和单文件编辑器对比。Pi 服务端、Codex/Claude 插件端均采集，取消/Agent 崩溃也保存结果；不修改 Git index，不重复计入轮前已有修改。
- 拆出任务队列、服务协议、工作区差异采集、文档预览和消息渲染；请求去重与收据合并到同一模块，服务操作不再嵌套决定调度。
- 删除旧草稿、插件 Pi 启动配置、已删除消息操作/Telegram 接管入口及原生空会话自动重建。只接受完整快照和带指纹的收据；不兼容数据报错保留，不迁移或自动清除。

- 会话 Socket 增加显式订阅、有界分块响应与背压处理；超过 16 MiB 的历史可正常读取，超大状态不再断开全部客户端。完整响应仍有 64 MiB 上限。
- 新建、原生分支和设置命令加入持久化去重；请求 ID 绑定方法/参数指纹，拒绝同 ID 异内容。收据、Telegram 游标和最终 outbox 同步文件与父目录。
- 清理旧 Telegram 双投递路径、桌面 remote 调用残留及任务完成后的冗余历史读取；统一 worker 创建与等待进程组退出的接口。
- 新旧 Socket 客户端不可混用；升级需一并更新并重启会话服务、Telegram 和插件。

## 0.8.2 — 2026-10-04

- 精简 README，突出功能、Pi 服务配置与 Telegram 接入和日常命令。

- 桌面任务的 Telegram 推送包含本轮用户输入；手机输入不重复转发，非文本附件显示提示。

## 0.8.1 — 2026-10-04

- 自动投递 `/notifications` 默认开启，保留显式关闭设置；新增独立 `/silent` 静音开关，默认关闭，控制完成通知、授权及操作回复的声音，预览和历史始终静音。

- `/sync` 自动创建话题并增量同步文字历史，重复执行可继续批量同步；补齐 `/help`，新增 `/commands` 别名。

- 移除 Pi 与 Telegram 的目录白名单，允许在当前账户可访问的任意目录运行；Telegram 工作区映射仅作为快捷别名，支持 `/new 绝对路径`。保留群组、用户及本机 socket 权限校验。

## 0.8.0 — 2026-10-04

**升级注意：** Pi 现在需要独立的 `pi-sessions.service`。请按 [会话服务部署说明](docs/session-service.md) 将原 Telegram 配置的启动命令、环境变量和并发设置迁移到 `sessions.json`，再更新 Telegram 服务和 VS Code 插件。已有历史与话题绑定保留；旧版待重建上下文记录不再自动转换。

- 修复常驻服务内存累积：任务收据改为磁盘按需读取，释放会话版本/取消缓存，解除原生历史回放闭包和已完成事务对大对象的引用。
- 慢磁盘保存合并为最新状态；通知积压逐文件读取，预览、授权票据、IPC 与 Telegram 请求队列增加总量和过期限制。
- 增加可选内存增长检查，覆盖收据加载、重复请求、连接回收和长文本预览。

- Pi 改为独立会话服务管理，VS Code 与 Telegram 共用执行入口、历史和授权；移除桌面接管与独立 Telegram 执行路径。
- 默认最多 3 个工作进程、空闲 15 分钟回收；关闭客户端不取消已提交任务，systemd 控制组兜底清理进程。
- 新增持久化任务收据、按会话队列、跨端取消和断线恢复；中断任务不自动重放。
- 新增 sessions.json、pi-sessions.service 和部署文档；Pi 启动设置从插件/Telegram 移到会话服务。

- 移除旧版上下文重建、摘要子进程和检查点缓存，以及历史自动迁移、自动补号、活动指针/偏好/缺失 harness 推断；不删除已有记录。
- Telegram 状态改为写盘成功后更新内存，避免通知收据、话题绑定和推送开关在磁盘失败时被误确认。
- 修复本地控制通道 UTF-8 分包损坏；增加控制请求响应超时、关闭后禁止新请求、发送缓冲限制与失败绑定重试。
- 隔离损坏通知文件，清理过期授权票据；更新架构、测试及部署/使用说明。

## 0.7.0

- 新增旧会话话题同步与分页历史导出，按已同步内容去重。
- 手机优先复用桌面 Pi 连接，支持排队、停止后发送、远程授权和切回桌面；控制断连不自动重发任务。
- 全局自动推送默认关闭，支持 Telegram 一键开关及状态持久化；配置部署与日常使用文档分离。

- 修复模型请求失败或重试耗尽后仍被内置适配器标记为成功的问题；保留失败状态，网页错误转换为简短网络诊断提示，下一轮成功请求不继承旧错误。
- 补充 systemd 常驻服务的 Pi 代理环境配置说明。

## 0.6.0

- 新增独立常驻 Telegram 服务：私人群组 Topics 对应 Pi 会话，支持手机对话、增量回复、完成通知、远程停止与 ACP 授权按钮。
- 使用群组、用户和工作区白名单，复用共享历史独占租约；持久化消息游标、话题绑定及完成通知队列，提供 systemd 部署示例。
- 桌面通知默认关闭，可独立启用；关闭历史保存时停止发布。内置适配器会话索引增加跨进程锁和原子写入，保护并发任务。

## 0.5.0

- 修复写入期间关闭本机历史保存误删共享记录的竞态；持久化队列与失效写入处理抽入独立模块。
- 修复原生分支期间源连接断开后误显示就绪；分支操作提供明确进度与取消入口。
- 消息与大型状态改用对象替换追踪变化，流式同步不再反复序列化旧图片与全部统计；统一模型/思考设置应用逻辑。
- 简化测试入口：`npm test` 按未提交改动运行，`npm run verify` 执行完整验证；保留 `test:all`，外部集成按需运行。打包去除重复构建，浏览器截图收敛到 `test-results/browser/`。

- Pi 分支改为原生会话树回溯，保留所选节点之前及本条的原生消息、图片、工具结果、压缩记录与历史设置，不再生成分支摘要或在下一条 prompt 注入重建文本。
- 验证节点映射、原生前缀和工具配对；无法可靠定位时禁用，不降级为摘要。隔离临时副本保护源文件，继承用量不重复统计；共享历史保留原会话并交接租约。
- 移除逐条消息删除，工具卡片仅复制；历史列表删除整条会话仍保留。兼容旧版待同步快照。
- 简化 Codex 选择器：隐藏 Fast mode（On/Off）和 Collaboration mode（Default/Plan），新建/恢复固定为 Off / Default，保留模型、思考强度和权限配置。
- 新增原生分支、共享租约、取消及 Codex 默认值测试；真实 Pi RPC 验证压缩前后分支和完整 ACP fork/load 链路，不调用模型。原生内容保持不等于保证缓存命中：新 Session ID 仍可能改变缓存路由。

## 0.4.1

- 修复 Codex / Claude 未发送消息的空会话释放后无法重连：仅在本地记录完整且为空、适配器明确返回原生 ID 不存在时重建空连接，保留编号和设置，不发送消息；已有内容及其他错误不自动重建或重放。
- 恢复失败的外部会话保留只读记录并释放租约，避免失败连接占用共享历史。
- 修复 `/` 命令菜单被输入区滚动容器裁剪；取消仅显示前 8 条的限制，支持异步命令更新、滚动、方向键、Enter / Tab 补全与 Escape 关闭。未连接或尚未收到命令时提供提示。
- 增加真实适配器空会话恢复测试脚本及宿主/浏览器回归；Codex ACP 2.1.1、Claude Agent ACP 0.85.1 的空会话恢复与命令通知通过验证，没有发送模型请求。

## 0.4.0

- 左上角增加 Pi Agent / Codex / Claude Code Harness 切换，Pi 保持默认完整支持，其他适配器通过标准 ACP 部分接入。
- 隔离各 harness 的启动命令、环境覆盖、模型偏好、草稿、附件与活动会话；保存历史标注所属 harness，使用独立 Session ID 命名空间避免碰撞。
- 切换保存并释放原会话，不自动创建或发送；目标已有历史先只读展示，缺少 session/load 的适配器不自动重放记录。
- 增加远端安装/登录提示，非 Pi 暂不开放上下文分支/删除及 Pi 专用统计，不声明未实现的 ACP 客户端能力。
- 新增 profile 与 ACP stdio 集成测试；真实 Codex/Claude 适配器在隔离目录完成初始化握手，未执行模型请求。

## 0.3.1

- 修复 VS Code Webview 默认 scrollbar-color 覆盖自定义滚动条的问题；强制使用透明轨道、6px 淡色滑块并隐藏箭头。
- 为持久化会话增加稳定编号，在历史列表与当前会话栏展示；同名分支分配不同编号，悬停可查看完整 Session ID。
- 旧历史自动补号，跨客户端统一分配；编号不随排序/重启改变，删除消息重建上下文保留原编号，删除历史后不复用旧号。
- 补充会话编号迁移/并发/分支测试，以及模拟 VS Code 注入样式、检查实际滚动条宽度的浏览器回归测试。

## 0.3.0

- 按对话轮次整体折叠工具调用、思考和中间说明，保留最终回答；支持单独展开和全局折叠开关。
- 默认使用服务器账户目录共享全部插件历史，自动迁移旧工作区记录，支持列表刷新、其他工作区只读查看及独占租约交接；删除共享历史需确认。
- 输入区改为拖动上方分界线调整高度，支持键盘调整与双击重置；滚动条改为透明轨道、淡色滑块，无箭头。
- 修复回复完成后设置保存失败导致 busy 卡死，以及预览等待保存时与发送/切换并发的问题。
- 串行化快照写入、删除和清空；关闭持久化使旧排队写入失效。删除历史同时清理统计标题，保留计费记录和价格。
- Webview 改用带序号的增量状态传输，未变化消息不重复序列化渲染；断序或重载后完整同步。
- 缓存未变化的原生用量日志解析结果，统计分页完成后批量合并持久化；限制 Diff 文档缓存并复用 URI。
- 移除 preparedContext 运行期与持久化副本，兼容旧快照；所有上游源码补丁强制唯一匹配。
- 补充并发、隐私、缓存、增量传输及浏览器同步回归测试。

## 0.2.2

- 新建会话继承上次活动会话的模型与 thinking；成功选择立即保存，重启后继续生效。先切换模型再读取其思考选项，兼容旧版 modes，去除重复设置。
- 打开插件恢复最后活动会话；无历史时显示显式“新建会话”入口。重连只恢复原 ID，失败不再隐式创建空白对话。
- 保留显式分支以及消息删除/待同步恢复所需的后台会话替换，维持原有上下文和统计语义。
- 新增贡献指南、架构/生命周期文档、测试与发布手册，补充会话恢复和偏好继承回归测试。

## 0.2.1

- Remove the Pi-reported cost column from statistics.
- Move pricing to a dedicated page with a four-field card for every configured model, including unused models.
- Cache up to two idle ACP connections in memory (32 MiB retained-record budget) for warm conversation switching; release on disposal, eviction, history removal or transport configuration changes.
- Support clipboard raster images with previews, removal, image-only messages, validated ACP image transport and local history persistence.
- Reject stale or oversized image pastes and keep drafts when the agent does not support image input.

## 0.2.0

- Bundle an enhanced, pinned Pi ACP adapter with negotiated usage and bounded-summary extension methods.
- Reuse valid native compaction checkpoints; invalidate affected summaries after edits and rebuild long retained histories in bounded, cancellable chunks.
- Persist full local conversation files without the former 2 MB snapshot truncation; copy the complete original Markdown independently of compaction.
- Render closed Mermaid fences locally with theme-aware SVG, source fallback and sanitization.
- Add model/day/conversation token and cost statistics, cache hit ratios, deduplicated native request usage, and editable USD per-million-token price presets.
- Preserve billed usage across message deletion; do not rebill inherited history when branching.

## 0.1.5

- Move history deletion to the right, use more compact rows with slightly larger text, and remove status indicator tooltips.
- Add copy, branch and delete actions to user/assistant messages and tool records.
- Reconstruct edited context in fresh ACP sessions, preserving retained history, text attachments and model/thinking configuration; send it with the next ordinary prompt.
- Discard stale compaction summaries after editing; preserve complete local transcripts when loading compacted sessions.
- Persist pending reconstruction, recover ambiguous send failures in a fresh session, and keep the original usable if preparing a replacement fails.
- Reject incomplete or unsupported history rather than silently changing only the display; serialize context edits with generation and connection changes.

## 0.1.4

- Unify hover and keyboard-focus descriptions in immediate, theme-aware tooltips.
- Add per-session history deletion without interrupting a running turn or restoring deleted records on save.
- Compact history spacing and limit the visible list to four scrollable rows.
- Show a spinning ring for active output and a static chat icon for other sessions; preserve list nodes and scroll position during streaming.

## 0.1.3

- Show context usage immediately in a theme-aware tooltip, without a help cursor.
- Center a circular scroll-to-latest button at the bottom of the message area.
- Connect automatically when the chat opens; show manual reconnect after failure.
- Add a dismiss button to error banners without hiding subsequent errors.

## 0.1.2

- Move model/thinking controls and a context usage ring into the composer.
- Show a short model name when collapsed and the full provider/model names in the native menu.
- Show token usage in k/k on ring hover; remove the footer advisory.
- Deduplicate reasoning controls across providers, including stale legacy modes after model switches.

## 0.1.1

- Remove sender labels and the connected status row to give messages more space.
- Remove login and log buttons from chat; keep the command palette actions.
- Show one thinking selector when Pi exposes the same levels via both modes and config options.
- Display concise thinking levels such as `low`, preserving the original ACP option values.

## 0.1.0

- ACP v1 stdio client with capability negotiation, streamed content, cancellation, permission requests and local session history.
- Sidebar chat, editor context attachments, session mode/configuration selectors, slash commands, tool cards and VS Code diff previews.
- Offline Markdown rendering with KaTeX, MathML, chemistry, code highlighting, tables, tasks and footnotes.
- Workspace Trust, strict Webview CSP, HTML sanitization and subprocess lifecycle management.
