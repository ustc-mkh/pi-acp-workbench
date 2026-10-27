# P6 验收记录与能力边界

本文保留 **2026-10-23 候选**的最终有限验收结果，不代表后续版本自动通过相同验收。历史排查、失败批次、性能分布及 review 保留在原始 `.test-results/p6/` 和 Git 历史中；当前使用方法见 [VS Code](workbench-vscode.md)、[Telegram](workbench-telegram.md) 和[发布指南](workbench-release.md)。

该候选 GNU SHA-256 为 `2900551793830e9d9e68f3a11df07bc9ad05cbb1188cb5d833ec3c0580c628aa`，musl 为 `9f2a1c1b256e93991827017a76fc8a46950d78779a60824cf841e217d3301c29`。本地证据路径用于定位原始记录，未随公共文档提供原始日志；下载制品请验证对应版本自己的 manifest 和校验和。

## 最终有限验收矩阵（2026-10-23）

本次按计划 6.1–6.4 拆成 23 项，不把“任意排列全覆盖”或外部服务商发票对账追加成原计划放行条件。每行的精确证据路径、SHA-256 与范围见 `.test-results/p6/p6-acceptance-matrix.json`；最终制品的真实安装、解包、源码可重建性和校验和全部通过后，`final-status.json` 才记录 `p6_complete=true`。本表的“通过”只表示对应可观测要求，不表示所有 provider 都具备全部能力。

| 计划项                | 验收范围                                                  | 结论                                                 |
| --------------------- | --------------------------------------------------------- | ---------------------------------------------------- |
| 6.1-pi-basic          | Pi 文本/图片/设置/取消/恢复/native fork/继承 usage        | 通过                                                 |
| 6.1-pi-plan           | Pi 分支 Todo→Plan 投影与同 native 恢复                    | 通过                                                 |
| 6.1-pi-form-auto      | Pi 真实自主唤醒、独立轮次、Form、竞争输入与停止恢复       | 通过                                                 |
| 6.1-codex-basic       | Codex 文本/图片/mode/Fast/Plan 设置/取消与恢复            | 通过                                                 |
| 6.1-codex-permission  | Codex 原生编辑单次批准、待批准停止和迟到拒绝              | 通过                                                 |
| 6.1-boundaries        | 能力边界与用户排除                                        | 通过，明确支持边界                                   |
| 6.1-desktop           | 真实桌面对话与容量周转                                    | 通过                                                 |
| 6.1-history           | 历史/筛选/导出/复制/Plan/布局                             | 通过                                                 |
| 6.1-review-management | Diff、脏文件保护、管理与撤回                              | 通过                                                 |
| 6.1-usage-title       | usage、缺失/未定价、标题和继承排除                        | 通过                                                 |
| 6.1-mobile            | 手机独立流程及故障契约                                    | 通过，明确支持边界                                   |
| 6.1-ops               | 冷查询、owner/epoch/receipt、背压/join/lease/回退         | 通过                                                 |
| 6.2-loss              | 实际进程丢失与 commit/receipt/configure/fork 窗口         | 通过                                                 |
| 6.2-undo-partial      | 多文件 undo 首次发布后真实 SIGKILL                        | 通过                                                 |
| 6.2-answer-races      | 双端 answer、精确 expiry/cancel、Trust/旧页竞争           | 通过                                                 |
| 6.2-telegram          | Telegram offset/接受/ack/multipart/429/rebind/FIFO/公平性 | 通过                                                 |
| 6.2-image-cause       | 图片半帧受控旧版失败/当前版修复因果                       | 通过，明确支持边界                                   |
| 6.3-local-slo         | 成功 loaded 本地接受/取消 fence 的保守时延上界            | 通过，采用保守上界                                   |
| 6.3-read-p0           | 普通读取 P0 同机对照与 history/list 目标                  | 通过                                                 |
| 6.3-ui-fairness       | 1000 分片 UI、控制/query reserve 与八 lane 公平性         | 通过                                                 |
| 6.3-resources-soak    | 资源周转、600 秒 soak 与同宿主两小时 mixed                | 通过                                                 |
| 6.4-gates             | 两平台完整源/生产/SDK/实际安装门禁                        | 通过                                                 |
| 6.4-final             | 最终源码补丁、文档、归档与安装制品门禁                    | 最终独立制品门禁；以 final-status 和制品 review 为准 |

### 最后新增的真实路径与精确范围

- `async-71774bbf…/partial-review.json`：实际 Pi SDK `sendMessage(triggerTurn:true)` 在 idle/gate 后发起后台消息和独立自主轮次，真实模型 Form→批准→工具 marker/模型正文；竞争用户输入 Busy 且未 dispatch。第二次自主 Form 等待时 cancel（9.374 ms 含物理 join）、迟答拒绝、原 answer receipt 重放、冷只读不追加、同 native 显式继续均通过。最初探针合拼 notice/custom message/模型正文而失败，原 failed 状态和原 DB 保留，后续按 opaque message 分组精确断言，没有放宽模型 marker。
- `async-c7cf359b…/review.json`：真实模型调用隔离 Todo 工具，通过实际 SDK `appendEntry` 和 pinned bridge 投影 Plan；pending/in-progress 保留、completed 过滤，物理停止和同 native reload 恢复。另在冻结 cfg(test) snapshot 的精确门控处对真实 WorkbenchApp/SQLite 子进程 SIGKILL：第一文件已恢复、其余两文件仍为变更后内容；原 operation Started→重启 Uncertain，原命令拒绝重放，部分文件结果不变。父正常 shutdown；发布二进制没有此测试门。
- `async-fc3bf512…/review.json`：真实 Codex read-only 原生 `Permission` 请求，回答前不存在目标文件；`allow_once / Yes, proceed` 后实际文件为精确 marker。第二文件在待批准时停止（275.773 ms，含 join 和后续断言耗时，不当作纯 fence 时延），迟到回答被拒绝、没有文件；原正向 answer receipt 相同重放、宿主 exit 0。
- `async-55360fe6…/partial-review.json`：旧 P0 在受控 prefix→图片已归档/revision 广播→suffix 后出现半帧 IPC 失败；当前版 32 次成功。该受控因果证据关闭此回归定位要求，不能重建缺失的历史 incident trace 或把每次旧 timeout 都归为同一原因。
- 同批 `slo-audit.json` 从当前 GNU/musl 五轮和 GNU 两小时原始成功样本重算：prompt 包含 workspace capture、cancel 包含物理 join，均为更早本地 durable fence 的保守上界，p95≤100 ms、p99≤250 ms；history/list p95≤200 ms。内部 admission/registry/owner/fence/SQL+codec/纯 COMMIT 固定分桶分别保留，不冒称成功请求内部精确 percentile。普通读取同机 P0 对照 3000 样本无 >20% median/p95/p99 退化；历史 P0 full 公平性失败仍是负例，不伪造其比较分布。

### 保留的支持边界与风险

Claude **用户排除**。Telegram 入站照片未实现（caption/text 流程已验）；terminal:false 仅 metadata，不宣称 stdout/stderr port；Pi stable profile Fast 隐藏并拒绝设置。以上是明确受限体验，不算该能力成功。离线真实 SDK 的媒体/工具/compaction native history 切点与在线普通完整消息切点分别取证，不假称在线模型生成了所有 native 文件形状；继承 usage/billing 排除已验，不包含外部服务商发票审计。ACP 当前没有上游 expiry 时间戳透传，精确时钟测试只证明 domain/owner 语义。

真实 Telegram 窗口与受控 HTTP 故障契约分开：不声称实际制造了 Telegram 429 或断网。外部发送保留 at-least-once，外部未知结果不自动重试；进程组 join 不控制已逃离的外部程序。资源证据限本机两平台有限负载和采样，不是任意环境无泄漏证明。所有历史 failed 批和编译/fixture 失败保留，不用补测结果改写其终态。

仅验收 runner、测试扩展和文档更新；生产 GNU/musl/dist 与已验证两小时候选相同，不机械重跑两小时。后续版本需重新核对配套制品和兼容性，不迁移或清空旧 root。
