# 用量、模型管理、命名与配置入口

## 桌面入口

顶部 **Usage statistics** 打开统计，**Model settings** 打开模型/命名设置；**Export Markdown** 导出完整已提交历史；**Telegram setup** 生成新配置。打开模型或统计页面时，独立临时进程只读本地 Pi 模型目录以刷新共享价格/context，不需要选择会话、不启动推理或修改 Pi 配置。翻页与冷历史查询只读取已保存数据。

### 用量统计

- 支持模型、UTC 天/周/月、会话分组，日期（含结束日）、精确模型 ID、会话筛选；日期分组提供费用柱条。周从周一开始。模型按单个模型估算费用降序，会话按数字编号降序；同费用或同编号使用稳定 ID 排序。每页最多 10 个聚合组，使用与筛选和排序边界绑定的 keyset cursor，仅在列表底部提供上一页、下一页与当前页码；切换分组或筛选回到第一页。每次只加载当前页，可逐页遍历全部会话（包括已删除会话的保留费用），过滤总计不随当前页改变。
- 事实以 `turn:<workbench session>:<turn>` 去重，在 prompt 接受的同一个 SQLite 事务中创建。只有当前轮实际返回的用量才填充 token 字段；没有数据是 NULL，**不是 0**。摘要保留最后一次已报告用量，当前轮事实与之分开。
- 输入、输出、缓存读取、缓存写入分别记录；缺失 usage、缺失缓存、未定价数量分别展示。费用是已知部分的 USD 估算，不是订阅额度或账单；不使用累计 token 猜上下文占用。
- ACP prompt response 是来源 `acp_prompt_usage`。Pi 只读取本次 prompt 期间追加到原生文件的字节（最多 4 MiB/500 个 assistant records），不是全量 native history；截断/替换/不完整时不补造零。不读取/回填 load 或 fork 的继承历史。
- 独立标题调用以 `title:<session>:<index>` 记账；开始前就记录缺失用量事实，超时/中断仍显示 missing，不自动重试。独立 turn（包括未来完整接通的自主轮次）使用相同 turn key 规则；**这不代表自主轮次生命周期已经完整接通**。
- `usage_facts` 使用日期、模型、会话索引，SQL 聚合后只返回一页，不把全量 records 放入 SessionView。会话用稳定编号/当前名称显示；单会话删除或批量清理后保留其已发生的费用事实、编号及删除时最后的会话名称；旧版已删除且未保存名称的记录仍显示 Archived session，不回删账目或 native 文件。

### 模型与价格

- 按 provider 分组、搜索，页面最多展示前 100 个匹配项；供应商级显示/隐藏/恢复默认，每批最多 500 个模型。未在实际 ACP catalogue 中出现的模型不会被塞进发送选择器；当前模型即使被隐藏仍保留可见，不偷偷切换运行模型。
- 可分别设置输入、输出、缓存读取、缓存写入四项单价（USD / 1M tokens），有限非负数，用户覆盖价优先于 provider 默认价。Restore default 清除覆盖；没有价格显示 Unpriced，不默认为免费。
- 用户设置按 `(harness, model)` 保存在同一个私有 SQLite root，最多 1500 行。价格和可见性修改不调用 provider；修改状态与 terminal receipt 同事务提交。相同 operation ID 不同参数仍拒绝。
- **Refresh provider models explicitly** 是授权后的外部操作，可以启动一个空闲 provider，通过明确协商的 `_pi_workbench/models` 刷新默认价格/context 元数据。默认价格使用最近一次明确刷新结果，不声称是供应商实时账单价。
- Pi context 单位是 k tokens（256 表示 256000），Apply 与 Restore default 是独立明确动作；写入 Pi 共用的 `models.json`，不会提高供应商真实能力。需要空闲且支持协商扩展的 provider。内部命令必须先在 Pi command catalogue 注册，绝不把未注册的内部字符串作为模型 prompt 发送。
- 其它 provider 仍显示自己实际的 ACP 模型；没有协商模型设置能力时明确 Unsupported，不伪造价格或 context 写入能力。外部设置在写入后、receipt 前中断可能 uncertain；不通过换 ID 或 reload 自动重做。

### 会话命名

- 编号来自宿主持久 `created_seq`；首条接受输入生成最多 48 字符的本地短标题。手动名称最多 80 字符，跨重启保存，并用于桌面列表和 Telegram 会话菜单。
- 自动命名策略为 Off / Follow current Pi model / Use specified Pi model。默认 Follow；非协商 provider 保留本地短标题，不伪装已有模型命名能力。
- Pi 自动名称在首轮结果后用独立、无工具、无项目上下文、无持久会话的进程生成。最多发送输入前 1000 个字符，CLI 12 秒超时、宿主最多等 15 秒；不让首条/后续业务 prompt 等标题。每个存活 provider 最多一份标题工作，provider join 会取消并 join 所属任务。
- 标题调用结果只覆盖 fallback 名称；期间手动命名始终优先。尝试标记先落库，不在崩溃/reload 后自动重试或批量命名旧会话。页面在轮次结束和一次有界延时后冷刷新名称，不重发命令。

### 导出与显示

- **跨页历史检索与共享历史清空**：列表搜索在 SQL 全历史范围按标题、工作目录、会话 ID 与 harness 筛选，筛选条件绑定分页游标；清空预览在事务中冻结目标与活跃任务/待投递计数。每次最多删除 10 个会话，逐会话复用既有 stop/join/receipt 删除流程，失败逐项持久化，可重启后继续；每批均由 Host 弹窗再次确认。Telegram 会话包含在共享清理范围内。删除不清理原生文件、usage、receipt、delivery/dedup 身份或归档内容；这不是物理擦除。旧筛选结果不会覆盖新的列表请求。
- **选择性文件撤回**：工作区快照完整时可逐路径选择最多 256 个文件、路径总字节最多 64 KiB；每批使用原有逐文件冲突检测与原子替换安全规则，不覆盖用户后续修改。单次撤回仍有安全上限，完整大快照必须显式分批，每批都确认；不能撤回模型上下文或快照之外的变化。
- Telegram 手机历史扫描预算与可见消息分段预算分离；扫描边界会说明可继续跨批扫描，不宣称片段完整消息。完成/取消/失败后仍发出有限本轮摘要，含冻结 diff 行数及可用性；durable outcome 与摘要不依赖会话仍留在列表。

- 完整 Markdown 导出复用历史分页、64 KiB content slices、校验哈希及私有磁盘 spool，按时间顺序流式写出，不受当前 200 条显示窗口限制。导出图片为不可变 archive descriptor，不生成任意外链。
- 每条消息提供 **Copy message**；归档正文按需、校验字节游标及最终哈希，剪贴板最多 1 MiB，超限引导完整导出。**Use as prompt** 将用户消息追加到当前草稿，不直接发送、不覆盖已有草稿，仍受 prompt 预算限制。
- Mermaid 与代码复制复用既有 CSP renderer；只使用 textContent/受限 Markdown，不添加原始 HTML 或远程资源旁路。
- Show thoughts、Follow latest output、Session list rows（1–10）与有限折叠偏好随 Webview 保存；流式刷新不重建模型设置表单，加载中的旧表单不可提交，模型卡片展开状态保留。

## Telegram 薄配置向导

Telegram setup 在受信任 Extension Host 中选择明确工作目录，收集 **token 环境变量名**、授权 user ID 和允许的 chat ID，仅以 `wx`/0600 写入一个新 JSON 配置；不收集/保存 secret token，不接受“第一个发消息的人自动成为 owner”。取消任何一步不写文件，不覆盖旧配置，不安装/重启服务，不读取/迁移/清理真实 root。

生成后必须人工检查 allowlist、设置 daemon 的环境变量，再按 [发布与配置](workbench-release.md) 启动单宿主。默认 worker 为 `pi-acp`，需要其它 harness 时编辑新配置。向导不是 Bot 登录凭据验证、在线身份发现或自动部署工具。

## 实现与证据边界

- `domain/management.rs`、`persistence/management.rs`、`usage_facts/model_settings/session_metadata/naming_settings`：typed 合同、索引聚合、事务设置与命名记录。
- `webview/workbench-management.ts`、`src/workbench-controller.ts`：完整桌面入口；`src/pi-turn-usage.ts`、`src/pi-enhancements.ts`：Pi 本轮事实、明确配置与隔离命名。
- `app_management_tests.rs`：真实子进程/隔离 root，价格、cache、missing、冷恢复、分页、标题与下一 prompt 并行、manual-wins、fork/load 不重复计数、receipt/外部设置 settlement 丢失。
- `test/workbench-management.test.ts`、`test/pi-model-settings.test.ts`、controller tests：实际 UI 动作、配置生成与注册命令、正文复制预算；`scripts/workbench-browser-smoke.mjs`：真实 Chromium→controller→IPC→synthetic ACP 的集成。

这些自动化不是在线provider、真实Extension Host/剪贴板/Bot的证明；剩余任务与验收要求统一见[下一版重构计划](workbench-next-rewrite-plan.md)。
