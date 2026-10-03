# 架构与会话生命周期

## 进程和数据流

```text
VS Code 命令 / Webview 操作
           ↓ typed postMessage (src/shared.ts)
ChatProvider (src/extension.ts)
  ├─ ChatState ← applyUpdate (src/state.ts)
  ├─ SnapshotStore / workspaceState / SessionCache
  └─ AgentProcess (src/agent.ts)
           ↓ ACP v1 JSON-RPC / NDJSON stdio
      内置增强适配器，或外部 ACP Agent
           ↓
         Pi / 模型
```

Webview 不直接访问模型、磁盘或网络。宿主负责启动进程、校验操作、存储快照和权限回应；Webview 负责渲染和发送用户意图。更新合并后以约 40ms 防抖发送状态。stderr 进入输出面板，stdout 只能承载 ACP 协议。

`AgentProcess` 用 SDK 管理请求/通知；初始化检查协议版本，默认初始化超时 20 秒，普通请求超时 30 秒。取消先发送 `session/cancel`，5 秒无响应则终止连接。POSIX 下清理整个进程组；Windows 使用对应进程树终止路径。关闭回调和 generation 标记共同阻止旧连接继续改写当前会话。

## 创建、恢复与活动会话

`ChatProvider.start()` 必须显式接收 `'new'` 或一个 Snapshot，不能用缺省参数意外创建会话。

| 用户操作 / 事件 | 行为 |
| --- | --- |
| 首次打开、没有历史 | 显示欢迎页面；不启动 Agent、不创建会话 |
| 打开已有工作区 | 自动恢复 `activeSession` 对应历史，至多尝试一次 |
| Webview 重载 / 重复 ready | 保留当前状态，不反复连接 |
| 顶部 +、欢迎页新建、Pi: New Session | 显式新建空会话并继承最近设置 |
| 点击历史 | 优先复用缓存，否则加载同一 session ID |
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
| workspaceState.history | 最近 20 个快照索引；兼容旧版内嵌 entries |
| storageUri/conversations | 完整 JSON 快照，包含消息、图片、检查点、待同步标记、设置 |
| workspaceState.activeSession | 最后活动的持久化会话 ID，null 表示无 |
| workspaceState.sessionPreferences | 最近使用的模型 / thinking / mode 值 |
| workspaceState.usageRecords / usageTitles | 已去重用量和逻辑对话标题 |
| workspaceState.prices | 用户覆盖单价 |
| SessionCache（仅内存） | 至多 2 个空闲连接，序列化记录预算 32 MiB，LRU 淘汰 |

当前活跃连接不计入空闲缓存。缓存存放进程、状态、工作目录、检查点等，切换命中不再 initialize/load；死亡缓存转冷加载。预算不代表整个 Pi 进程内存上限。扩展结束或 Webview 销毁时清空空闲缓存；修改启动配置使旧缓存失效。

快照写入通过 saveQueue 串行化。forgottenSessions 防止正在执行的对话被从本地历史删除后，又因自动保存复活。删除/清空历史不擦除 Pi 原生文件，不删除统计和价格。日志与本地快照可能含工作区代码，报告问题前应脱敏。

## 上下文编辑和压缩

ACP v1 没有通用删除消息 API。本插件用新后台会话和首次 prompt 注入保留的历史来实现上下文编辑；界面记录和原始复制结果仍保留本地全文。新后台 ID 与统计所用 logical conversationId 必须区分。

1. 验证快照完整性、附件和用户选择的消息 ID。
2. 查找与保留前缀指纹匹配的有效压缩检查点。
3. 超预算时，以固定安全预算进行逐块摘要，不把全部长历史一次提交模型。
4. 候选 Agent 初始化、新建、恢复原设置成功后才切换。
5. 标记 contextPending；下一条普通消息携带准备好的历史，同步成功后清除标记。

删除摘要覆盖范围的内容会使该检查点失效；优先使用更早有效检查点，否则有界重建。摘要可取消，失败不静默丢弃记录。历史工具调用只成为文本上下文，不执行工具回放；不会提升为系统指令。待同步时禁止 slash 命令；首轮同步结果不确定时断开，重连时重建独立后台会话避免重复注入。这是恢复同一逻辑对话的内部替换，不是隐式创建一个用户可见空白对话。

当前保留历史中含图片时拒绝文本摘要重建；必须先移除相关消息。不要通过丢弃图片来“修复”此限制。

## 内置增强适配器

默认 command=pi-acp、空 args 且 useBundledAdapter=true 时，使用扩展 Node 运行时执行 dist/pi-adapter.mjs。构建基于固定上游 pi-acp 源码注入 `src/pi-enhancements.ts`，在替换位置不匹配时直接失败。

只有协商 agentCapabilities._meta['pi-workbench'].version=1 后，宿主才使用：

- `_pi_workbench/inspect`：分页读取真实 usage、模型价格、原生有效上下文和检查点。
- `_pi_workbench/summarize`：有界摘要工作进程，关闭工具/扩展/技能/模板/会话保存。
- `_pi_workbench/cancel_summary`：取消摘要。

这些是本项目扩展，不是标准 ACP 方法。外部 Agent 可只实现标准协议，此时普通聊天仍可用，详细消费统计和长历史自动摘要会受限。用量通过稳定请求 ID 去重，历史分支不能重复计费；上下文圆环与累计 token 消费是不同数据。

## 渲染与安全边界

`webview/markdown.ts` 使用 Markdown token 规则隔离代码和公式，KaTeX trust=false，HTML 经 DOMPurify 净化。Mermaid 只渲染闭合围栏，strict 模式及 SVG 二次净化，禁止图内配置与远程图片。所有资源随包提供，无 CDN。

CSP 不允许 Webview 网络连接；只允许本地资源和 data: 图片预览。粘贴图片的格式、签名和体积在宿主重新检查。外部链接和本地文件打开经过协议、真实路径和工作区检查。

工作区信任限制宿主启动，ACP 授权卡片仅反映 Agent 的权限请求；Pi 自己的工具权限不由本扩展强制沙箱化。修改这条边界需要显式设计和文档，而非仅增加确认按钮。
