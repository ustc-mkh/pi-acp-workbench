# S5：工作区审阅与安全撤回执行记录

## 当前结论

**S5 用户入口与本地自动化主流程已完成，不再拆实现切片；严格阶段验收仍有 live/release 项及保守差异待确认，计划中的 S5 不冒充全部通过。**

工作树开始时已有 S5 模块及一轮本地证据。本轮保留这些代码，补齐了真实 Chromium 审阅/撤回、原生编辑器 port、取消/provider crash/SIGKILL、部分发布、receipt 丢失，以及空闲 provider 工作区门控。没有读取/修改真实业务 root，没有部署、push 或执行 Git 工作区回滚。

## 消掉的主流程阻塞

1. **审阅到编辑器**：每轮 Review → 摘要/权限 → lazy before/after → 单文件或总 Diff 原生只读编辑器。总 Diff 遍历全部摘要页、按 64 KiB 读取，总正文不超过 4 MiB。Webview 内联最多 400 行/30000 字符，并保留展开状态。
2. **安全确认到撤回**：确认前增加 `validate_undo` 冷/只读宿主预检；modal 期间拒绝本客户端新建、切会话及 mutation；确认后再次验证 editor dirty/trust/active/selected 状态，宿主 publication 再查快照。多文件结果为 restored/uncertain/not_attempted，不是假原子事务。
3. **空闲/后台 provider 绕过门控**：修复原工作树许可只随 turn capture 持有的问题，provider 从启动到物理 join 全生命周期持有共享许可；撤回先 join 自己的 provider，再尝试排他许可。其他同/父子目录空闲 provider 仍明确 Busy；正常任务与不重叠目录不被全局串行。
4. **取消/失败/丢收据**：真实子进程 shell 写入后 cancel 或 provider crash 仍保存净变化；host SIGKILL 尚未完成的 Diff 为 unavailable，不猜测重建。SQLite trigger 在真实文件发布后使 settlement 失败，重启查询仍 uncertain，同 operation ID 不再次改文件。
5. **边界及清理**：5000 文件/1 MiB 单文件/16 MiB snapshot/4 MiB detail 超限测试；`.gitignore` 改变时 partial，防止误删除轮前已存在但原来 ignored 的文件；路径/链接/硬链接/特殊权限/哈希冲突拒绝；删除 session 级联删除其 Diff，不删除工作区/native 历史。

没有恢复旧 Diff service 或建立第二份可重放领域投影。新增独立 `workspace_review`（采集/净变化）、`workspace_reviews`（turn capture 生命周期）、`workspace_gate`（共享/排他许可）、`workspace_undo`（快照校验/逐文件发布），复用现有 operation journal、worker fencing/join 与固定 SQL readers/writer。

## 数据与协议

- 开发版 schema 需要 `turn_diffs(session,turn,diff_json)`，主键不可变，session FK cascade。仍使用当前开发 format/schema-3 envelope；缺表旧 root 拒绝，不迁移、清库或双写。不得混用旧 binary/root。
- 同步更新 Rust/TS 的 IPC v3：`turn_diff`（最多 16 文件）、`turn_diff_content`（最多 64 KiB）、`validate_undo`（只读预检）、durable `undo_turn` 和 `UndoCompleted` 逐文件 receipt。旧/新开发构建必须成组使用。
- 前端只发送 session/turn/file index，不发送磁盘路径或 patch。编辑器 provider 只服务宿主已保存文本，URI 不授权磁盘/网络读取；缓存每次打开替换。

## 验证快照与命令

最终源码为未提交工作树；对 `git ls-files -c -o --exclude-standard src webview rust/crates scripts test package.json package-lock.json | sort -u | xargs sha256sum | sha256sum` 的结果：

```text
3c85af9f0a8a85ca2230e6f9ce88b8869df39099ba217a5cedfca92fbc2d10ca
```

文档更新不计入此源码指纹。使用 GNU/Linux、本地 synthetic ACP 与隔离临时 Git/storage roots；不宣称真实 provider/手机或 Extension Host 验收。

| 命令/证据                                               | 实际结果与范围                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run check`                                         | 通过，最终 TS 合同/入口检查                                                                                                                                                                                                                                                                            |
| `npm run audit:workbench`                               | 通过，生产图及文档链接；`/tmp/s5-audit-final.log`                                                                                                                                                                                                                                                      |
| `npm run format:check`                                  | 通过，Prettier + Rust fmt；`/tmp/s5-format-final.log`                                                                                                                                                                                                                                                  |
| Rust 定向 `workspace_` / `undo_receipt_loss`            | 通过；`/tmp/s5-archive-final.log`、`/tmp/s5-receipt-loss.log`                                                                                                                                                                                                                                          |
| Vitest controller/extension                             | 通过；dirty buffer 在 modal 前与确认后均拒绝，不 admission；只读 editor URI、multiDiff 参数、modal 期间 mutation 拒绝；`/tmp/s5-ui-final.log`                                                                                                                                                          |
| `npm run test:rewrite`                                  | 最终冻结源码通过（exit 0，`/tmp/s5-closure-rewrite.log`），全套子日志 `.test-results/run-KYhLYb`；Rust 332 通过/2 ignored；含 clippy、IPC、Telegram、Chromium、打包及 GNU production artifact。首轮通过日志亦保留                                                                                      |
| `npm run test:workbench:process-loss`                   | 通过，三个 synthetic provider profile 的真实 SIGKILL；新增 S5 shell write/未完成 Diff unavailable 断言；`/tmp/s5-final-process-loss.log`                                                                                                                                                               |
| `npm run test:workbench:startup`                        | 通过；`/tmp/s5-final-startup.log`                                                                                                                                                                                                                                                                      |
| `npm run test:workbench:scale`                          | 通过，五轮/场景；`.test-results/scale-50e4c6cf-3bac-4bb2-9941-8e2b2aff32f2`；并行验收环境，不作为独占机器 SLO                                                                                                                                                                                          |
| `npm run test:workbench:mixed`                          | 五轮通过，storage-only diagnostic；`.test-results/mixed-v1-06470953-61c8-445f-92cd-bd8c67629ff0`；并行运行，**不是** admission-to-fence SLO / reader A/B / 2h RSS 证据                                                                                                                                 |
| `npm run test:workbench:soak -- --duration-seconds 600` | 通过，109 轮/600694 ms；`.test-results/soak-d5f8e166-53f0-4ba7-9471-91ecf6d93595/report.json`。使用收尾早期复制的 test/host binary（报告含哈希），用于生命周期回归；之后 Diff FK/ignore-rules 与 receipt-loss 专测由最终定向/完整门禁复验。不冒充最终制品 600 秒新快照功能 soak 或 2 小时 RSS/WAL 验收 |

首次新增 Chromium 用例失败记录保留在 `/tmp/s5-browser.log`：测试等待折叠 details 内不可见按钮。修复真实 UI 的 Diff 展开状态保持，并按可见 summary 展开后运行，重跑通过 `/tmp/s5-browser-retry.log`；后续整条门禁也包含该用例。曾有 Rust fmt 未带 `--all` 的命令错误，随后正式 format gate 通过。不以重跑通过抹去失败记录。

GNU 制品 `service-artifacts/pi-acp-services-1.0.0-x86_64-unknown-linux-gnu.tar.gz` 的 SHA-256 为 `87792cad9f3615d50548f29a32a6f4b22fc98f447664e3771d49967a0c1419fe`。阶段只生成本地构建，没有部署或替换真实 root。

## 尚未关闭的严格出口

- 真实 VS Code Extension Host：原生单/多文件对比窗口、脏 buffer、信任撤销、modal 期间事件的真实 API 验收。现有 mock API 测试和 Chromium port 调用不是替代品。
- 在线 Pi/Codex/Claude、真实手机/Bot、musl 生产制品、2 小时混合 soak、admission SLO。GNU 生产制品/本地 synthetic 证据按门禁结果记录，不扩大为其它平台/环境结论。
- 与 main 的保守差异尚未经确认：符号链接仅 partial/拒绝、不提供链接文本 Diff；单次 undo 限 256 文件/64 KiB 路径（更大的完整快照仍可审阅）。
- 外部编辑器及残留后台进程不受宿主 workspace gate 保护；快照不是修改归属证明，发布不是文件系统事务。UI/确认文案和 `docs/turn-diff.md` 已明确，不把这一限制藏在测试报告里。

下一项不再是辅助模块或更多假设性竞态：应执行/确认上述剩余验收与差异，再勾选 S5；功能开发顺序之后才是 S6。

---

# S6：一次性代码集成与统一验收

## 代码交付范围

本次按 S6 全范围连续实现，然后统一编译/集成验收，没有分轮交付单模块，没有改写 S5 既有证据或删除失败测试。入口与限制详见 [用量与模型管理](workbench-management.md)。

- **统计**：`usage_facts` 与 prompt 接受同事务创建；按 turn/session 或 title attempt 去重、保存 source，缺失用量与未知缓存为 NULL。模型/UTC 天周月/会话 SQL 聚合，100 组 keyset 页、独立过滤总计和日期/模型/会话筛选；会话稳定编号与名称/归档标签。Pi 只读取本轮追加 native 字节；fork/native load 不回填或重复计历史；取消/崩溃没有返回值则 missing。
- **模型管理**：provider 分组/搜索/可见性与供应商级显示/隐藏/恢复默认；四项价格覆盖、provider 默认价/未定价语义；明确授权的 provider refresh/Pi context（保存/恢复默认）入口。只读查询不启动 worker、不写 models.json，不伪造其它 provider 的设置能力。模型设置行最多 1500、刷新/批量最多 500 模型、正文/JSON 仍用原硬预算。
- **命名**：持久编号、短输入 fallback、手动名称，Off/Follow/指定 Pi 模型策略；独立无工具/无项目上下文 title worker，15 秒宿主/12 秒 CLI 上限，不阻塞首条/下一 prompt。尝试先记账，失败仍 missing；manual-wins；标题结果及用量一次归属。桌面有界冷刷新名称，Telegram 菜单复用 summary。
- **内容与 P2**：保留并接通现有全历史 Markdown 导出/私有 spool/哈希与 UTF-8 slices、Mermaid/代码复制；新增有界完整消息复制、追加复用为草稿（不自动发出）、跟随输出和 1–10 行会话列表偏好。Telegram 薄向导选择目录、环境变量名、明确 user/chat allowlist，只写 0600/wx 新配置，不存 secret、不 TOFU、不部署/重启。
- **事务与恢复**：本地管理状态/terminal receipt 同事务；provider context 写入后丢 settlement 仍 uncertain，相同 ID 不重发。开始即记 title missing，不因崩溃或 observer 取消自动重做。查询通过固定 readers、写入经现有 writer，没有新增第二数据库或完整客户端投影。

复用全历史导出、renderer、独立 Pi title CLI、registered context extension、operation journal；未恢复旧全量 usage JSON store、旧 controller/daemon，也未新增同用途双路径。schema/wire 为同一开发 v3 组合更新，新 required 表/列启动检查拒绝旧 shape，不自动迁移/清空 root。

## 最终源码与验收窗口

未提交工作树的源码指纹（计算方式同上，覆盖 src/webview/rust/crates/scripts/test/package manifests）：

```text
0324a01f43530ce97991b33215cc430a1618065b6dc2c455bc4c3baa067071bb
```

最终 GNU 制品：`service-artifacts/pi-acp-services-1.0.0-x86_64-unknown-linux-gnu.tar.gz` SHA-256 `57029351ea78948635a2ef06309b94fc21015a0ce467c5e7953d7ae446a3183c`；其中 `service-dist/pi-acp-workbenchd` SHA-256 `538e9e03cbd4c903add633f9367b356a0b4dfef4fc868680ef943492d4dfa36c`。制品 smoke 使用此目录通过，没有部署。

代码统一验收过程中发现的问题均先定点修复再收尾，没有通过删除断言降低门槛：

1. Rust 初次编译发现 rusqlite 不直接接受 u64，改用已有 SafeInteger/受验证的 i64 SQL 边界；日志 `/tmp/s6-rust-check.log`。
2. 新增统计 total 标签分支与 UI load/form/disclosure 竞态，已修复为明确 Filtered total、加载时禁用旧表单、保留模型展开状态；失败日志 `/tmp/s6-management-ui.log`、`/tmp/s6-browser.log`、`/tmp/s6-browser2.log`；真实 Chromium 重跑通过 `/tmp/s6-browser3.log`，后续最终整条门禁包含此链路。
3. 首次统一门禁与 soak 发现 `app_provider_tests.rs:390` 最后已报告用量被新轮次错误清零（0 vs 100）。修复为保留 summary，`reported` 仅作当前 turn 证据，独立事实仍 NULL；未修改该既有断言。失败日志 `/tmp/s6-final-rewrite.log`、`.test-results/soak-faabe3be-5cc7-4d32-9236-dd7758274c19/report.json` 保留；最终源码重新跑统一门禁/600 秒 soak，不能把旧失败算通过。
4. 新增 copy-message 字节游标、总量和最终哈希检查，防止异常切片累积越过 1 MiB 剪贴板预算；新 controller 回归覆盖匹配文本及错误游标拒绝。

| 命令 / 证据                                                          | 最终结果                                                                                                                                                                                                                             |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run check` / `npm run audit:workbench` / `npm run format:check` | 通过；最终整条门禁再次覆盖；新增生产 graph 经显式审计，不删除旧安全审计                                                                                                                                                              |
| `cargo test ... management_tests`                                    | 六项通过，实际 synthetic 子进程、SQLite/文件系统，不是仅 DTO；`/tmp/s6-management-closure.log`                                                                                                                                       |
| 原三 provider 生命周期用量回归                                       | 修复后通过，`/tmp/s6-provider-fix.log`                                                                                                                                                                                               |
| Vitest 新管理/Pi setting/controller 用例                             | 通过，包含正文复制预算；`/tmp/s6-target-closure.log`。完整 TS 套件由最终门禁覆盖                                                                                                                                                     |
| `npm run test:rewrite`                                               | **exit 0**；Rust 338 passed/2 ignored、Vitest 37 文件/230 tests；clippy、IPC、Telegram、process-loss、13 项 Chromium 与 GNU 制品 smoke 全通过。`/tmp/s6-closure-rewrite.log`；完整子日志 `.test-results/run-mxJD2h`                  |
| `npm run test:workbench:startup`                                     | 通过，`/tmp/s6-closure-startup.log`                                                                                                                                                                                                  |
| `npm run test:workbench:scale`                                       | **exit 0**；7 组各 5 次独立进程采样/结构断言通过，`.test-results/scale-c2c69394-f0f5-48aa-8bc6-d3289393e971`；`/tmp/s6-closure-scale.log`。对比早期构建的 `/tmp/s6-final-scale.log` 只作历史证据                                     |
| `npm run test:workbench:mixed`                                       | 五轮 storage-only 诊断通过，`.test-results/mixed-v1-1981ef57-e9bf-4c40-8cd4-d66ad9f9d188/report.json`。并行构建/scale/soak 环境，history/list 个别轮次 p95 超过 200 ms，**不能宣称 §7 admission/page SLO 或 20% 基线回归预算已通过** |
| `npm run test:workbench:soak -- --duration-seconds 600`              | **exit 0**；105 个完整 join 循环、605834 ms，`.test-results/soak-8755a424-32a5-4339-a5dc-497dc3713ae7/report.json`；本轮把 S6 settings/statistics/restart 和 isolated-title/manual-wins 纳入每个循环，使用修复后同一源码固定二进制   |

## 未测项与后续边界

- 本地 GNU/Linux + synthetic ACP 的 Chromium/IPC/实际子进程证据，不等于在线 Pi/Codex/Claude、真实 Extension Host 对话框/剪贴板、真实 Bot 或 musl 发布产物。真实 context/title 调用费用/账号能力、配置向导实际交互仍需 live 环境验收。
- 600 秒为多轮 join/restart/故障循环，不冒充 2 小时单进程 RSS/WAL 平台值；mixed 是诊断，不是正式 admission SLO。没有为达标抬高预算或降低同步等级。
- S3 未完成的 typed 图片/thinking-Fast/autonomous 生命周期、S5 已列的保守差异不在 S6 中偷换为完成；S6 自身 P2 向导/显示偏好已提供代码及自动化，没有自行默认延期的 P2 实现项。
- 收尾时已检查所有验收 exit 文件均为 0，未遗留运行中的验收任务。完整门禁和扩展 scale/mixed/startup/soak 均在上述最终源码上结束；文档随后格式化与审计，不重建业务代码。
- 后续不应再连续深化 S6 辅助层：剩余是原计划的真实/发布验收与 S7 删除旧路径、切换检查。没有部署、systemctl、push，也没有读写/重置真实业务 root。
