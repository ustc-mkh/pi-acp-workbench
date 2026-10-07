# 架构与会话生命周期

## 进程和数据流

```text
VS Code Webview → ChatProvider → RemoteAgent / TS SessionClient ─┐
                                                               ├─ Unix socket → Rust SessionService → Node pi-adapter → Pi
Telegram Bot → Rust Telegram relay / WireClient ─────────────────┘                    ├─ Rust shared history
                                                                                     └─ Durable Telegram outbox
Codex / Claude：ChatProvider → AgentProcess（保留本地运行方式）
```

Rust `pi-acp-session-daemon` 是唯一 Pi 进程所有者；`rust/crates/pi-acp-session-daemon/src/service.rs` 管理按会话串行队列、全局进程容量、空闲回收、授权和任务收据。扩展通过 `session-wire.ts` 的客户端使用账户私有 Unix socket、UTF-8 流式解码和有界缓冲；协议与磁盘格式的冻结规范见 [service-protocol.md](service-protocol.md) 与 [data-formats.md](data-formats.md)。两端提交请求后断线不会取消服务端执行；客户端不自动重发。重新连接读取完整当前状态，在线期间仅向会话订阅者广播 ACP 增量与生命周期状态。大响应分块传输并等待背压，完整响应上限 64 MiB；超限报告错误，不再断开所有客户端。

默认 3 个工作进程，空闲 15 分钟回收。容量满时排队，空闲进程优先淘汰；回收先终止进程组再释放槽位。新建短暂启动 Pi 取得原生 ID，查看已有历史不启动 Pi。进程组终止与 systemd 控制组兜底互补，详见 [运行与恢复边界](session-service.md)。

Webview 只处理渲染和用户意图，不直接访问模型或文件系统。宿主通过 `state-channel.ts` 向 Webview 发送有序增量，序号不连续时补全状态；模型任务与历史存储由服务管理。Codex / Claude 仍由插件持有进程。

## 职责拆分与合并

| 模块                                          | 单一职责                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------ |
| TS `session-protocol.ts` / Rust `protocol.rs` | TS 只定义客户端 DTO；服务命令与入口参数校验只由 Rust 实现                            |
| Rust `queue.rs`                               | 按会话顺序执行、全局并发限制和取消代际；不拥有进程或磁盘                             |
| Rust `journal.rs`                             | 合并收据读写、请求指纹和进行中去重；持久化命令只有一个执行入口                       |
| Rust `service.rs`                             | 工作进程/租约、会话状态、prompt 与原生分支；路由处决定调度，不在操作中重复入队       |
| `workspace-diff.ts` / `turn-diff.ts`          | 后端工作区前后采集，与纯数据类型/汇总格式化分离，浏览器不引入 Node 文件系统          |
| `workspace-documents.ts`                      | 合并工具 Diff、本轮总 Diff 的虚拟文档缓存，并集中本地链接的真实路径校验              |
| `webview/messages.ts`                         | 消息与本轮 Diff 卡片渲染；`main.ts` 只编排页面，`transcript.ts` 只负责分组和节点复用 |
| `atomic-json.ts`                              | 扩展共享历史/偏好的原子写入；Rust 收据/outbox 使用 core 的 atomic.rs                 |
| `conversation-history.ts`                     | 历史索引、轮询、串行保存/删除、失效代际与租约释放；不拥有 Agent                      |
| `conversation-statistics.ts`                  | 用量分页/去重/归属、价格、标题与统计状态；丢弃已切换会话的迟到结果                   |
| `session-preferences.ts`                      | 账户级模型/thinking 组合的校验与持久原子保存                                         |

继续保持独立的边界：`session-settings` 是纯选择器解析，`session-configuration` 是 ACP 设置应用；本地 `AgentProcess` 与服务客户端 `RemoteAgent` 生命周期不同，不应合并。共享索引事务锁与会话租约保护的对象不同，也不能为了减少模块而合并。

`ChatProvider` 仍负责 UI 意图、Agent 生命周期、会话切换与快照组装；历史和统计协调交给独立模块，通过当前状态/通知回调衔接，不引入新的全局 store。暂不拆分很短的 `session-cache`、`session-numbers`，也不把不同职责的小模块机械拼接。

## 当前格式边界

只读取当前完整快照（明确 harness、`contextComplete=true`；共享版本记录必须有 revision）和带 fingerprint 的请求收据。缺失字段或不兼容数据拒绝读取/执行，原文件保留，不做补字段、迁移、原生回放重建或静默删除。没有旧 UI 的 draft 字段、deleteMessage 入口、Telegram 接管命令或插件端 Pi 启动配置。

## Harness 边界

`src/harness.ts` 定义 Pi、Codex、Claude Code 三个 profile、启动配置和 Session ID 转换。Pi 使用独立 sessions.json；另外两者使用 piAcp.codex._ / piAcp.claude._，只在扩展宿主启动用户已安装的 ACP 适配器，不自动安装软件。

`AgentProcess.request()` 是带 sessionId 请求的统一边界：非 Pi 本地 ID 为 workbench:<harness>:<编码后的原生ID>，RPC 出站还原原生 ID，通知/权限入站加入命名空间。新 Pi ID 不允许占用保留前缀。完整快照与索引必须显式记录 harness；缺失或不匹配时拒绝恢复，不从 ID 推断缺失元数据。租约、编号与历史删除均使用本地 ID。不得在宿主绕过 request() 直接发送带本地 ID 的标准请求。

Codex 的 fast-mode 和 collaboration_mode 选择器隐藏，创建/恢复时通过标准 set_config_option 固定为 off/default；拒绝旧 UI 修改这两个配置，偏好保存也排除它们。其他模型、思考和权限配置照常，Pi/Claude 不应用这些覆盖。

selectedHarness 按工作区持久化；非 Pi 的 activeSession 放在 harness.<id>.\* 键下。模型/thinking 偏好独立保存在账户目录，不再读写 workspaceState.sessionPreferences 或 harness.<id>.sessionPreferences。切换先保存并等待统计请求，关闭当前与闲置连接、释放租约，再展示目标 profile 最近快照（只读）或欢迎页，不自动 initialize/new/prompt。草稿和附件按 harness 暂存，不跨提供商搬运。生成/连接/分支期间不允许切换。

恢复一律请求 session/load，错误原样报告并保留本地记录；即使是空会话也不会自动 session/new 或替换 ID。用户明确新建才创建会话。没有针对供应商特定缺失错误码的重建分支。

SlashCommands 将菜单挂载到 Webview body，以 fixed 定位绕过 footer 的 overflow:auto 裁剪；内容始终来自当前会话 available_commands_update，不硬编码 CLI 命令。键盘补全会阻止默认 Enter 发送。

Codex / Claude 第一阶段不开放上下文编辑，也不调用 \_pi_workbench/\*。标准选择器/图片/历史恢复按 initialize 声明及后续通知处理；缺少 loadSession 时只读展示，不把本地记录自动灌入新会话。不声明尚未实现的文件/终端委托、认证网关或子会话扩展。登录按钮启动本地终端，不接收或保存用户输入的凭据。

## 创建、恢复与活动会话

`ChatProvider.start()` 必须显式接收 `'new'` 或一个 Snapshot，不能用缺省参数意外创建会话。

| 用户操作 / 事件                     | 行为                                                             |
| ----------------------------------- | ---------------------------------------------------------------- |
| 首次打开、没有历史                  | 显示欢迎页面；不启动 Agent、不创建会话                           |
| 打开已有工作区                      | 自动恢复 `activeSession` 对应历史，至多尝试一次                  |
| Webview 重载 / 重复 ready           | 保留当前状态，不反复连接                                         |
| 顶部 +、欢迎页新建、Pi: New Session | 显式新建空会话并继承最近设置                                     |
| 点击历史                            | Pi 读取服务当前状态；其他 harness 先取得锁再加载；其他工作区只读 |
| 释放会话                            | Pi 仅断开客户端，任务继续；其他 harness 保存并断开 Agent、释放锁 |
| 重新连接                            | 恢复当前会话；没有当前会话时尝试上次活动历史；不自动降级为新建   |
| 恢复失败或不支持 session/load       | 留下错误与原会话记录，等待重试或用户主动新建                     |
| 分支                                | 用户显式要求的新分支，包含所选记录之前及本条内容                 |

只有明确的活动指针才会触发自动恢复；缺失时保持欢迎页。`activeSession: null` 表示明确无可恢复活动历史，避免删除当前历史后重启又打开另一段对话。删除本地历史不会中断正在运行的 Agent。关闭历史持久化时，重启回到欢迎页，但当前运行内仍可重连活跃会话。

`transitioning`、status 和 generation 保护异步切换：busy/connecting 期间拒绝新建及切换，避免请求交错。加载前先保存旧会话；候选上下文重建失败则保留原会话。

### 模型与 thinking 继承

`src/session-configuration.ts` 统一新会话偏好的验证与 RPC 应用，不可用时提示；每次模型切换后重新读取选项。恢复已有会话直接使用后端加载的设置，不建立替代会话来恢复设置。`src/session-settings.ts` 提供宿主和 UI 共用的选择器解析，识别 configOptions 的 model / thought_level、常见 thinking 名称及ACP modes。已有 thinking config 时隐藏重复的 modes 控件。

`session-preferences.ts` 将最近成功使用的组合保存到固定位置 `~/.pi/pi-acp-workbench/preferences/{pi,codex,claude}.json`，同账户跨工作区共享、按 harness 隔离。新建每次从磁盘读取，成功选择立即保存（无需发送消息），发送前记录当前组合；轮内 Agent 改变设置时再保存，普通长任务完成不会覆盖其他窗口后来选择的组合。新建成功时记录实际组合；若保存值不可用则提示且保留原偏好。恢复/浏览旧会话或原生分支保留该会话自身设置，不改账户默认；在其中实际发送或修改设置后才更新默认。

Pi 由会话服务独占偏好读写，桌面和 Telegram 因而使用同一组合；自定义 `--data-dir` 时 Pi 偏好位于该目录的 `preferences/pi.json`。Codex/Claude 由扩展宿主写固定账户目录。每个文件含 `version:1`，原子替换并 fsync，文件权限 0600；并发写入以最后完成的整组写入为准，不混拼 model/thinking。只保存模型与思考值，不全局继承权限/协作模式，不包含正文。关闭/删除历史不清除此文件。旧 workspaceState 偏好不自动迁移；损坏或未知版本拒绝读取/覆盖，保留原文件。

应用顺序必须是 **model → 重新读取 configOptions → thinking**，因为模型切换可能改变选项集合。只保存值和控制类型，不把旧模型的选项列表当成新模型能力。选项不再提供时保留 Agent 当前默认值并显示明确提示，不无限重试。RPC 失败会报告错误，用户可重新新建；不会把未成功选择的值记为偏好。

## 存储与缓存

| 位置 / 键                                         | 用途                                                                         |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| ~/.pi/pi-acp-workbench/history/index.json         | 默认共享模式：全部会话索引、删除 tombstone、nextSessionNumber                |
| ~/.pi/pi-acp-workbench/history/conversations      | 带版本的完整快照，索引提交后清理上一版本；新目录/文件 POSIX 权限为 0700/0600 |
| workspaceState.history / storageUri/conversations | 本地模式：最近 20 个索引和快照；仅用于 Codex / Claude 本地模式               |
| workspaceState.activeSession                      | 最后活动的持久化会话 ID，null 表示无                                         |
| ~/.pi/pi-acp-workbench/preferences/{harness}.json | 跨工作区共享的最近模型/thinking 组合                                         |
| workspaceState.usageRecords / usageTitles         | 已去重用量和逻辑对话标题                                                     |
| workspaceState.prices                             | 用户覆盖单价                                                                 |
| SessionCache（仅内存）                            | 至多 2 个空闲连接，序列化记录预算 32 MiB，LRU 淘汰                           |

共享历史由 `src/shared-history.ts` 的索引事务锁、会话租约、revision 和删除 tombstone 保护。Pi 只由服务写入，插件通过请求读取/删除；服务失去租约则终止对应进程。Codex / Claude 仍由插件持锁，其他窗口只读。Pi 的多客户端同步来自服务推送，不依赖历史轮询。

Pi 的 `persistHistory=false` 只隐藏列表，服务继续保存任务。其他 harness 在共享模式下仅隐藏/停止本客户端保存，不删除服务器上的已有记录；删除/清空共享历史需要确认。模型偏好使用独立账户文件；统计和价格仍保持 workspaceState 范围。`sharedHistory` 设置需要重载窗口才切换存储后端。

以下插件空闲缓存仅用于 Codex / Claude 本地模式。当前活跃连接不计入空闲缓存。缓存存放进程、状态、工作目录及设置等，切换命中不再 initialize/load；死亡缓存转冷加载。预算不代表 Agent 进程内存上限。扩展结束或 Webview 销毁时清空空闲缓存；修改启动配置使旧缓存失效。

快照写入、删除、清空及用量持久化通过 `src/history-persistence.ts` 的队列串行化；关闭历史保存会递增存储 epoch，使关闭前排队的快照即使在快速重新开启后也不能回到本机列表。已完成的本地失效写入会清理；共享写入一旦提交则保留，关闭本机保存不能调用共享删除或写入 tombstone。forgottenSessions 防止正在执行的对话被从本地历史删除后，又因自动保存复活。删除历史会移除对应统计标题；清空历史或关闭持久化会清空所有统计标题，避免保留首条消息片段。被删除的活动会话不能通过后续用量刷新重建标题。上述操作不擦除 Pi 原生文件，不删除计费记录和价格。日志与本地快照可能含工作区代码，报告问题前应脱敏。

会话编号由 `src/session-numbers.ts` 按逻辑 conversationId 分配，分支获得新号；恢复时保留原 ID 和编号，不自动创建替代空会话。共享模式在写入事务内分配，本地模式使用 workspaceState.nextSessionNumber；清空不重置计数器。已删除逐次读索引时的补号迁移及冗余 sessionNumbers 映射，读取不写磁盘。未持久化会话显示完整 Session ID。

不导入其他存储后端的历史，不从最近历史猜测活动指针或模型偏好。存储模式可显式选择，但不会搬运记录。标准 ACP modes 与可选能力协商仍保留，它们是协议功能，不是历史版本兼容层。

## 原生上下文分支

逐条消息删除的消息类型、处理分支、样式和专用测试均已删除。Pi 分支不再使用 `session/new` + 文本摘要注入，而通过 `_pi_workbench/fork` 保存原生会话路径，再用 `session/load` 加载。Codex/Claude 不调用该私有扩展。

1. `src/native-branch.ts` 验证原生 parent 链、消息内容指纹、工具调用/结果配对及 compaction/context_edit 边界。显示消息通过唯一内容匹配、时间戳或已验证映射定位；歧义、孤立结果、未完成工具调用等失败关闭。
2. `_pi_workbench/inspect` 返回 forkPoints；完整快照保存 nativeForks（显示 ID → 原生 ID/前缀 SHA-256），轻量索引不保存这些字段。流式 assistant/thought 更新携带原生时间戳 messageId，避免重复文本误定位。
3. 原生操作先复制源文件到私有临时目录，避免 Pi 启动迁移/设置回退改写源文件。隔离 RPC worker 仅加载 `dist/pi-native-fork.mjs`，通过 `ctx.fork(entryId,{position:'at'})` 创建独立原生会话；禁止该 worker 自动 cache warming。
4. 再次验证原生前缀并写入不进入模型上下文的 `pi-acp-workbench/native-fork` 元数据。规范化仅忽略 parent 链重接、labels 及其 compaction 边界映射；消息/图片/压缩记录必须保持一致。worker 退出后将新文件 header 的 parentSession 关联回真实源文件，再登记到 adapter store。
5. 候选 Agent 加载成功后才切换并释放旧共享租约。准备期间使用 `contextOperation.kind=fork` 展示进度和取消入口；失败回滚根据源 Agent 的实际存活状态恢复 ready/disconnected，不覆盖已经失去的租约状态。使用分支时的模型/思考设置，不覆盖为源会话当前偏好；下一条 prompt 只含新输入。继承的旧 usage 在标记处清零，之后的新请求正常累计。原文件和原会话历史保留。

这避免了新增摘要请求与人为内容改写，但不是缓存命中保证：新 Session ID 可能改变 provider 的缓存路由（openai-codex 的 prompt_cache_key 派生自 sessionId），还受系统提示、模型和有效期影响。不会回滚工作区文件或重新执行工具。

文本种子重放、有界摘要工作进程及前缀检查点缓存已删除；没有第二套上下文重建路径。原生压缩记录仍由 Pi 保留。

## 每轮工作区总 Diff

每次实际 prompt 前由执行所有者建立基线：Pi 在服务端采集，Codex / Claude 在插件宿主采集；RemoteAgent 不重复采集。结束、取消或进程失败后记录开始/结束的净变化，追加 `role=diff` 的 UI 元数据。卡片始终在本轮末尾、折叠的执行过程之外；同一文件反复编辑只显示一份最终差异。快照保留文本对比，重新加载不重新计算，原生分支也不把这些内容灌入模型上下文。

采集使用只读 `git ls-files` 枚举会话工作目录下已跟踪和未忽略的未跟踪文件，按前后内容生成差异；不以 HEAD 为基线，不修改用户 index、工作树或 Git 历史。受限文本临时副本仅供 `git diff --no-index --no-ext-diff --no-textconv` 比较。子目录工作区不越界；目录符号链接不跟随到工作区外。权限变化单独列出，重命名显示为删除/新增。

完整规则与限制见 [每轮修改汇总](turn-diff.md)。所有文件的历史文本统一由 `workspace-documents` 打开虚拟文档，不能把未知路径直接交给宿主读取。Telegram 最终通知包含文件/行数汇总，不自动发送完整补丁。

## 内置增强适配器

Pi 服务默认用 Node 执行 dist/pi-adapter.mjs。构建基于固定上游 pi-acp 源码注入 `src/pi-enhancements.ts`，每个补丁都断言唯一匹配，位置缺失或重复时直接失败。用量日志解析结果按文件身份、大小和修改时间缓存，避免同一轮分页反复扫描；文件变化后重新解析。宿主收齐分页后一次合并和保存统计。

只有协商 agentCapabilities.\_meta['pi-workbench'].version=1 后，宿主才使用：

- `_pi_workbench/inspect`：分页读取真实 usage、模型价格、原生有效上下文和 forkPoints。
- `_pi_workbench/fork` / `cancel_fork`：原生分支及取消，需额外协商 `nativeFork=true`。

这些是本项目扩展，不是标准 ACP 方法。外部 Agent 可只实现标准协议，此时普通聊天仍可用，详细消费统计和原生分支仅在声明相应能力时提供。用量通过稳定请求 ID 去重，历史分支不能重复计费；上下文圆环与累计 token 消费是不同数据。

## Telegram 常驻服务

Rust `pi-acp-telegram-daemon` 只管理 Bot 长轮询与 Telegram 权限边界，其 `sessions.rs` 是会话服务客户端，不启动 Pi 进程。生产服务只保留 Rust 入口，参数与既有磁盘格式兼容，见文末「Rust 常驻进程」。删除原有 desktop-control 与 telegram-routing 分支。服务统一发布任务进度和完成 outbox，即使插件或 Telegram 离线也可保存结果。客户端旧的完成投递分支已删除，Telegram run 只等待任务状态，不再读取整段历史拼接一个随后被丢弃的回复。

`telegram-stream.ts` 合并消息，`telegram-api.ts` 节流并处理限流。游标先持久化再分发；发送、新建、分支和设置命令使用带方法/参数指纹的持久化 ID 收据，拒绝 ID 异内容复用，重启后未完成请求标记中断而不重放。关键收据、游标和最终 outbox 经通用 atomic-json 工具同步文件与父目录后才报告成功，周期进度仍使用普通原子替换。绑定、通知收据、推送开关持久化成功后才更新内存。通知发送与落盘不是分布式事务，因此崩溃边界可能重复通知，但不能重跑任务。

## 渲染与安全边界

`webview/transcript.ts` 按用户轮次将最后一次工具/思考之前的执行过程（含中间说明）放入一层 details，默认折叠，最终回答单独展示。流式更新复用分组与消息节点，保留用户展开状态，不改变底层记录。`composer-resize.ts` 用可键盘操作的 separator 和 pointer capture 调整输入高度，限制在视口范围内，并保存到 Webview UI 状态。滚动条统一采用透明轨道和淡色滑块。显式重置 html/body/后代的 scrollbar-color 和 scrollbar-width 为 auto，避免 VS Code 注入的标准属性压过 Chromium 的 WebKit 伪元素规则。

`webview/markdown.ts` 使用 Markdown token 规则隔离代码和公式，KaTeX trust=false，HTML 经 DOMPurify 净化。Mermaid 只渲染闭合围栏，strict 模式及 SVG 二次净化，禁止图内配置与远程图片。所有资源随包提供，无 CDN。

CSP 不允许 Webview 网络连接；只允许本地资源和 data: 图片预览。粘贴图片的格式、签名和体积在宿主重新检查。外部链接和本地文件打开经过协议、真实路径和工作区检查。

Diff 预览复用同一消息的文档 URI，并限制缓存为最近 20 对文档、16 MiB 总文本预算（至少保留当前一对）。

工作区信任限制宿主启动，ACP 授权卡片仅反映 Agent 的权限请求；Pi 自己的工具权限不由本扩展强制沙箱化。修改这条边界需要显式设计和文档，而非仅增加确认按钮。

## 故障边界与维护约束

- 控制 socket 使用流式 UTF-8 解码，避免中文跨数据包损坏；服务不可用时明确报错，禁止回退启动 Agent。普通控制调用默认 30 秒等待，长任务不设客户端执行期限；断线不重放。关闭客户端后拒绝新请求，服务端限制待发送缓冲。
- 通知成功发送而收据写盘失败时保留 outbox，重试可能重复通知，但不会重跑任务。无效 outbox JSON 不应阻塞其他合法事件；保留原文件供诊断并按既有保留期清理。
- 共享快照用 revision 检查更新冲突，会话锁与索引事务锁承担不同职责；不要为了简化而合并或绕过。
- 改动底层能力后运行 `npm run verify`；涉及 Pi 原生树接口时额外运行 `npm run test:native-fork`。这些验证不要求真实模型请求。

## Rust 常驻进程

生产服务入口与构建仅使用 `rust/` workspace。行为按 [service-protocol.md](service-protocol.md) 与 [data-formats.md](data-formats.md) 的契约验证（`npm run test:contract` / `npm run test:contract:telegram`）；`npm run test:integration:rust` 连接两个真实 Rust 服务，只有 Bot HTTP 与 ACP worker 使用 mock。TS 会话服务、队列、收据和 socket 服务端已经删除；仅旧 Telegram 内部模块暂留供故障测试迁移，见 [迁移进度](rust-migration.md)。严禁新旧版本共用同一 `--data-dir` 并行运行。

| crate                    | 对应 TS                                                                 | 职责                                                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `pi-acp-session-daemon`  | session-daemon / session-service / session-wire 服务端等                | wire 服务端、命令校验、TaskQueue、RequestJournal、共享历史、偏好、outbox 发布、workspace-diff、native-branch 哈希、ACP client 子集、进程组管理 |
| `pi-acp-telegram-daemon` | telegram-daemon / telegram-bridge / telegram-stream / telegram-sessions | Bot 长轮询、话题绑定、outbox 消费、节流发送                                                                                                    |
| `pi-acp-core`            | session-wire 客户端 / atomic-json / 锁                                  | wire 客户端、原子写、proper-lockfile 兼容 mkdir 锁、UTF-16/canonical 序列化                                                                    |

Webview、扩展宿主与 `pi-adapter.mjs` 永远保持 JS/TS：渲染生态与 Pi 进程内扩展机制没有 Rust 通道；Rust daemon 只是 spawn `node pi-adapter.mjs` 作为工作进程。动机仅为常驻内存（Node ~60–100 MB → Rust ~5–9 MB RSS）与单二进制部署。

跨实现最易漂移的三点（规范已逐条固化）：mkdir 锁必须兼容 proper-lockfile 的心跳/stale/compromised 语义（禁止 flock）；分块响应按 UTF-16 code unit 切片、可切断代理对；收据指纹与 fork 哈希的 canonical JSON 按 UTF-16 序排键。部署与旧版本切换见 [session-service.md](session-service.md)。
