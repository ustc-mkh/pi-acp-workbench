# Changelog

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
