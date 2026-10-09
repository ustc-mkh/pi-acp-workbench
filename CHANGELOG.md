# Changelog

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

- 新增 `npm run telegram:setup` 交互配置向导：隐藏 token、一次性配对、自动写入配置与用户级自启动，无需 sudo；首次配置无需指定项目目录，创建会话时可使用任意可访问的已有目录；重复配置备份、启动失败恢复，向导随服务发布包分发。

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
