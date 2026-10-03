# 架构与会话生命周期

## 进程和数据流

```text
VS Code 命令 / Webview 操作
           ↓ typed postMessage (src/shared.ts)
ChatProvider (src/extension.ts)
  ├─ ChatState ← applyUpdate (src/state.ts)
  ├─ SharedHistoryStore / SnapshotStore / workspaceState / SessionCache
  └─ AgentProcess (src/agent.ts)
           ↓ ACP v1 JSON-RPC / NDJSON stdio
      内置增强适配器，或外部 ACP Agent
           ↓
         Pi / 模型
```

Webview 不直接访问模型、磁盘或网络。宿主负责启动进程、校验操作、存储快照和权限回应；Webview 负责渲染和发送用户意图。更新合并后以约 40ms 防抖发送状态。`src/state-channel.ts` 在首次连接、会话切换或 Webview 重载时发送完整状态，其余发送字段和消息增量，避免重复传输历史图片及统计。前端保留未变化消息的对象身份；序号不连续时请求完整同步。当前宿主仍通过序列化比较变化，长历史虚拟列表和基于 revision 的变更追踪尚未实现。stderr 进入输出面板，stdout 只能承载 ACP 协议。

`AgentProcess` 用 SDK 管理请求/通知；初始化检查协议版本，默认初始化超时 20 秒，普通请求超时 30 秒。取消先发送 `session/cancel`，5 秒无响应则终止连接。POSIX 下清理整个进程组；Windows 使用对应进程树终止路径。关闭回调和 generation 标记共同阻止旧连接继续改写当前会话。

## Harness 边界

`src/harness.ts` 定义 Pi、Codex、Claude Code 三个 profile、启动配置和 Session ID 转换。Pi 配置保留旧键；另外两者使用 piAcp.codex.* / piAcp.claude.*，只在扩展宿主启动用户已安装的 ACP 适配器，不自动安装软件。

`AgentProcess.request()` 是带 sessionId 请求的统一边界：非 Pi 本地 ID 为 workbench:<harness>:<编码后的原生ID>，RPC 出站还原原生 ID，通知/权限入站加入命名空间。新 Pi ID 不允许占用保留前缀。完整快照与索引记录 harness，旧记录默认 Pi；丢失新字段的旧客户端记录仍可从非 Pi ID 命名空间识别。租约、编号与历史删除均使用本地 ID。不得在宿主绕过 request() 直接发送带本地 ID 的标准请求。

selectedHarness 按工作区持久化；非 Pi 的 activeSession / sessionPreferences 放在 harness.<id>.* 键下。切换先保存并等待统计请求，关闭当前与闲置连接、释放租约，再展示目标 profile 最近快照（只读）或欢迎页，不自动 initialize/new/prompt。草稿和附件按 harness 暂存，不跨提供商搬运。生成/连接/重建期间不允许切换。

Codex / Claude 第一阶段不开放上下文编辑，也不调用 _pi_workbench/*。标准选择器/图片/历史恢复按 initialize 声明及后续通知处理；缺少 loadSession 时只读展示，不把本地记录自动灌入新会话。不声明尚未实现的文件/终端委托、认证网关或子会话扩展。登录按钮启动本地终端，不接收或保存用户输入的凭据。

## 创建、恢复与活动会话

`ChatProvider.start()` 必须显式接收 `'new'` 或一个 Snapshot，不能用缺省参数意外创建会话。

| 用户操作 / 事件 | 行为 |
| --- | --- |
| 首次打开、没有历史 | 显示欢迎页面；不启动 Agent、不创建会话 |
| 打开已有工作区 | 自动恢复 `activeSession` 对应历史，至多尝试一次 |
| Webview 重载 / 重复 ready | 保留当前状态，不反复连接 |
| 顶部 +、欢迎页新建、Pi: New Session | 显式新建空会话并继承最近设置 |
| 点击历史 | 共享模式先取得会话锁再加载；占用中或工作区不同只读查看。本地模式优先复用缓存 |
| 释放会话 | 保存并断开 Agent、释放会话锁；另一客户端可重新连接接管 |
| 重新连接 | 恢复当前会话；没有当前会话时尝试上次活动历史；不自动降级为新建 |
| 恢复失败或不支持 session/load | 留下错误与原会话记录，等待重试或用户主动新建 |
| 分支 | 用户显式要求的新分支，包含所选记录之前及本条内容 |
| 删除消息 | 使用替换的后台 ACP 会话重建上下文；保留原逻辑对话的统计归属，不增加一个无关空白对话 |

旧版本没有活动指针时，首次迁移使用最近历史。`activeSession: null` 表示明确无可恢复活动历史，避免删除当前历史后重启又打开另一段对话。删除本地历史不会中断正在运行的 Agent。关闭历史持久化时，重启回到欢迎页，但当前运行内仍可重连活跃会话。

`transitioning`、status 和 generation 保护异步切换：busy/connecting 期间拒绝新建及切换，避免请求交错。加载前先保存旧会话；候选上下文重建失败则保留原会话。

### 模型与 thinking 继承

`src/session-settings.ts` 提供宿主和 UI 共用的选择器解析，识别 configOptions 的 model / thought_level、常见 thinking 名称及旧版 modes。已有 thinking config 时隐藏重复的旧 modes 控件。

成功的模型/思考选择立即保存 `sessionPreferences`，无需先发送消息；完成一轮后也捕获 Agent 更新的设置。恢复历史尊重该会话原有设置，并将其作为后续新建的默认组合。新建优先取当前会话组合，没有当前组合时取工作区保存的偏好（旧版可从历史快照迁移）。偏好不包含对话正文，关闭历史存储仍保留。

应用顺序必须是 **model → 重新读取 configOptions → thinking/mode**，因为模型切换可能改变选项集合。只保存值和控制类型，不把旧模型的选项列表当成新模型能力。选项不再提供时保留 Agent 当前默认值并显示明确提示，不无限重试。RPC 失败会报告错误，用户可重新新建；不会把未成功选择的值记为偏好。

## 存储与缓存

| 位置 / 键 | 用途 |
| --- | --- |
| ~/.pi/pi-acp-workbench/history/index.json | 默认共享模式：全部会话索引、删除 tombstone、nextSessionNumber 和逻辑会话编号映射 |
| ~/.pi/pi-acp-workbench/history/conversations | 带版本的完整快照，索引提交后清理上一版本；新目录/文件 POSIX 权限为 0700/0600 |
| workspaceState.history / storageUri/conversations | 本地模式：最近 20 个索引和快照；共享模式首次启动从这里迁移 |
| workspaceState.sharedHistoryMigrated | 当前工作区旧历史迁移标记；旧快照文件保留作备份 |
| workspaceState.activeSession | 最后活动的持久化会话 ID，null 表示无 |
| workspaceState.sessionPreferences | 最近使用的模型 / thinking / mode 值 |
| workspaceState.usageRecords / usageTitles | 已去重用量和逻辑对话标题 |
| workspaceState.prices | 用户覆盖单价 |
| SessionCache（仅内存） | 至多 2 个空闲连接，序列化记录预算 32 MiB，LRU 淘汰 |

共享历史由 `src/shared-history.ts` 管理：进程内事务队列配合 proper-lockfile 的跨进程索引锁，独立快照版本加原子索引替换防止并发写入互相覆盖。会话另有 30 秒 stale / 10 秒心跳的独占租约，持有者可以连接 ACP；其他窗口只读查看。写入还校验 revision，删除 tombstone 阻止旧写入与重复迁移复活已删记录。失去会话租约时终止本窗口 Agent。共享模式不保留空闲连接，切换、显式释放和扩展销毁时释放租约。列表每 5 秒刷新，显示其他客户端最近保存的快照；这不是实时流式协作。不同工作区的历史可以只读查看，启动 Agent 仍要求目录属于当前受信任工作区。

`persistHistory=false` 在共享模式下仅隐藏/停止保存，不删除服务器上的已有记录；删除/清空共享历史需要确认。模型偏好、统计和价格仍保持原来的 workspaceState 范围。`sharedHistory` 设置需要重载窗口才切换存储后端。

以下空闲缓存仅用于本地模式。当前活跃连接不计入空闲缓存。缓存存放进程、状态、工作目录、检查点等，切换命中不再 initialize/load；死亡缓存转冷加载。预算不代表整个 Pi 进程内存上限。扩展结束或 Webview 销毁时清空空闲缓存；修改启动配置使旧缓存失效。

快照写入、删除、清空及用量持久化通过 saveQueue 串行化；关闭历史保存会递增存储 epoch，使关闭前排队的快照即使在快速重新开启后也不能复活。forgottenSessions 防止正在执行的对话被从本地历史删除后，又因自动保存复活。删除历史会移除对应统计标题；清空历史或关闭持久化会清空所有统计标题，避免保留首条消息片段。被删除的活动会话不能通过后续用量刷新重建标题。上述操作不擦除 Pi 原生文件，不删除计费记录和价格。日志与本地快照可能含工作区代码，报告问题前应脱敏。

会话编号由 `src/session-numbers.ts` 按逻辑 conversationId 分配，分支获得新号，后台上下文替换保留旧号。共享模式在索引事务内分配/迁移，额外保留编号映射，以兼容旧客户端保存时丢掉快照内的新字段。本地模式使用 workspaceState.nextSessionNumber。编号与标题分开展示，不随历史排序改变；清空不重置计数器。未持久化会话显示完整 Session ID 作为后备标识。

## 上下文编辑和压缩

ACP v1 没有通用删除消息 API。本插件用新后台会话和首次 prompt 注入保留的历史来实现上下文编辑；界面记录和原始复制结果仍保留本地全文。新后台 ID 与统计所用 logical conversationId 必须区分。

1. 验证快照完整性、附件和用户选择的消息 ID。
2. 查找与保留前缀指纹匹配的有效压缩检查点。
3. 超预算时，以固定安全预算进行逐块摘要，不把全部长历史一次提交模型。摘要仅保存于检查点，不再额外维护 preparedContext 副本；旧快照中的该字段读取时忽略。
4. 候选 Agent 初始化、新建、恢复原设置成功后才切换。
5. 标记 contextPending；下一条普通消息携带准备好的历史，同步成功后清除标记。

删除摘要覆盖范围的内容会使该检查点失效；优先使用更早有效检查点，否则有界重建。摘要可取消，失败不静默丢弃记录。历史工具调用只成为文本上下文，不执行工具回放；不会提升为系统指令。待同步时禁止 slash 命令；首轮同步结果不确定时断开，重连时重建独立后台会话避免重复注入。这是恢复同一逻辑对话的内部替换，不是隐式创建一个用户可见空白对话。

当前保留历史中含图片时拒绝文本摘要重建；必须先移除相关消息。不要通过丢弃图片来“修复”此限制。

## 内置增强适配器

默认 command=pi-acp、空 args 且 useBundledAdapter=true 时，使用扩展 Node 运行时执行 dist/pi-adapter.mjs。构建基于固定上游 pi-acp 源码注入 `src/pi-enhancements.ts`，每个补丁都断言唯一匹配，位置缺失或重复时直接失败。用量日志解析结果按文件身份、大小和修改时间缓存，避免同一轮分页反复扫描；文件变化后重新解析。宿主收齐分页后一次合并和保存统计。

只有协商 agentCapabilities._meta['pi-workbench'].version=1 后，宿主才使用：

- `_pi_workbench/inspect`：分页读取真实 usage、模型价格、原生有效上下文和检查点。
- `_pi_workbench/summarize`：有界摘要工作进程，关闭工具/扩展/技能/模板/会话保存。
- `_pi_workbench/cancel_summary`：取消摘要。

这些是本项目扩展，不是标准 ACP 方法。外部 Agent 可只实现标准协议，此时普通聊天仍可用，详细消费统计和长历史自动摘要会受限。用量通过稳定请求 ID 去重，历史分支不能重复计费；上下文圆环与累计 token 消费是不同数据。

## 渲染与安全边界

`webview/transcript.ts` 按用户轮次将最后一次工具/思考之前的执行过程（含中间说明）放入一层 details，默认折叠，最终回答单独展示。流式更新复用分组与消息节点，保留用户展开状态，不改变底层记录。`composer-resize.ts` 用可键盘操作的 separator 和 pointer capture 调整输入高度，限制在视口范围内，并保存到 Webview UI 状态。滚动条统一采用透明轨道和淡色滑块。显式重置 html/body/后代的 scrollbar-color 和 scrollbar-width 为 auto，避免 VS Code 注入的标准属性压过 Chromium 的 WebKit 伪元素规则。

`webview/markdown.ts` 使用 Markdown token 规则隔离代码和公式，KaTeX trust=false，HTML 经 DOMPurify 净化。Mermaid 只渲染闭合围栏，strict 模式及 SVG 二次净化，禁止图内配置与远程图片。所有资源随包提供，无 CDN。

CSP 不允许 Webview 网络连接；只允许本地资源和 data: 图片预览。粘贴图片的格式、签名和体积在宿主重新检查。外部链接和本地文件打开经过协议、真实路径和工作区检查。

Diff 预览复用同一消息的文档 URI，并限制缓存为最近 20 对文档、16 MiB 总文本预算（至少保留当前一对）。

工作区信任限制宿主启动，ACP 授权卡片仅反映 Agent 的权限请求；Pi 自己的工具权限不由本扩展强制沙箱化。修改这条边界需要显式设计和文档，而非仅增加确认按钮。
