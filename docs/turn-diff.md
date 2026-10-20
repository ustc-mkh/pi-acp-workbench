# 每轮工作区 Diff 与手动撤回

## 使用

任务轮次下点击 **Review workspace changes**，展开摘要后可查看新增、删除、修改、权限及文本行数；**Load before / Load after** 按需加载只读文本。**Compare file in editor** 打开单文件原生对比，**View total Diff in editor** 打开本轮多文件对比。总 Diff 遍历全部摘要页，不限于当前卡片页；没有完整文本的文件跳过，其原因在卡片中显示。

**Undo this turn…** 在宿主预检通过后弹出模态确认，再次检查信任、会话、活动任务和未保存编辑，最后提交有持久 operation ID 的撤回。撤回恢复普通文本文件的轮前字节和权限、删除本轮新增文件、恢复本轮删除文件；**不回退聊天历史、模型上下文或 Git index**。新增的缺失父目录使用 0700，不猜测原目录权限。

## 采集与预算

- 宿主在接受并派发 prompt 前采集基线，在成功、取消或 provider 退出并 join 后尽力采集结果。基线不是 HEAD，包含轮前已有的未提交修改；shell 写入也在范围内，不依赖 ACP tool diff。
- 使用 Git 枚举工作目录中的已跟踪和未被忽略的未跟踪文件；不执行 add/reset/checkout/stash。需要 Git 和有效 worktree，失败显示 partial/unavailable，不把整个目录视为新增。
- 最多 5000 个枚举路径、单文件 1 MiB、每次快照文本 16 MiB、每轮完整文本详情 4 MiB。枚举输出最多 2 MiB，枚举及读取各有 10 秒期限。二进制、非 UTF-8、超限、特殊文件和读取失败标为 partial，不允许撤回。`.gitignore` 变化也保守标为 partial：新可见文件可能在轮前已存在，不能作为“新增文件”安全删除。
- 摘要每页最多 16 个文件，正文每次最多 64 KiB；内联展示最多 400 行/30000 字符，完整已保存正文通过编辑器查看。编辑器只读快照缓存每次打开替换，正文总量最多 4 MiB，过期 URI 不能映射到磁盘或网络。
- 轮次档案按 `(session, turn)` 不可变保存在私有 SQLite `turn_diffs` 表；冷查询无需启动 provider。删除会话会级联删除其 Diff，不删除工作区文件或 native provider 历史；不承诺立即安全擦除 SQLite/WAL 中的旧字节。
- 宿主崩溃/断电前尚未保存的最终快照显示 unavailable，重启不猜测重建，不自动撤回或重放文件操作。

## 撤回安全边界

- 只有完整、非空且内容/哈希/权限一致的快照可用；单次撤回最多 256 个文件，累计路径最多 64 KiB。超过撤回预算仍可审阅，不扩大事务或资源上限。
- 确认前进行只读宿主预检，确认后再次验证；客户端确认期间不接受切会话、新建或另一 mutation。撤回前后检查相关文件编辑器的未保存内容，信任撤销或任务/选择变化拒绝提交。
- 宿主检查当前文件仍等于 after 文本、哈希及权限，删除文件仍不存在。路径拒绝绝对路径、`..`、`.git`、链接穿越；目录/文件使用 no-follow 描述符，拒绝 symlink、hardlink、特殊文件与特殊权限。不执行客户端提供的 patch。
- 同/父子真实工作目录的所有存活 provider（包括空闲、发现模型及潜在后台活动）持有共享许可；正常任务之间不串行。撤回先物理 join 自己的 provider，再获取排他许可；其他重叠 provider 仍阻止撤回，不会为了撤回杀死其他会话。无重叠目录照常并行。
- 文件以私有临时文件暂存、设置普通权限并 fsync，发布前再次检查；逐文件 rename/unlink 并同步父目录。**多文件操作不是文件系统事务**。返回 `restored`、`uncertain`、`not_attempted` 逐文件结果；失败后停止后续发布。持久 receipt 防止相同 ID 重新执行，崩溃窗口只报告不确定，不自动重试。

## 必须理解的限制

快照不是文件系统事务或修改归属证明。同轮手工或其他会话修改也可能计入净变化。工作目录外、ignored 文件及任务留下的后台程序不在采集保证范围内。宿主门控不锁住外部编辑器、Git、其他程序或残留后台进程；检查与发布之间仍可能有外部写入，使用前必须审阅，失败/崩溃后检查实际工作区。

当前对符号链接采取保守 partial/拒绝策略，不读取其目标，也不提供旧 main 的链接文本对比。自主轮次的端到端生命周期与链接文本对比统一在[下一版计划](workbench-next-rewrite-plan.md)中补齐，不能以审阅模块已存在声称这些能力已恢复。

## 实现与证据

- `rust/crates/pi-acp-workbenchd/src/workspace_{review,reviews,gate,undo}.rs`：快照、归档生命周期、许可、发布。
- `app_workspace_review_tests.rs`：实际 daemon 核心与 synthetic ACP 子进程，shell 增删改、取消、provider 崩溃、重启冷查询、嵌套目录空闲 provider 门控、durable 撤回与相同 ID replay。
- `scripts/workbench-process-loss.mjs`：真实 SIGKILL，已发生 shell 写入不被重放、未完成 Diff 不被伪造；Pi/Codex/Claude 是 synthetic 协议角色，不是在线模型实测。
- `scripts/workbench-browser-smoke.mjs`：真实 Chromium 和生产 controller/IPC 链路；编辑器通过 port 捕获调用，不等于真实 Extension Host。
- `test/workbench-extension.test.ts`：mock VS Code API 验证原生多文件对比参数、只读 URI 与内容隔离；真实编辑器窗口/脏 buffer 竞态仍需 Extension Host 人工验收。

剩余Diff/撤回差异及真实环境验收统一见[下一版重构计划](workbench-next-rewrite-plan.md)。
