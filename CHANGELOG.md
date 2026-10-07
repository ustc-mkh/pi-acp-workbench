# Changelog

## Unreleased

- Rust relay 覆盖迁移：Telegram 黑盒契约扩展至 23 项，覆盖磁盘游标失败、投递/history 重试、真实排队取消、静音切换、权限隔离、Unicode/429 和 webhook 边界；新增事务/清理/队列与慢盘 outbox Rust 单测，删除已迁移的两个 TS 长运行参考用例。
- Rust relay outbox 改为惰性逐条读取，避免一次性加载整个积压；在实际读取阶段强制文件大小上限，而不只检查 metadata。

- Rust 收敛第二阶段：删除 TS 会话服务、队列、收据、socket 服务端和服务端命令校验；TS 只保留协议客户端/DTO。会话、原生分支、偏好、Diff 和存储失败回归直接启动 Rust 服务，不再依赖 TS 内嵌实现。
- 补 Rust 收据落盘后取消、写失败不执行、队列溢出、响应隔离及连接/请求资源回收测试；故障注入仅 cfg(test)。内存检查改为真实 Rust RSS/FD/worker 浸泡，CI 执行；Rust 预览缓冲测试覆盖大源文本、Unicode 和过量容量小字符串。

- 开始 Rust 契约单实现迁移：删除 TS daemon 入口及生产构建，npm/systemd 默认只运行 Rust；新增独立 `build:services` 产物与 SHA-256 清单，旧 TS 内部故障测试暂留待覆盖迁移，不宣称已完成源码淘汰。
- 桌面真实 RemoteAgent 测试改接 Rust；新增两个真实 Rust daemon 的授权/取消/离线 outbox 集成及 queue/journal 故障回归。
- 修复 Rust Telegram 重启时错误要求可选 `historySent` 存在，保留非法类型拒绝和游标防重放校验。

- Mermaid 改为本地 ESM 分块按需加载；首次出现流程图才加载渲染引擎，保留 SVG 净化与错误源码回退。构建前清理旧分块，浏览器冒烟覆盖模块加载与 CSP；VSIX 改为显式产物白名单，避免 `!dist/**` 覆盖 source map 排除规则。
- TS / Rust 会话 socket 在私有目录中绑定并设置 0600 后原子发布，消除 bind 与 chmod 间的公开权限窗口；失败清理临时 socket，不修改全进程 umask。
- 全库采用 Prettier + rustfmt，新增格式化命令、编辑器约定和 CI 检查；字节级 fixtures、锁文件及生成产物不格式化。

- 修复协议 v2 委托历史写入的版本基线：只用本窗口读写的 revision，轮询不推进；远程写成功同步版本，降级文件写不再误报冲突。
- 未知服务方法增加稳定错误码 `unknown_method`；启动 hello 失败后自动重试。清空共享历史确认明确提示会停止 Telegram 在内的所有任务。
- Telegram 新增可选 `restrictToWorkspaces`（真实路径匹配工作区根）；生产构建移除传输环境变量钩子，测试通过显式注入或隔离 Rust feature 使用模拟 API。
- 压缩 Webview bundle，VSIX 排除 source map；根忽略列表显式排除 `rust/target/`；新增 TS/Rust 单元和双实现契约 CI。

- 依赖安全修复：通过 npm overrides 将 mermaid 传递依赖的 katex 统一为 0.19.0，消除原型链污染漏洞（GHSA-238p-pmpm-9mq7）。
- 工作进程退出后 `stop()` 立即返回，不再固定等待 1.5 秒 SIGKILL 兜底计时器；空闲回收、原生分支与批量关闭更快。
- 会话 Socket 按行解析不再对剩余缓冲做逐行 Buffer 往返，单数据块多行时从 O(n²) 降为 O(n)，同时保留残留字符串对源数据块的释放。
- `RemoteAgent` 超时操作现在释放服务请求槽位，避免服务长期运行时 pending 上限（128）被耗尽的慢泄漏。
- 会话服务启动时清理超过 30 天的已完成/中断任务收据与会话标记，避免收据目录无限增长拖慢恢复扫描。
- Telegram 绑定文件在守护进程启动时移除已删除会话的话题绑定，避免 topics 列表只增不减；会话服务暂不可用时跳过清理保留绑定。
- 打包脚本版本号改由 `npm_package_version` 注入，不再随版本升级过时。
- 会话服务 wire 协议与磁盘格式固化为规范文档（docs/service-protocol.md、docs/data-formats.md）；新增 `npm run test:contract` 黑盒契约测试（19 项），只通过 socket 验证实现，可用于未来的替代实现。
- `scripts/export-fixtures.mjs` 导出 native-branch 哈希/绑定 fixtures 与磁盘格式 golden 样例（test/fixtures/），为替代实现提供逐比特断言目标；Rust 双实现见 docs/architecture.md。
- 新增 Rust 版 Telegram relay（`rust/` workspace，Phase 1）：`pi-acp-core` 共享库（socket wire client、原子写、proper-lockfile 兼容 mkdir 锁、UTF-16 切分）+ `pi-acp-telegram-daemon` 单二进制，与 Node 实现参数/格式完全兼容，systemd 改 `ExecStart` 即切换；空闲 RSS ~5 MB。`npm run test:contract:telegram` 用模拟 Bot API 与模拟会话服务验证 9 项 contract，同一套件对 Rust 与 TS 实现均通过（`PI_TG_DAEMON` 切换）。模拟 API 钩子现已移至独立测试入口 / Rust `contract-test` feature，不影响生产构建。
- 会话服务协议升至 v2（Phase 3）：新增 `historyWrite`/`historyRemove` 命令，扩展端共享历史写路径可委托给 daemon（`hello` 宣告 `history` 能力时启用，旧版 daemon 透明回退文件写）；租约语义见 docs/service-protocol.md §4。契约测试增至 22 项，对 TS 与 Rust 双实现全过。
- 新增 Rust 版会话服务 daemon（Phase 2）：`pi-acp-session-daemon` 单二进制（release ~3.2 MB，空闲 RSS ~9 MB vs Node ~79 MB），实现 wire 服务端（分块/背压/订阅路由/全部限制）、serviceCommand 校验、TaskQueue、RequestJournal（幂等/中断恢复/30 天清理）、SharedHistoryStore（乐观锁/租约/编号分配）、SessionPreferences、Telegram outbox 发布、workspace-diff/turn-diff、native-branch 哈希、ACP v1 客户端子集与进程组管理（setsid+killpg）。`PI_CONTRACT_DAEMON` 对同一 19 项 contract 全过；`sessions.json` 缺省 `command` 时按 `PI_ADAPTER` 环境变量或可执行文件旁边的 `pi-adapter.mjs` 解析 worker（Node 版默认 `process.execPath`）。部署与已知差异见 docs/session-service.md「Rust daemon」小节。

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
