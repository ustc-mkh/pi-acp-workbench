# P6 验收记录与能力边界

## 结论边界

本文件记录工作区实际证据，不是生产放行证明。**截至 2026-10-23，当前已测试 GNU 为 `2900551793830e9d9e68f3a11df07bc9ad05cbb1188cb5d833ec3c0580c628aa`，musl 为 `9f2a1c1b256e93991827017a76fc8a46950d78779a60824cf841e217d3301c29`；包含本次 Pi Form 桥接和 owner 生命周期修复。** 当前证据见文末“owner 生命周期修复后的完整回归与在线补测”；旧 36bd/8976、b006/eb0d 等章节均为历史记录。完整回归父批保留 Pi 探针容量失败终态，同候选独立补测已通过；不可把失败批次改写为全绿。Claude 按用户要求排除。原计划 6.1–6.4 的功能、故障、性能与真实环境验收已逐项取证，最终制品门禁按下表单独确认。历史章节中的待验状态仅表示当时结果；本节及“最终有限验收矩阵”取代旧的泛化待验清单。synthetic peer、模拟 Telegram HTTP 和离线 SDK 不等于真实模型或真实 Telegram。

- 基线提交：`fbb17d0b399a41fccce0f599db47eb670f1af551`；在原有 P5 未提交修改之上验证，未提交、部署或操作真实 root。
- 环境：Linux x86_64、Node 22.23.1、Rust/Cargo 1.99.0。机器、依赖与命令输出保存在本地 `.test-results/p6/`；性能报告另含 CPU、内存、kernel、二进制 SHA-256 和原始请求分布。
- 会写业务存储的验证均使用独立临时 workspace/root；真实 Pi 离线 SDK 和新增 host mixed runner 另外使用隔离 HOME。既有部分 contract/startup runner 继承测试进程环境，但只运行 synthetic worker/本地 HTTP fixture，不调用个人 provider 登录状态。早期本地批次没有读取日常登录凭据或调用真实模型/Bot；后续用户明确授权使用本机既有配置与无上限费用预算，真实 Pi/Codex 和限定 Telegram 窗口分别记录，不把后续授权倒写成早期行为。只安装隔离用户级工具链，不安装系统组件；Telegram 旧服务按限定窗口暂停后已恢复，不部署候选。
- schema 仍是开发中的 storage v3，直接更新、不自动迁移。旧的开发 v3 root 也不能视为兼容；请保留备份并使用新 root，不能删除/重置真实数据来绕过验证。
- 日志和生成制品位于忽略的结果目录；本文仅记录可复查的结论和命令，不把本机路径当作读者可访问的发布证据。发布时必须另保存实际日志、完整源码/补丁及 manifest/checksums。

## 2026-10-21 短时收尾候选（历史证据）

短时收尾阶段曾暂缓长测；用户随后授权后台续验，现已完成全部七个阶段，详见文末“异步续验终态”。最终 GNU host SHA-256 为 `b1f11b4ae8e3a8b5af9e4a688833208a427cb8d93eb5082e0af03bd131287867`；其 storage/IPC 仍是开发格式 3，新 root、不迁移。

- `p6/rewrite-checkpoint-final.log`：完整统一门禁通过，Rust daemon **361 passed / 3 ignored**，协议 crate 另 2 passed；TS、runner、IPC/Telegram、11 个 process-loss 窗口、32 次 image-race、Chromium 和 GNU 生产制品 smoke 均通过。
- `p6/startup-checkpoint-final.log`：明确选择该 GNU artifact，启动失败清理、lease 释放与已有 socket 保留通过。
- `p6/full-mixed-checkpoint-short.log` 与 `host-mixed-v1-099854e7-2abb-4c29-ac28-de678b61da6c/report.json`：同一完整百万 backlog 工作集，配置 60 秒、实际 **63.261 秒**，52 轮 / **1,196** 个成功请求，正常 join；883 次模拟 HTTP 成功发送、11 组 UI workload。一次成功 RESTART：4077/4077 frames，20.321 ms，无 checkpoint 错误；WAL 高水位 **16,797,272 bytes（16.02 MiB）**。短测证明实际复用路径，不证明两小时平台。
- 该短测 pooled list/history p95 为 72.12/3.61 ms，cancel（含物理 join）为 21.79 ms，prompt（含 capture）为 26.33 ms，4 MiB PNG 为 99.03 ms；仍不是内部 admission/owner/SQL 分段 SLO。
- 最终服务归档/VSIX、实际解包启动/原生安装的终态、manifest、源码补丁及散列保存在 `p6/final-sha256sums.txt`、`p6/final-status.json` 和相应日志。只有终态文件确认的项目才算通过，打包本身不替代安装/启动验收。

旧候选已完成的两小时原始证据及 WAL 增长缺陷见下文。**新的 WAL 维护代码已完成同一候选两小时回归，WAL 末十分钟形成平台**；在线 provider/Bot、musl 工具链、真实 trust/交互竞争及完整内部计时/故障矩阵仍按待验表管理，P6 保持 `[~]`，不无条件放行。

## 验证中发现并修复

1. **IPC 半帧取消安全性**：连接的 `select!` 同时处理读请求、回复和广播。旧 `read_frame` 将半帧与超时起点保存在 future 局部；另一分支获胜会丢掉已消费的字节，混合负载可稳定触发 `IPC closed`。改为连接持有半帧及固定 deadline，不因回复/广播重置超时。新增 partial-frame 取消/恢复/多帧/deadline 回归测试；同一短探测修复后通过。
2. **Telegram 终态摘要**：契约测试仍匹配旧的裸 `Turn completed.`。更新为验证 Diff 摘要及正文→图片→caption→摘要→后续 notice 的完整顺序；已导出全部正文时仍保留明确的 `Output already exported` 提示，不能为了新摘要丢掉 dedup 语义。
3. **失败/取消摘要和文件数**：冻结 outcome 新增终态 revision 与文件数，取消/失败 notice 按同一 session/revision 读取已冻结事实，不依赖仍存在的 session 或当前工作区。回归覆盖两种终态、重启、删除源 session 后仍可读同一摘要。
4. **清空风险计数**：预览原先只检查 Input/Turn/HistoryEntry payload 中的 session，漏掉通过 Session target 引用的 Image/Notice/Interaction 等待发送 intent。改为同时覆盖 frozen target；测试包含仅有 target session 的待发送图片。
5. **显式分批撤回和桌面回归**：补测空/重复/未知/越界选择、逐文件冲突、未选文件不变、预检不写和重试不重复恢复；浏览器单测补测全历史筛选、最新清空 receipt 展示与显式下一批按钮，不因恢复状态自动删除。
6. 更新 storage 集成测试和真实 service artifact smoke 的 GC 精确 oracle：新增 dry-run/orphan/removed-content/batch-limit 字段后仍逐字段断言（含批次上限 500），保留 receipts/delivery/archive 与损坏库 fail-closed 的原验证，不用宽松匹配绕过错误。
7. 测试 wire helper 接收 readline error，连接重置按请求失败报告而不是以未处理 ECONNRESET 掩盖 host 失败；恢复 P5 更新时误替换的原有管理功能说明及 Remove 持久顺序表行。
8. **桌面初始状态竞态**：Chromium 捕获 `created session` timeout 且无 operation。静态检查确认 New session 在首个 workspace state 到达前已启用，handler 却会无声 return。改为初始化禁用，只在可信 workspace state 渲染后启用，撤销 trust 后再次禁用。补测状态到达前/撤销后不发送 create，增加 smoke 超时的 browser error 诊断；修复后连续 5 次实际 host Chromium smoke 通过。
9. **大量 deferred topics 隐藏 ready topic**：完整工作集的实际 HTTP 探测中，2048 个更早的 deferred head 填满 1024 项 dispatch 窗口，后面的 8 个 ready topic 无法发送。SQL 仍先按当前 binding 合并每个 topic 的不可变最早 head，再按“是否已到 Unix 秒重试时刻、原顺序”排序后限额；不先过滤 deferred rows，不增大窗口。回归覆盖 2049 topics、Session/direct target 合并、延期 head 不被 ready successor 越过、到期后恢复原顺序及秒/毫秒边界。原 P0 制品在同工作集的八 lane 屏障失败，不能作为有效的完整混合 A/B 分布。
10. **错误诊断被 ingress 关闭掩盖**：adapter 可以先关闭 admission 再结束监督 join，宿主先观察到 ingress 退出时，原来只返回通用错误。现在仍先完成全部 join，并打印每个失败的 cleanup 结果。HTTP ack 测试开发中的外部 SQLite 锁冲突据此被明确识别；没有把人为争用引起的 fail-closed 当成目标 SIGKILL 窗口通过。
11. **验收脚本边界**：长测汇总不再用展开参数追加超过十万样本，避免 V8 参数上限；每分钟原子保存明确未通过的原始样本，失败额外保存当前样本、host status/thread waits、系统 load/memory。真实离线 SDK 先在隔离环境编译并冻结 Rust test executable，再启动 SDK 运行时限；未放宽原 RPC 或 180 秒 SDK 阶段时限。完整工作集使用两个 IPC 客户端遵守每连接四个 query 限额；HTTP 八 lane 用可控 warmup 屏障，UI attach 完成后才采样。

12. **百万级 outbox 的 reader 占用**：续验两小时 full 工作集按 50 ms HTTP 响应预算预置约 116 万 delivery。只读 SQLite 3.51.2 探测发现原 head 聚合选择 retry index 并建立临时 GROUP BY B-tree，五次为 464–591 ms；现有覆盖索引为 95–100 ms（独立 SQLite 探测，不是 Rust/host SLO）。当前改为显式走 Pending-only 的 topic/order 覆盖索引，Acked 防重记录不进入该索引；原同 topic head 合并和 readiness 顺序保持。结构测试确认索引选择、FIFO oracle，以及额外 10k Acked 记录不增加 VM steps。旧内部索引形状不迁移，旧 root/二进制整组保留。修改后的候选必须重新门禁和长测；此前 small 的 2179 秒和 full 的约 10 分钟被有意中止并保留为未通过，不能写成两小时成功。只读探测见 `p6/dispatch-reader-probe.json`。

13. **持续混合读取导致 WAL 不能复用**：覆盖索引候选的实际两小时运行完成，但 WAL 增至 3,334,114,152 bytes；其间只读 WAL-index 采样显示 backfill 已接近最新 frame，不能写成“完全没有 checkpoint”。新增 writer 内部有界维护：每秒至多探测一次，物理 WAL 达 16 MiB 后检查逻辑 frames；仅逻辑日志达到阈值时尝试 RESTART，busy-wait 预算 20 ms，随后恢复正常事务的 5000 ms timeout。被长期 reader 固定时允许 busy/后续重试，不强行截断、不改变已提交 receipt，不保证任意外部 reader 下的绝对文件上限。日志记录 frames/busy/耗时，host runner 独立保留全部 checkpoint 结果及错误，不依赖 64 KiB 日志尾部。`p6/checkpoint-unit-final.log` 的三个测试通过：旧快照阻塞约 21 ms 后 busy；释放后复用 WAL、重开仍保留全部提交；错误恢复 timeout；小 WAL 不执行 SQL checkpoint。

### 新增专项证据与当前执行状态

- `p6/process-loss-ack-debug.log` 与 `process-loss-v2-eda9a040-fb69-4c74-b1de-59fe7b4353cf/report.json`：3 个 synthetic provider profile / 11 个真实 host SIGKILL 窗口通过。新增远端配置回复后、受控写锁阻止 settle 提交；Pi 远端 fork 返回后、源 worker EOF/join 完成与 adopt 前（fixture 冻结已知宿主父进程）；模拟 HTTP 服务成功返回前冻结已知客户端 host，再 SIGKILL，重启允许外部重复投递一次但不重跑 Agent，随后持久 ack。均重查原 operation，保留源和未收养 native branch；日志保存二进制/fixture hash、provider trace 和逐窗口结果。HTTP 窗口不声称客户端已消费成功响应，也不等同于真实 Bot。
- `p6/image-race.log` 与 `image-race-v1-274bb601-5de6-430b-b7d6-1daf8bb5a471/trace.json`：32 次实际 host/stdio 图片交错通过。provider 受 gate 控制，客户端先发送无终止换行的半帧；图片归档及 revision 到达后验证完整 SQLite 图片身份，再补齐请求，验证后续 inspect/image 响应。记录 provider dispatch、prefix/release、revision receive、suffix/response 时刻。它固化半帧取消回归；没有把历史所有 15 秒 timeout 都归因为同一原因。
- `npm run test:workbench:diff-benchmark`：五个独立 **release test binary** 进程通过，报告 `mixed-v1-020a5508-0cef-41f1-a3f3-7bf1a91795dd/report.json`。48 个文件约 30 MiB 整行 Diff，16 文件页、64 KiB 正文页，并发可完整解码的近 4 MiB PNG；保留逐请求样本及 SQL 行物化 / JSON 解码 / 投影的独立计时。各轮 mixed Diff 页 p95 为 20.17–24.65 ms，正文页为 22.74–25.94 ms；SQL 行物化 p95 为 27.67–28.48 ms，JSON 解码为 6.47–10.24 ms。各进程 peak RSS 约 252 MiB（含构造 fixture、独立分段基准和 reader），不能当 host 稳态 RSS。当前证据不足以要求为小页改写 schema，继续保留整行解码成本限制。
- `host-mixed-v1-824a9446-6951-48a5-84a0-2395ea06c15e/report.json`：一次 GNU release 完整工作集探测通过。实际同一 host 包含 10k sessions、100k history、1 MiB 正文、标准 PNG chunk/CRC 的 **4 MiB** 图片、16 active synthetic sessions、8 实际本地 HTTP lanes、2048 deferred topics；并行 Chromium 使用生产 bundle 与共享 1000-fragment workload 验证焦点、选择、连续代码块及 render/Markdown/input/long-task 分布。显示分片为注入数据，不能写成来自在线模型。此短探测不是五轮正式 SLO 或长期证据。
- 中断前 `p6/full-mixed-five-final.log` 只完成部分 runs，且包含明显慢样本；未产生通过的五轮终态。`p6/host-soak-7200-final.log` 因 `IPC timeout: cancel` 失败，未完成两小时；`p6/native-offline-phased.log` 和 `p6/rewrite-final-verified.log` 也未留下成功终态。全部保留，不用较早绿灯覆盖。续验先串行门禁/构建，再执行正式采样；不能仅凭中断/并发负载推定上述 timeout 的唯一原因。

### 覆盖索引修复前 GNU 候选完整工作集五轮

`p6/rewrite-resumed.log` 已有完整通过终态，包括新加入的 image-race 和 11 个 process-loss 窗口；Rust daemon 为 358 passed / 3 ignored，协议 crate 另 2 passed。`p6/startup-resumed.log` 的四类启动失败清理也通过。该批 GNU daemon SHA-256 为 `5bede1d4f0037d99630c132be0e2e3f4d94b71fce5f9d2bd91b9313acddcff49`。

`p6/full-mixed-resumed.log` 与 `host-mixed-v1-7fd23daf-c947-4a15-b2ad-5ba66040e4f4/report.json`：上述 GNU binary 的 **5 个独立 host 全通过且正常 SIGTERM/join**。每轮配置至少采样 30 秒；等待最后一个 UI workload 完成后各 host 实际计时 30.60–35.63 秒。共 795 轮、18,285 个成功 IPC 样本；与低强度 small 长驻诊断并行，未同时运行构建/全库测试。完整数据集及 UI/HTTP 源文件、原始分布、host 资源时序均冻结在报告目录中。

| IPC 完整工作集往返口径         |   样本 | p95 ms | p99 ms | max ms |
| ------------------------------ | -----: | -----: | -----: | -----: |
| history                        |    795 |   9.33 |  16.67 |  45.81 |
| list                           |    795 |  14.80 |  19.07 |  45.89 |
| 1 MiB archive 的单个 slice     |    795 |  15.44 |  20.46 |  27.07 |
| 迭代导出每个 64 KiB slice      | 12,720 |  35.04 |  52.00 |  95.92 |
| 独立 idle session setting      |    795 |   1.64 |   3.51 |  10.57 |
| cancel，包含物理 join          |    795 |  23.59 |  35.77 |  58.95 |
| prompt，包含 workspace capture |    795 |  31.87 |  38.30 |  49.53 |
| 4 MiB PNG，包含 IPC/base64     |    795 |  58.61 |  77.12 |  98.51 |

这是 pooled 原始请求的分位数，**不是 admission/owner/SQL 的内部 durable-fence 分段 SLO**。全部查询/控制请求成功；没有把背压拒绝混入延迟分布，也没有放宽生产限额。8 条 HTTP lanes 每轮全部进入 warmup 屏障，退出前快照累计 17,934 次成功发送；每个 ready topic 持续进展、同 topic 顺序断言通过，没有向 2048 个 deferred topics 发送。host peak RSS 各轮约 107–134 MiB，不能由五轮短样本证明长期无泄漏。

并行生产 Chromium bundle 的 28 组 1000-fragment workload 保留每个原始 UI 样本（28,000 个注入分片）。合并样本中 render p95/p99/max 为 3.4/16.2/44.3 ms，Markdown 为 10.6/13.9/16.1 ms，input handler 为 0.2/0.4/1.7 ms，input→下一 rAF 为 18.1/21.1/52.0 ms。观测到 279 个 long tasks，p95/max 为 88/109 ms；不声称零长任务或所有帧均小于 16.7 ms。焦点、选择、稳定消息和连续代码块断言全部通过；原生剪贴板和 modal 的独立 Extension Host 证据见下文。

真实 Pi 离线 SDK 的当前分阶段 runner 也已通过（`p6/native-offline-resumed.log`）：隔离编译 58.08 秒后才启动 SDK 阶段，18 guarded processes、0 network attempts、0 real model requests。未放宽原 30 秒 RPC 或 180 秒 SDK deadline。原有 a3 RPC 超时与中断/重负载下失败仍分别保留，不把本次绿灯当作所有超时的唯一归因。

### 覆盖索引候选（WAL 维护修复前）

`p6/rewrite-index-final.log` 已有完整成功终态：Rust daemon 358 passed / 3 ignored，完整 TS/runner/协议与契约门禁通过，生产 artifact smoke 通过。该候选 GNU daemon SHA-256 为 `8b4c9f7302f56370e0b5dceea928f72b6d73617eea6713512c2b3c447f2e2f0f`。`p6/format-index-final.log` 覆盖随后加入的 long-run backlog 选项与 Playwright signal ownership；`p6/mixed-interrupt-probe.log` 验证在完整 UI/HTTP 负载中 SIGINT 后保存未通过报告并正常 host join。

五轮正式采样使用 `--dataset full --backlog-seconds 7200 --runs 5 --duration-seconds 30`，预置量与两小时完整负载相同，避免用短时长自动缩小 backlog 后冒称修复百万队列性能。完整长测使用 `--dataset full --runs 1 --duration-seconds 7200`，完成情况及 WAL 问题见下文；它不覆盖随后新增的 WAL 维护代码。

`p6/full-mixed-index-final.log` 与 `host-mixed-v1-1e93ec06-8333-49de-a813-ac5d9888b6cb/report.json`：当前 SHA 的 **五个独立 GNU host 全通过并正常 join**，每轮实际 33.67–34.87 秒，139 轮 / 3,197 个成功请求。每轮预置 1,162,048 个 delivery（2048 deferred + 8 × 145,000 ready），并保留 10k sessions、100k history、媒体、HTTP 与生产 UI 并行负载。全部原始样本合并后：

| 请求                        | 样本 | p95 ms | p99 ms | max ms |
| --------------------------- | ---: | -----: | -----: | -----: |
| history                     |  139 |  57.67 |  62.31 |  66.14 |
| list                        |  139 |  67.41 |  73.30 |  94.21 |
| archive slice               |  139 |  66.82 |  73.57 |  94.51 |
| export 每个 64 KiB slice    | 2224 |  76.19 |  84.73 | 106.59 |
| idle setting                |  139 |   2.14 |   9.67 |  11.64 |
| cancel 含物理 join          |  139 |  19.78 |  21.15 |  22.20 |
| prompt 含 workspace capture |  139 |  32.43 |  58.25 |  67.44 |
| 4 MiB PNG                   |  139 |  87.49 |  99.52 | 106.10 |

不能将不同 backlog 的修复前短测与本批直接算作同数据集 A/B，也不能从外部往返反推出内部 admission/owner/commit 分段。百万压力中的修复前失败/中止原始样本单独保留。当前五轮 peak RSS 各为 67.9–89.6 MiB；每轮 8 lanes 都进展且保持 FIFO，退出前共 2,533 次成功模拟 HTTP 发送。30 组 UI workload 各注入 1000 fragments；pooled render p95/p99/max 为 2.8/14.4/34.2 ms，Markdown 8.3/11.8/12.9 ms，input handler 0.2/0.2/0.5 ms，input→rAF 17.1/20.5/36.4 ms；221 个 long tasks 的 p95/max 为 75/84 ms。两小时运行仍以独立终态为准。

### 修复前两小时完整工作集（保留失败资源证据）

`p6/full-host-soak-index-final.log` 与 `host-mixed-v1-c06af08d-d4dc-4e45-9d5e-c0b132705d98/report.json`：SHA `8b4c9f73…e2f0f`、同一 host PID **658020** 持续 **7202.176 秒**，6,983 轮 / 160,609 个成功 IPC 请求，正常 SIGTERM/join（code 0）。包含同一完整百万 backlog 工作集、八个 HTTP lanes（110,769 次模拟成功发送）、1274 组 UI workload（1,274,000 注入分片），不重建 measured host/root。

pooled history/list p95 为 55.47/61.47 ms，cancel（含 join）为 20.89 ms、prompt（含 capture）为 22.97 ms，4 MiB PNG 为 85.86 ms，export 每个 slice 为 71.57 ms。700 个资源样本中 RSS peak 129.72 MiB；前十分钟（排除首分钟）中位数 90.09 MiB，最后十分钟中位数 115.28 MiB；不能据此声称完全无增长。fd 稳态 71，最终关闭 UI 后 70；threads 36。**WAL 最后为 3.11 GiB 且未形成平台**，所以 runner 的诊断 PASS 不能当长期资源出口通过。

随后增加 WAL 维护并完成定向短测、常规门禁和制品；用户后续授权异步续验，同一最终候选的两小时终态及 checkpoint 趋势见文末。完整进程树/queue/内部阶段时序仍未闭合；本段原两小时证据完整保留，不与修复后候选拼接。

### 真实 VS Code 原生交互与 Reload

`p6/extension-host-full-final.log` 与 `extension-host-d79813c4-1b58-4792-b002-71d12a62f258/report.json`：VS Code **1.142.0** 的真实 Extension Development Host 通过 4 项基础检查和 12 项原生交互检查。使用隔离 HOME/profile/extensions/workspace/root、私有 CDP endpoint 与临时 driver extension；不替换 vscode API。完整模式不用 `--extensionTestsPath`，因为该模式的 DialogService 会自动回答 modal，不能据此声称测试了真实用户取消/确认。

覆盖 Enter/IME 抑制、系统 clipboard（仅测试自有内容）、实际设置和 provider 配置、创建/切换与逐会话草稿、editor selection/原生文件选择/图片预览与持久输入、隐藏重开任务继续和显式停止、单/多文件原生 Diff、dirty buffer 拒绝撤回、真实 Host modal 取消/确认和三文件撤回、原生保存对话框完整导出、renderer resize。实际 `Reload Window` 后 Extension Host PID 从 475445 变为 477440，恢复同一 session/draft/原 undo operation receipt；provider trace 逐字相同，证明该用例未重启或重放 provider。

启动器曾因 Reload 释放 CLI 而过早读取结果和移除 profile；现在有界等待新 Extension Host 的终态文件，并回收独立进程组后重试目录清理。前序失败日志保留；最终命令有成功退出终态。这里是实际桌面端接 synthetic daemon peer，不证明在线 provider、真实 trust 撤销/permission/expiry/cancel 的全部组合或 VSIX 安装路径。

### 覆盖索引修复前快速 soak 与安装制品入口

`p6/soak-resumed-final.log` 与 `soak-a31d52a2-a9bc-4e21-b97d-5358928bc62e/report.json`：**603.906 秒 / 68 轮通过并 join**，保留每轮 mixed、三个 provider profile、管理、标题和 11 个 process-loss 窗口的结构化结果。修复旧版本 console 文案匹配后，soak 校验 process-loss v2 报告、窗口类型和实际 executable hash；不凭一句 PASS 文案放行。这是 debug 构建的重启型快速门禁，不能替代 GNU 同 PID 长测。

`p6/extension-host-installed.log` 与 `extension-host-15a100af-fa88-4587-a41f-21e03d43b80a/report.json`：实际将当前 VSIX 解包安装到隔离 extensions 目录，**不传 extensionDevelopmentPath**，并连接 SHA-256 `5bede1d4…cff49` 的 GNU host，再次通过上述 12 项交互及 Reload。报告记录 VSIX hash `f854d742eeda7cfb5721cae2d0ea380f7742a2b2ed7258087bd848d5d7e07123` 和前后真实 Extension Host PID。这关闭该候选的 VSIX 安装入口；后续仅文档刷新可能改变 ZIP hash，不能把旧 hash 伪装成最终包。

## 首批本地自动化证据（较早基线）

以下为已完成命令的终态；各类证据不能互相替代。VSIX/最终归档刷新另见打包日志。

| 验证                | 命令 / 证据                                                                                                                                 | 当前结果与边界                                                                                                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 统一 rewrite gate   | `npm run test:rewrite`；`p6/rewrite.log`                                                                                                    | 通过。包含 TS check、结构审计、构建/格式、Clippy、Rust workspace、IPC/Telegram contract、capacity、process-loss、Chromium、full suite、GNU 构建/打包/实际制品 smoke；full suite 的 TS 为 38 files / 247 tests，runner unit 52 tests |
| 最终 Rust workspace | `cargo test --manifest-path rust/Cargo.toml --workspace`；`p6/rust-workspace-final.log`                                                     | 通过：daemon 357 passed / 2 ignored，协议 crate 另 2 passed；包括新增选择撤回测试。两个 ignored 项分别用真实 Pi offline 与 storage mixed 专门执行，不混入普通 suite 通过数                                                          |
| 真实 Pi 离线 fork   | `PI_OFFLINE_PI_CLI=…/pi-coding-agent/dist/cli.js npm run test:native-fork:offline`；`p6/native-offline.log`                                 | 最终源码串行重跑通过。真实已安装 Pi SDK 1.3.0；18 guarded processes，0 network attempts / 0 model requests；独立临时 HOME，覆盖 native prefix/compaction/settings/restart/adapter/load/inherited billing                            |
| 当前 VSIX           | `npm run package`；`p6/vsix.log`                                                                                                            | 通过：最终 UI 源码构建后生成 198 files / 2.87 MB；打包不等于安装后的真实 Extension Host 验收                                                                                                                                        |
| Host 混合请求       | `npm run test:workbench:host-mixed -- --binary "$PWD/service-dist/pi-acp-workbenchd"`；`p6/host-mixed.log` 与 `host-mixed-v1-*/report.json` | 通过；5 个独立 release host，各 30 秒，16 活跃 synthetic sessions，加独立 idle 设置、list/history/600 KiB archive 查询和 cancel/re-prompt；22,128 个成功采样请求，见下表                                                            |
| 存储规模 5 次       | `npm run test:workbench:scale`；`p6/scale.log`                                                                                              | 通过：7 个场景各 5 次，报告 `scale-504eecb8-393d-43de-839f-c8292d2215ae/report.json`；独立 100k history/10k session/dispatch/重启故障/导出场景，不是全场景同 host 混合 SLO                                                          |
| 存储 mixed          | `npm run test:workbench:mixed`；`p6/storage-mixed.log`                                                                                      | 通过：5 次独立进程，报告 `mixed-v1-abb0fb62-d34a-4b83-bf43-5ffdca7d261f/report.json`；用于 SQL/存储混合负载，不可解释为端到端 owner admission-to-fence                                                                              |
| 重启型 soak         | `npm run test:workbench:soak`；`p6/soak.log`                                                                                                | 通过：602.8 秒、97 个完整 rounds，报告 `soak-b19e6305-9058-4509-aa0a-0ef10ebf7a96/report.json`；每轮 mixed/三个 synthetic profiles/management/title 与三个实际 process-loss 检查均 join；重复启动 host，不能冒充同一 host 长期稳态  |
| 同一 host soak      | `node scripts/workbench-host-mixed.mjs --binary "$PWD/service-dist/pi-acp-workbenchd" --runs 1 --duration-seconds 600`；`p6/host-soak.log`  | 通过：同一 PID 2474647 持续 600.04 秒，14,523 轮 / 87,138 个成功请求；报告 `host-mixed-v1-8d2de095-4418-4294-a051-596e314fcc8f/report.json`。仍不覆盖真实 provider/Bot 或两小时要求                                                 |

### GNU 生产制品与封存

`npm run package:services` 生成 GNU tarball，实际解包后先验证所有 `SHA256SUMS`，再用解包目录/二进制运行 `service-artifact-smoke.mjs`、`workbench-contract.mjs --binary …`、`workbench-telegram-contract.mjs --binary …`，分别通过制品 smoke、21 个 IPC checks、28 个 Telegram/IPC checks。日志为 `p6/archive-checksums.log`、`p6/artifact-extracted.log`、`p6/gnu-ipc-contract.log`、`p6/gnu-telegram-contract.log`。其中 Telegram 仍只连本地模拟 HTTP，不连真实 Bot。

首批 daemon SHA-256 为 `9dde40e0f39e5c64f91ab01a68fcfaf71bb480e8ae9fdedfb940930865c92072`；manifest 记录 GNU/glibc 动态链接、最低 GLIBC 2.39、Rustls/webpki roots、storage/IPC 3 与新 root 策略。本机 GLIBC 2.43 的通过不保证任意 GNU 发行版，也不代表 musl。manifest 的 `source.modified: true` 明示当前不是干净提交制品。

最终文档更新后再次刷新 VSIX/服务归档并复核内含文档与校验和；最终 tarball 和 VSIX 的 SHA-256 见 `p6/final-sha256sums.txt`，不在本文件写入自身归档散列形成循环。基线提交加 `p6/source.patch` 包括原有 P5 修改和新增未跟踪源码；`p6/source-files.sha256`、`p6/source-status.txt` 与最终 manifest 一并留存。结果只保存在当前忽略目录，尚未发布/上传。

### 性能报告解释

新增 host runner 对实际 Unix IPC 请求计时，本次正式样本显式选择 `service-dist` 的 GNU release artifact（默认不传 `--binary` 时是 debug，报告会明确记录，不能混为同一构建）。本机不是清场专用性能机，环境日志记录了当时内存/swap 等状态；本次仍为诊断性证据，不对专用发布基准作保证。runner 保存逐类原始样本分布的 median/p95/p99/max，排除预热；五次运行合并原始请求后再计算分位数，**不取五个均值的分位数**。每次冻结实际 host 二进制与 synthetic peer 源文件，使用隔离目录并验证正常 SIGTERM 退出。RSS、fd、thread、WAL 随运行采样；RSS 是 host PID，不是整个 provider 进程树的内存，runner 也未采集内部 owner/task/queue 深度或 checkpoint 明细。不能以独立样本的一次最大 RSS 直接证明长期无泄漏。

此前 small runner 不覆盖完整工作集。新增 full profile 的同 host 10k sessions、100k history、4 MiB media、8 HTTP lanes、2048 deferred topics 与并行 Chromium 已有上方正式五轮证据；内部 admission/owner/SQL 分段时序及同机同工作集 P0 A/B 仍未闭合。本次新增 runner 测的是包含 workspace capture 和物理 cancel/join 的端到端 IPC 往返，不用更宽或更窄的计时口径替换计划中的 release SLO。

### 已测 GNU host 混合请求（五轮各 30 秒）

证据：`.test-results/host-mixed-v1-207e6fdf-2d86-4d3d-a9c8-6039df428b5f/report.json`。共 3,688 轮，每类 3,688 个成功请求，六类合计 22,128 个采样请求。下面是合并原始样本的毫秒分布，不是五轮均值的分位数。

| 实际 IPC 往返口径            | median |   p95 |   p99 |   max |
| ---------------------------- | -----: | ----: | ----: | ----: |
| list                         |   0.73 |  0.89 |  1.00 |  5.89 |
| history                      |   0.91 |  1.44 |  1.62 |  4.39 |
| archived content slice       |   1.21 |  1.46 |  1.73 |  6.39 |
| 独立 idle session 设置       |   0.78 |  1.11 |  1.30 |  5.88 |
| cancel，含物理 join          |  12.21 | 14.64 | 15.15 | 91.22 |
| prompt，含 workspace capture |   7.64 |  8.15 |  8.57 | 13.90 |

五轮结束时 RSS 约 21.4–22.2 MiB，fd 为 67，threads 为 34–36；原始时序留在报告中。不把这些短时端到端结果转述为完整数据集下的内部 durable-fence SLO 或长期无泄漏证明。

### 已测同一 GNU host 600 秒

固定 PID 的 14,523 轮中，history p95/p99 为 3.29/3.44 ms、list 为 0.89/0.98 ms、archive slice 为 1.48/1.73 ms；idle setting 为 1.15/1.40 ms、cancel（含 join）为 14.95/15.48 ms、prompt（含 capture）为 8.61/9.21 ms。cancel max 为 81.95 ms，不将此总往返当作 durable fence 分段计时。

保存 1,454 个资源样本：host RSS 从 18.6 MiB 上升到 25.3 MiB（也是采样峰值），最后 120 个样本为 25.16–25.27 MiB；fd 恒为 67、threads 恒为 36，WAL 采样峰值 4,313,672 bytes。短期末尾变化减小，**仍不能证明两小时平台或完整进程树无泄漏**。host 正常 SIGTERM join 退出，未以 SIGKILL 隐藏清理失败。

### 已测存储 mixed（与 host IPC 分开解释）

五次独立进程的 pooled 样本：history p95/p99 为 106.18/112.78 ms，list 为 93.36/104.87 ms，image 为 103.98/108.14 ms；idle control commit 为 10.98/11.38 ms，mixed control commit 为 10.69/11.44 ms。**export slices 较慢：p95 706.72 ms、p99/max 786.47 ms**，不能用新 host runner 的快速 archive slice 数字遮盖这一不同工作集/排队口径下的慢样本。它不是普通 history/list 页超标的证据，但需要进一步分段归因才能说明并发导出的 reader/queue 影响。各进程 peak RSS 约 75.5–77.1 MiB（含 fixture）；这是 debug Rust 存储测试，不是 production owner queue SLO。

### 已测 Chromium 独立 UI workload（五次）

修复初始 create 竞态后，连续五次 `node scripts/workbench-browser-smoke.mjs` 均通过 17 checks，各自采样 1000 fragments。保存 `p6/chromium-{1..5}.log` 与 `*-render.json`，不是仅覆盖最后一轮。每轮 102 次 render、9 次 Markdown parse、最终 2 条逻辑消息；各轮 render p95 为 2.6–3.5 ms、最大 20.4 ms；input handler p95 为 0.1–0.2 ms；input→下一 rAF p95 为 16.9–19.0 ms、最大 30.0 ms。每轮仍观测 8–11 个 long tasks、最大 73 ms，未证明零长任务；这些范围是五个独立分布的范围，不冒称 pooled p95。保留焦点、文本选择、连续代码块、复制/链接端口、Diff/undo 与实际 IPC 流程验证；原生 Host modal/clipboard 的后续独立证据见上方；首批 Chromium 本身不证明原生端口。

## 尚未验证 / 放行阻塞

| 项目                                | 状态与已知原因                                                                                                                                             | 补验条件与所需证据                                                                                                                                                                              |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 真实 VS Code Extension Host         | **PARTIAL：当前安装 VSIX 的原生 15 项及 Trust 4 项通过**，含双端回答防重、cancel 后迟到回答、旧页面按钮、真实撤销/恢复信任。                               | 仍需未覆盖的 expiry/全部交互组合与 canonical workspace 边界；不由 19 项外推全部真实环境。                                                                                                       |
| Pi 在线能力                         | **PARTIAL：文本/上下文/load、图片、low thinking、活跃停止及唯一消息 native fork 通过**；默认不兼容模型失败和重复正文切点拒绝均保留。                       | Fast/Plan/autonomous、真实扩展 permission/elicitation、terminal、完整在线 cut/billing 边界仍待专项证据。                                                                                        |
| Codex 在线能力                      | **PARTIAL：真实文本/上下文/load、PNG 输入、read-only 模式及活跃生成停止通过**；固定 `codex-acp@2.2.2`。                                                    | 完整 model/Fast/Plan/真实交互/terminal/私有 fork/autonomous 能力或明确拒绝仍须逐项记录。                                                                                                        |
| Claude 在线能力                     | **用户暂缓**：已固定 adapter 并实际收到 Authentication required；未完成模型请求。                                                                          | 用户恢复本项并提供可用登录方式后再验；不继续登录或请求。                                                                                                                                        |
| 真实 Telegram Bot                   | **PARTIAL：真实 Bot/forum 新建、入站文本、恢复标记与实际文件写入**；8 条 delivery Acked，旧服务正常恢复。                                                  | 用户休息期间不再次暂停日常服务；入站图片、活跃 stop、真实扩展授权及断网/429 等仍待协调窗口，普通写文件未弹授权不能算授权流程通过。                                                              |
| 在线 native cut / billing           | **PARTIAL：Pi 唯一完整 Agent 边界 fork、独立 native identity/文件、源 SHA/历史/usage 不变、继承 usage 为 0、原 receipt replay 通过**；重复正文歧义被拒绝。 | 离线仍覆盖更完整重复文本/tool/media/grouped prefix 矩阵；在线媒体/compaction 边界及外部账单核对未完成，cost 0 不代表免费。                                                                      |
| 完整混合 release SLO 与 P0 A/B      | **PARTIAL（full runner 已实现，五轮已过，内部阶段/P0 对照未闭合）**，不能归咎于缺少凭据                                                                    | 完整工作集 runner 已完成五次正式终态；仍需补 host 内部阶段计时。P0 e218092 已在隔离目录原样构建，但同数据集因八 lane 公平性屏障失败，不能将其当有效混合分布；保留原始分布、资源时序及可比性限制 |
| musl x86_64 生产制品                | **本机目标通过**：隔离官方工具链、静态 ELF、manifest、实际进程矩阵、五轮及 600 秒通过。                                                                    | 最终归档解包 smoke 与 GNU 分别核对；不外推任意目标发行版，也不把 GNU 两小时称为 musl 两小时。                                                                                                   |
| 目标系统与真实服务 cutover/rollback | **未执行（本轮不授权部署）**；只验证隔离新 root/临时制品                                                                                                   | 独立备份与已验证恢复目标、实际目标发行版/ABI、运维明确授权；按 [cutover checklist](workbench-cutover.md) 手工操作，保留整组 artifact/client/storage 回滚记录                                    |

### 仍欠缺的专项证据（不以“重跑绿”关闭）

- **WAL 维护修复后的两小时回归已完成**：当前 GNU 同一 PID 运行 7202.879 秒，WAL 末十分钟保持 35.02 MiB；旧候选 27.66/46.02 MiB 记录仍保留，完整 checkpoint 结果见文末。尚不能由此证明任意 pinned reader 下的文件绝对上限、完整进程树无泄漏或 owner/task/queue 平台。
- **原有图片 revision batch 间歇 15 秒超时**：IPC 半帧丢失已通过独立回归证明并修复，但尚无原故障的 barrier/dispatch trace 一一归因。当前 image 契约通过不能单独证明原症状已彻底解释。保留专项待验：控制图片存档→commit→revision 广播→client receive 的 barrier，注入回复/分片/广播竞争并记录所有阶段。
- **专项故障窗口的完整映射**：现有 workspace/process-loss/contracts 覆盖真实 SIGKILL 回滚、receipt replay、配置/fork、交互竞争、partial undo、join/lease 和 Telegram restart/429。尚未对计划中每个 commit/receipt/dispatch 位置均建立独立可控 kill barrier，本次新增的 configure settle、fork adopt 前、HTTP 成功后本地 ack 前有可控证据，但本地 mutation/dispatch 的全部 cut、undo 部分发布的进程 kill 及交互竞争组合尚未逐个封闭。不得由总测试数推导“所有窗口已验”；仍需逐个冻结 trace 与重启结果。
- **Provider 长 barrier 公平性已补八项实际进程证据**：discovery/config/fork/title × cancel/remove，含其他会话输入、两 worker 容量下回收保护、title 同会话输入与 receipt 重启回放；并由此修复 fork 源误回收。仍未完整覆盖所有 RPC/排队/expiry/授权竞争及内部 admission/owner/settle 分段，不能由该八项外推任意 provider 长等待均可抢占。
- **大 Diff 整行 JSON 解码的成本归因**已新增五轮 release 基准，见上方 30 MiB/多页/并发 PNG 记录。SQL 行物化和 JSON 解码有明确成本，但当前样本未要求拆存储；更重的完整混合负载、最坏转义文本和 reader 占用仍不能由这一独立基准推导。
- 离线 Pi 在与全库/构建并跑时曾出现一次 `a3` RPC 30 秒 timeout；停止并行负载后最终源码重跑通过。保留失败日志 `p6/native-offline-overlapped-timeout.log`，增加 CLI 退出/stderr/RPC 类型诊断，**不自动放宽超时，也不将其归因为已证明的 CPU 饱和或声称已修复**。尚需在受控负载下复查该超时。

### 必须分别填实测证据的 provider 矩阵

| 能力                                       | Pi 离线真实 SDK                                               | Pi 在线 | Codex 在线 | Claude 在线 |
| ------------------------------------------ | ------------------------------------------------------------- | ------- | ---------- | ----------- |
| prompt / image 实际模型交互                | 不覆盖在线模型                                                | 待验    | 待验       | 待验        |
| model / thinking / Fast 实际生效           | 仅 fork 历史设置/配置恢复；非模型生效证据                     | 待验    | 待验       | 待验        |
| Plan / permission / elicitation / terminal | synthetic 契约不算真实 provider                               | 待验    | 待验       | 待验        |
| usage 与真实 billing                       | 覆盖 inherited usage 排除；不调用账单服务                     | 待验    | 待验       | 待验        |
| cancel / load / 原生独立 fork              | 离线 fork/load/restart/native format 有证据；在线 cancel 未验 | 待验    | 待验       | 待验        |
| provider 自主唤醒 / 断线恢复               | 未验真实服务                                                  | 待验    | 待验       | 待验        |

明确不支持的 provider 能力可以在真实版本证据下记为“不支持”，但必须验证 UI 降级，不能仅凭 ACP 规范填“通过”。当前客户端明确声明 `terminal: false`，桌面只显示已捕获 metadata，不提供 stdout/stderr/退出状态正文；这已知实现限制不能写成等待一次在线测试就会自动具备的能力。上述待验项未关闭前，不把 P6 标成无条件完成，不删除 cutover blockers。

## 2026-10-21 异步续验终态（历史候选）

用户随后授权长测后台执行、完成后再唤醒，不持续监督。批次 `p6/async-471bdc2e-c7c9-4ac4-8ebc-20309c1cdd8d` 已完成，七个阶段均正常退出（code 0）；`p6/async-current.json` 指向该批次。`batch.json` 保存冻结源码/dist、二进制散列、命令与预算，`status.json` 保存终态，`review.json` 保存逐阶段报告路径及核对结果。重新核对 **669 个冻结文件**全部匹配；GNU host 固定为上文 SHA `b1f11b4a…87867`。soak 显式传入 `--binary`，不将默认 debug 构建混为 GNU 候选。独立快照运行、阶段串行，保留全部日志、原始样本及早前失败证据。

| 阶段 / 批次内日志        | 阶段耗时（秒，含准备） | 核对结果                                                                                                                                   |
| ------------------------ | ---------------------: | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `soak-600.log`           |                 602.74 | 实测 602.485 秒，90 rounds / 450 phases，含每轮 process-loss v2 的窗口/散列验证                                                            |
| `scale-five.log`         |                 311.65 | 7 场景，各 5 次                                                                                                                            |
| `storage-mixed-five.log` |                  55.45 | 5 次；独立存储测试，export slices p95/p99/max **675.83/761.11/761.11 ms**，保留慢样本                                                      |
| `diff-release-five.log`  |                 223.65 | 5 次冻结 release test executable；mixed Diff page p95/p99/max 20.16/22.12/22.12 ms，JSON decode 6.66/7.18/7.18 ms                          |
| `native-sdk-offline.log` |                  57.00 | Pi SDK 1.3.0、18 个受保护进程、0 网络尝试/真实模型请求；native format、新 host、adapter fork/load/source 不变与 inherited billing 排除通过 |
| `full-mixed-five.log`    |                 319.00 | 5 个独立 host，各 33.82–34.67 秒；140 rounds / 3,220 请求、2,521 次模拟 HTTP 成功、30 组 UI workload，全部正常 SIGTERM/join                |
| `full-mixed-7200.log`    |                7230.19 | 同一 host 实测 **7201.215 秒**，7,048 rounds / **162,104 成功 IPC**，111,602 次模拟 HTTP 成功；正常 SIGTERM/join（code 0、signal null）    |

完整工作集包含同一 root 的 10k sessions / 100k entries、16 活跃及独立 idle session、1 MiB archive、4 MiB PNG、约 116 万 delivery、2048 deferred heads 和 8 个 ready HTTP lanes，以及并行生产 Chromium UI。五轮各 lane 均进展、FIFO/deferred oracle 通过；peak RSS 72.35–97.27 MiB，WAL 15.45–16.18 MiB。四轮未达到逻辑 checkpoint 阈值；另一轮记录一次 busy（20.375 ms），不能要求每个短测都出现成功 RESTART。

两小时报告位于批次的 `snapshot/.test-results/host-mixed-v1-51400cb4-64f0-44b1-826d-d40f4d068ac3/report.json`，同一 PID **956884**，706 个资源样本。WAL peak/末值 **29,004,832 bytes（27.66 MiB）**，前十分钟（排除首分钟）20.75–23.32 MiB，末十分钟全部为 27.66 MiB；与修复前持续增长至 3.11 GiB 的证据分别保留。共 **760 次 RESTART 尝试：117 成功、643 busy**，无 checkpoint 错误，记录耗时最大 20.764 ms；20 ms 是 SQLite busy 等待预算，不是磁盘 I/O 的硬时限。busy 后继续重试，没有请求失败，也不强行截断 pinned reader。

host RSS peak **124.20 MiB**、末值 114.71 MiB；首/末十分钟中位数 91.88/107.92 MiB，仍有增长，不能写成无泄漏证明。fd 采样 70–78（含启动峰值），threads 恒为 35；未包含整个 provider 进程树或内部 owner/task/queue 深度。

以下毫秒分布按原始 IPC 样本合并计算，口径仍包含实际 capture/join，不等同内部 admission/owner/SQL 分段 SLO：

| 请求               |    五轮 p95 / p99 / max | 两小时 p95 / p99 / max |
| ------------------ | ----------------------: | ---------------------: |
| list               |   67.98 / 75.05 / 94.84 |  60.52 / 64.77 / 73.08 |
| history            |   56.02 / 63.36 / 63.79 |  56.59 / 61.42 / 73.57 |
| archive content    |   67.66 / 75.46 / 94.97 |  61.13 / 65.55 / 73.75 |
| idle setting       |      2.18 / 8.80 / 9.99 |    1.42 / 1.67 / 62.79 |
| cancel，含 join    |   21.00 / 23.23 / 35.65 |  20.97 / 27.23 / 41.25 |
| prompt，含 capture |   24.57 / 42.10 / 47.20 |  22.80 / 36.18 / 84.48 |
| 4 MiB PNG          | 91.74 / 102.77 / 104.29 |  84.66 / 89.63 / 99.33 |
| export slice       |  77.51 / 88.49 / 119.41 | 70.66 / 79.47 / 132.72 |

两小时并行 UI 共 1288 组 workload（1,288,000 注入分片），每组最终 2 条逻辑消息且连续代码块断言通过。pooled render p95/p99/max 2.1/12.8/34.9 ms，Markdown 7.1/7.9/13.9 ms，input handler 0.2/0.2/1.0 ms，input→rAF 17.2/18.7/37.6 ms。仍观测 8970 个 long tasks，p95/p99/max 69/72/87 ms，不宣称零长任务或纯渲染耗时。

本批次通过只关闭上述冻结候选的实际覆盖项。在线 provider/Bot、musl、原生 trust/交互组合、历史 timeout 归因、完整 kill/barrier 矩阵及内部 SLO/P0 A/B 仍按待验清单管理，P6 保持 `[~]`。本批次没有调用日常凭据、付费模型/Bot 或部署；收尾后删除 `p6` heartbeat，不继续监督或重复启动长测。

## 2026-10-22 专项续验（新候选完整回归通过）

新增实际 GNU host 的 provider request barrier 矩阵，使用隔离 HOME/root、两 worker 容量和 synthetic ACP。先明确冻结一个未回复 RPC，再验证查询/独立输入、第三会话触发的 idle 回收、同会话 cancel/remove 和原 stop receipt 重启回放；不将这类物理 join 往返解释为内部 durable-fence SLO。

旧候选 `b1f11b4a…87867` 在 discovery/configuration 的 cancel/remove 场景通过后，**fork 场景发现真实回收缺陷**：源会话在存储中仍为 Idle，回收只看 turn/configuration/title pin，未检查 host 已接受的 fork workflow，因此第三会话输入误停源 worker，触发 `_pi_workbench/cancel_fork`。原始失败报告保留为 `provider-barriers-v1-1b202077-b455-4bdc-9976-95c4d573c01f/report.json`（另有测试开发期配置/oracle 失败，均未删除）。此前两小时成功仍只适用于该旧候选已覆盖场景，不能关闭本次暴露的问题。

修复在回收的数据库 await 后、移除 adapter 前检查现有 fork admission lease，保护排队/正在运行/尚未完成 adopt 的源 worker；lease 归零后不再保护，不新增持久状态或放宽容量。新 GNU 候选 SHA-256 为 `b0066645cd510c14925d5ea82cd15c59e93e0e0036b7c198c0506c45589b8c41`；八项短矩阵全部通过，报告 `provider-barriers-v1-80397620-0470-4258-8b5b-e46133568171/report.json`。覆盖 discovery/configuration/fork/title × cancel/remove；每项都在未释放 barrier 时完成独立查询/输入，并在两 worker 上限下回收另一个 idle worker、保留被占用 worker，随后物理停止/移除和重启回放原 stop receipt。title 另验证同会话新输入与手动命名不受阻。停止含实际 join 的往返约 2.26 秒（未响应控制请求时会等待现有取消期限），不是 ≤100 ms 内部 durable-fence 的证据。新候选使用下述独立六阶段终态，不继承旧散列的长测/制品绿灯。矩阵命令为 `npm run test:workbench:provider-barriers`，或显式 `node scripts/workbench-provider-barriers.mjs --binary …`；结果以独立结构化报告终态为准。

异步批次 `async-a30bc76e-7f5d-4658-9517-fd01762fff9d` 在源码门禁停止，未进入生产矩阵/长测。类型/audit/build/format/clippy 和 Rust **361 passed / 3 ignored**（协议另 2 passed）已过；TS 中 36 文件通过、2 文件失败，明确原因是快照未提供默认 `rust/target/debug/pi-acp-workbenchd`（ENOENT），存储工具也未指定 binary。没有跳过集成测试或把 release 文件伪装为 debug：实际客户端测试新增显式 `WORKBENCH_TEST_BINARY` 选择，后台 driver 分别给客户端与存储测试注入冻结 GNU 路径，默认开发运行方式保留。原失败日志与快照保留；修正后必须使用新批次终态，不改写失败状态。

### 六阶段异步终态与制品口径

批次 `p6/async-80951a6f-1768-4278-87f2-11d64cf9c424` 六阶段全部正常退出；`batch.json`、`status.json`、`review.json` 和逐阶段日志完整保留。核对 385 个不可变输入（源码、调度脚本、GNU 候选）及各 runner/fixture 散列。源码门禁主动 `npm run build` 重建 `dist/`，因此初始复制的 dist 不是最终冻结产物：220 个旧生成文件被改变/替换，未把这部分冒称为“全部文件始终未变”。实际测试后的 dist 另封存为 `tested-dist.sha256`；五轮和两小时报告记录的 webview/CSS/runner/fixture 散列与实际文件一致。最终 VSIX 直接封装这套已测试的 dist，并核对 ZIP 内文件及实际安装；不混用另一个路径重建的 bundle。

| 阶段                     | 含准备耗时（秒） | 结果                                                                                                                                 |
| ------------------------ | ---------------: | ------------------------------------------------------------------------------------------------------------------------------------ |
| `source-gate.log`        |           106.01 | 类型/audit/build/format/clippy；Rust 361 passed / 3 ignored，协议 2 passed；TS 38 files / 247 tests；runner 52 passed                |
| `production-gate.log`    |            77.55 | IPC 21、Telegram/IPC 28、容量、11 个 kill windows、32 次 image interleavings、8 项 provider barriers、Chromium 17 及 startup cleanup |
| `native-sdk-offline.log` |            58.31 | 真实 Pi SDK 1.3.0，18 guarded processes，0 network/model requests，fork/load/source/billing 离线检查通过                             |
| `full-mixed-five.log`    |           331.11 | 5 个独立 host，各 33.82–33.99 秒，135 rounds / 3,105 成功 IPC；模拟 HTTP 2,432 次，UI 30 组，全部正常 join                           |
| `soak-600.log`           |           603.08 | 实测 602.798 秒，82 rounds / 410 phases；每轮独立检查 process-loss v2 原窗口/散列                                                    |
| `full-mixed-7200.log`    |          7239.65 | 同一 PID 190967 实测 7206.257 秒，6,080 rounds / 139,840 成功 IPC，正常 SIGTERM/join（code 0、signal null）                          |

独立复核 83 份 process-loss v2 报告，各自 11 个窗口、冻结二进制/fixture 散列及实际 kill/正常退出证据；32 次图片交错有结构化 trace 和正常退出。provider barriers 的正式报告位于批次 `snapshot/.test-results/provider-barriers-v1-e2c41054-41ca-4244-88fe-b66770ad1426/report.json`：八项均在 RPC 未回复时完成查询和独立会话输入，容量回收保留被占用源 worker，cancel/remove 后物理退出并重启回放原 stop receipt。查询 0.14–0.89 ms，独立会话冷输入 101–110 ms；title 同会话输入约 18 ms。discovery/config/fork 的停止含 join 约 2254–2257 ms，title 约 254 ms，分别保留这两个口径，不能用快速 query 冒充取消 durable fence。

两小时正式报告：批次 `snapshot/.test-results/host-mixed-v1-6ae2411c-ceac-4fd4-a6f4-132eb5d4468d/report.json`。同一完整百万 backlog 工作集、八 HTTP lanes 均进展/FIFO，无 deferred 越过或 HTTP 错误；96,969 次模拟发送，1,249 组 UI workload（1,249,000 注入分片）。609 个资源样本：WAL 高水位及末值 **48,257,592 bytes（46.02 MiB）**，前十分钟（排首分钟）22.01–35.26 MiB，最后十分钟均为 46.02 MiB；**1,384 次 RESTART：69 成功、1,315 busy**，无 checkpoint 错误，最大记录耗时 22.01 ms。20 ms 是 busy 等待预算，并非整个 I/O 的绝对上界；本次平台高于旧候选的 27.66 MiB，不能声称固定 16 MiB 文件上限。

host RSS peak **123.29 MiB**、末值 **101.44 MiB**，首/末十分钟中位数 86.84/101.57 MiB；仍不能证明全进程树或 owner/task/queue 无增长。fd 70–78（含启动），threads 恒 34。五轮短测 RSS peak 76.93–93.49 MiB，WAL 15.21–15.41 MiB，均未触发逻辑阈值，不要求每轮出现 RESTART。

以下为原始请求 pooled 分布，单位 ms；取消包含物理 join，prompt 包含 capture，继续与内部时序 SLO 分开：

| 请求               |  五轮 p95 / p99 / max |   两小时 p95 / p99 / max |
| ------------------ | --------------------: | -----------------------: |
| list               | 64.56 / 66.95 / 71.14 |   74.63 / 81.32 / 120.89 |
| history            |  2.86 / 59.12 / 59.89 |   63.27 / 72.09 / 134.38 |
| archive content    | 64.75 / 67.28 / 71.65 |   75.10 / 82.09 / 121.93 |
| idle setting       |   1.76 / 9.43 / 71.95 |      1.78 / 2.45 / 46.46 |
| cancel，含 join    | 19.54 / 22.36 / 23.30 |    26.44 / 37.07 / 61.16 |
| prompt，含 capture | 23.63 / 56.12 / 78.48 |    27.15 / 33.78 / 84.60 |
| 4 MiB PNG          | 89.17 / 93.98 / 94.55 | 102.23 / 109.87 / 198.26 |
| export slice       | 76.90 / 85.57 / 94.75 |   81.33 / 96.59 / 189.33 |

两小时 UI pooled render p95/p99/max **2.6/14.8/35.6 ms**，Markdown **7.9/9.2/18.7 ms**，input handler **0.2/0.4/1.5 ms**，input→rAF **17.8/21.2/63.6 ms**；仍观测 9,549 个 long tasks，p95/p99/max **74/81/178 ms**。不证明零长任务；旧独立 storage export 的慢样本和 P0 不可比性仍保留，不以本次 IPC 数字覆盖。

该终态关闭本候选的实际覆盖项。真实在线 provider/Bot、musl、trust/交互组合、原始超时归因、完整内部时序及 kill/barrier 矩阵仍未闭合，P6 保持 `[~]`。最终 manifest、源码补丁/重建校验、GNU 解包和安装 VSIX 的独立终态及散列保存于 `p6/final-status.json` / `p6/final-sha256sums.txt`；批次状态不会被收尾文件覆盖。无部署、真实 root 或日常 provider 凭据操作；收尾且无后台测试后删除 heartbeat。

## 后续授权验收（进行中）

用户已授权使用本机 Pi/Codex/Claude/Telegram 配置进行真实在线验证，不设费用上限，并授权隔离用户级工具链安装；不再以“未获授权”作为后续阻塞。原先记录是当时状态，仍保留历史候选证据。

- 官方 Rust 1.99.0 musl std 已验证发布 SHA-256；系统 Fedora rustc 即使版本/commit 相同仍报 E0514 元数据不兼容，保留原失败日志。隔离安装同版官方 rustc 与 GNU std 后，musl 静态制品已构建成功，初始实际启动/维护 smoke 通过。完整矩阵/五轮/600 秒在独立后台批次进行。
- 官方 ACP 适配器固定为 Codex `@agentclientprotocol/codex-acp@2.2.2`、Claude `@agentclientprotocol/claude-agent-acp@0.94.0`，只安装于忽略的测试目录，真实在线 smoke 正在独立快照中执行。Pi 使用本项目 bundled adapter 和隔离数据目录；凭据不写报告。
- 原生授权防重、取消后的迟到回答、切会话旧页面按钮三项已通过：`extension-host-9afdd521-09ed-43c1-be5a-dc4cdf967151/report.json`。真实 trust 管理页启用后，Restricted Mode 拒绝生产扩展、原生授权、待决授权时撤销信任卸载扩展、再次信任后恢复原 interaction 且只执行/回答一次，四项通过：`extension-host-7ab815d3-723b-4f55-a3c7-b9abe4fd1f0d/report.json`。经历实际 Extension Host PID 更替，未 mock API、改生产清单或强制点击遮挡控件。开发期 oracle/modal editor 失败日志保留。
- 用户另授权旧 `pi-telegram` 暂停最多 15 分钟并配合真实消息。先确认无 webhook/待处理更新、准备新 root、设置独立恢复计时器，保留 `pi-sessions` 与旧数据。真实用户 `/new` 和消息已创建/进入候选会话，Bot 正确返回失败终态及 Diff 摘要；初次模型调用收到上游 400：`gpt-5.5` 不支持当前 ChatGPT/Codex 账号。此失败未改写为通过。显式刷新并选 `openai/gpt-6.1-sol` 后，新的独立恢复请求返回 `P6_TELEGRAM_RECOVERY_OK`，按同 turn 拼接不可变分片验证；不是换 ID 重放原失败 operation。
- 直接在失败 adapter 后设置模型还暴露 `mailbox_closed`，正在补确定性回归并修复；原生设置需能提交冷偏好，不能将关闭的 sender 当活 worker。该问题及后续修复候选不得继承 b006 的长测散列。

本轮真实 Telegram 用户确认收到了模型恢复标记并成功写入 `p6-approval.txt`；文件在验收目录，内容为 `P6_APPROVAL_OK`。普通 Pi 文件写入没有产生 permission 请求，不把它冒称授权流程通过；适配器支持的扩展交互 request_permission 与内置写文件默认行为分别记录。15 分钟窗口按约结束，未完成图片/主动停止的项目继续待验，不自动延长停服时间。失败设置问题新增 `settings_after_failed_worker_commit_cold_preferences_and_resume_without_stale_mailbox` 回归，修复前明确 `MailboxClosed` 失败，忽略已关闭/结束/停止的 adapter 后通过；新源码尚待构建/完整验证，已测 b006/eb0d 两候选不含该修复。

### 授权续验的当前边界（2026-10-22）

用户选择暂缓 Claude，不再补登录或发送 Claude 请求。已结束批次 `async-6f6340a4-daa2-4df4-8a40-3984c00670d4` 的原终态为 failed，保留不改写；独立 `partial-review.json` 核对全部冻结输入及二进制，确认 musl 三阶段（生产矩阵、五轮完整工作集、604.168 秒/83 轮 soak）通过，所有测量 host 正常退出。Codex 三个真实响应标记另逐一拼接核对，文本、上下文续接和停止后 native load 通过；Pi 无文本失败及 Claude 登录失败保留。它们只证明旧 GNU b006 / musl eb0d 候选。

失败 worker 后设置修复已启动新 producer 批次 `async-d23f301a-5956-44ca-892b-527de5410314`：14 阶段依次构建 GNU/musl、源码门禁、两平台生产矩阵、离线 SDK、原生桌面/Trust、两平台制品、Pi/Codex 在线、各五轮完整负载/600 秒 soak，最后 GNU 两小时负载。二进制由构建阶段产生后冻结并记录 `candidates.json`，dist 由源码门禁生成后另记录 `tested-dist.sha256`。源码和 runner 在启动前冻结、每阶段复核，不能将待构建输出伪称为启动前已测试的二进制。在线阶段失败允许继续其余本地覆盖，最终整体仍保留 failed。当前批次尚无通过结论。

真实 Telegram 的 900 秒授权窗口已正常结束，候选 host code 0、旧服务恢复成功；不再次暂停日常 Bot。用户确认真实恢复标记及文件写入成功，但 Pi 内置写文件没有请求授权，因此没有把它算作真实授权 UI 通过；入站图片、活跃生成停止尚未完成。

新 producer 首批 `async-d23f301a-5956-44ca-892b-527de5410314` 已失败，未进入生产/负载阶段。两平台构建成功（GNU `36bd5efa23e11bf4070f287af52a0273677a6aa29582cfecf247dc53cf37df40`、musl `89762aba33f4e14209c5b76186592f9efe04e82e223ed47b175c18b2dadb8074`），类型/audit/build 通过；格式检查包含了 runner 创建的 `candidate-gnu/manifest.json`，因生成 manifest 的格式停止。`failure-review.json` 独立核对原冻结输入、两个二进制及 manifest 散列。修正后台脚本将生成候选放入 `.test-results/p6/`，保持源码格式门禁和原失败记录，另起独立批次验证，不将本次构建成功当作回归通过。

## 失败 worker 设置修复后的当前候选（14 阶段通过）

真实 Telegram 首次模型失败后，配置路径复用了已关闭的 adapter sender，`set_model` 返回 `MailboxClosed`。现在选择 Configure sender 时要求 worker 未停止、监督任务未结束且 mailbox 未关闭；失败/冷会话直接持久化偏好，下次输入正常 load。没有重试未知远端配置副作用。新增确定性回归先红后绿，覆盖 model/mode、原 receipt replay、冷偏好及恢复原 native identity。

批次 `async-23a1d8c4-2ca0-41b2-a299-c9143396d47b` 正常完成，`review.json` 独立核对 391 个启动前冻结源码/runner、两个构建后冻结二进制及 manifest、288 个源码门禁后生成的 dist 文件，并核对 VSIX 内实际打包文件。源码门禁 Rust daemon 362 passed / 3 ignored，协议 2 passed，TS 38 files / 247 tests，runner 52 passed；类型/audit/build/format/clippy 全过。两平台生产矩阵各含 IPC 21、Telegram/IPC 28、容量、11 个 SIGKILL 窗口、32 次图片半帧交错、八项 provider barrier、Chromium 17、startup 和 artifact smoke。

实际 Pi SDK 1.3.0 离线验证仍为 18 guarded processes、0 network/model。在线仅运行已授权 Pi/Codex，各有实际文本、上下文续接、停止后 load 三个精确响应标记及正常 host shutdown；Pi 显式模型选择修正账户不支持的默认模型。此处 cancel 在空闲轮次后执行，不能冒称活跃生成停止。原生 VS Code 1.143.0 实际安装同一 VSIX，通过 15 项 UI 和 4 项 Trust；两端 answer/cancel 后迟到 answer/切会话旧按钮、撤销 trust 后任务保留及再授权恢复均有独立报告。它们使用 synthetic provider，不替代真实 provider 的交互请求证据。

| 阶段                   | 含准备耗时 秒 | 覆盖                                                            |
| ---------------------- | ------------: | --------------------------------------------------------------- |
| `gnu-full-mixed-five`  |        328.58 | GNU 五个独立完整工作集 host；3,082 成功 IPC，正常 SIGTERM/join  |
| `gnu-soak-600`         |        602.50 | GNU 快速 soak；89 rounds / 445 joined phases                    |
| `musl-full-mixed-five` |        344.70 | musl 五个独立完整工作集 host；1,955 成功 IPC，正常 SIGTERM/join |
| `musl-soak-600`        |        604.70 | musl 快速 soak；89 rounds / 445 joined phases                   |
| `gnu-full-mixed-7200`  |       7235.30 | GNU 同一 host 两小时；152,421 成功 IPC，正常 SIGTERM/join       |

两个 soak 各 89 rounds / 445 phases；合计独立核对 180 份 process-loss 报告，每份 11 个 kill 窗口、11 次预期 SIGKILL、5 次正常退出及 3 次预期 lease/AddrInUse 拒绝。两个图片 trace 各 32 次按 barrier/prefix/commit-revision receive/suffix 时序通过，不用于关闭所有历史 timeout。

两小时 GNU PID 775869 实际 7202.879 秒，6,627 rounds / 152,421 成功 IPC，模拟 HTTP 105,545 次、UI 1290 组；WAL 峰值/末值 35.02 MiB，末十分钟固定平台；1030 次 RESTART（成功 92、busy 938），max 20.685 ms、无错误。RSS max/end 129.31/113.14 MiB，首/末十分钟 median 94.61/111.94 MiB，不能宣称无泄漏；FD [70, 78]、threads [35, 35] 只覆盖 host，不是完整进程树或内部 owner/task/queue 平台。

| 两小时 IPC 往返口径        |   样本 | p95 ms | p99 ms | max ms |
| -------------------------- | -----: | -----: | -----: | -----: |
| `history`                  |   6627 |  56.66 |  62.04 |  72.91 |
| `content`                  |   6627 |  62.74 |  66.68 |  81.60 |
| `list`                     |   6627 |  62.23 |  66.06 |  81.10 |
| `idle_setting`             |   6627 |   1.38 |   1.69 |  31.92 |
| `cancel_including_join`    |   6627 |  21.50 |  27.88 |  43.83 |
| `prompt_including_capture` |   6627 |  22.38 |  27.72 |  76.13 |
| `image_4m`                 |   6627 |  87.15 |  92.06 | 109.38 |
| `export_slice`             | 106032 |  73.19 |  82.81 | 115.79 |

UI pooled render p95/p99/max 2.0/13.7/31.9 ms，input→rAF 17.2/18.4/35.2 ms；8193 个 long tasks，max 118 ms。成功往返、join 和 UI 分布不等于内部 admission/owner/SQL durable-fence SLO 或有效 P0 A/B。

当前批次通过不关闭待验表中的完整 provider 能力、在线 native cut/billing、全部 kill/expiry 组合、历史 timeout 归因或全进程树资源。P6 保持 `[~]`；不部署，不迁移真实 root，不再次暂停 Telegram。

### 真实在线补充能力与当前收尾边界

补充批 `async-bd04e53b-7001-4c6c-970f-e87f5654619b` 的原始整体状态为 failed：Codex 全项通过；Pi 的文本/模式/图片/活跃 cancel 通过，但脚本选择的 `P6_ONLINE_OK` 在 text 与 continuation 两个 Agent 消息中重复，fork 按唯一完整消息规则拒绝。`partial-review.json` 核对冻结输入、两个 host 正常退出及逐项通过证据。这个负例不能改成成功，也不能放松安全规则。

后续单 Pi 批 `async-b3f4225d-d7bb-4809-9566-8f3041a4aa54` 全部通过，`review.json` 独立核对冻结 runner/二进制与三个基础、图片、停止后恢复、branch 的六个精确响应标记。先明确断言重复正文 fork 拒绝，再选择唯一的完整 `P6_AFTER_CANCEL_OK` Agent 消息；实际创建独立 Pi native branch 并完成新模型响应，源 native 文件 SHA-256、不可变历史及 usage 保持不变，branch 在新 prompt 前 input/output/cost 都为 0 且 reported=false，原 fork receipt 重放不重复副作用。原生临时文件随隔离 profile 清理，只保留冻结 runner 的断言/散列与结构化报告，不冒称已留存原始 native 文件供离线重读。

Pi/Codex 都实际选择了 provider mode（Pi low、Codex read-only），输入自建 32×32 红色 PNG 并得到指定颜色响应；host 会净化/重编码 PNG，canonical archive 为 217 bytes、SHA `256f17a6…fee6`，与 raw 97 bytes 的 SHA 不同是预期，不能拿 raw hash 校验 canonical archive。Pi 后续明确通过 image 查询读回 canonical bytes 并验证 hash/长度/PNG/32×32；Codex 初次报告保存了已提交 canonical ref 和模型响应，未补读回二进制，不扩大其证据。两端均在真实 committed streaming output 且 active_turn 存在时 cancel，后续恢复原 native identity；Pi 后续往返（含 join）16 ms，Codex 272 ms，不当作内部 durable-fence SLO。实际 usage 有 reported/input/output/cache/context，cost_micros=0 不能解释为免费、准确账单或价格覆盖。

业务源码、两个 daemon 和生产 dist 未改变；只补验收 runner 与结果文档，因此沿用同散列 14 阶段/两小时证据，不机械重复长测。最终制品使用这套已测试 dist 重新封装最新文档，GNU/musl 各自解包核对，VSIX 安装入口另作实际验收；最终补丁重建、manifest 与证据散列以 `p6/final-status.json` / `p6/final-sha256sums.txt` 为准。

尚未关闭的项目分为：用户暂缓的 Claude；需要重新协调用户与服务窗口的真实 Telegram 入站图片/活跃 stop/扩展授权；仍需独立实现与测量的完整 provider 能力/在线 cut-billing 矩阵、内部 admission/owner/SQL 计时及有效 P0 A/B、完整 kill/expiry 组合、原历史 timeout 一一归因、全进程树及 owner/task/queue 资源平台。它们不能由当前通过项或总测试数推导完成。P6 继续 `[~]`，本轮不部署、不操作旧 root，不自动延长或重开 Telegram 停服窗口。

### 2026-10-23 Telegram 续验及新候选状态（替代上文待协调状态）

Claude 已由用户明确排除本次任务，不作为阻塞项。新 Telegram 窗口获准最多 30 分钟，实际 1534 秒提前结束；隔离候选正常退出 0，旧 `pi-telegram`、`pi-sessions` 恢复运行。独立证据 `.test-results/p6/live-telegram-9b8032ad2e/review.json` 核对全部控制输入终态、33 个 delivery 全部 Acked、真实生成中 stop 后 `P6_AFTER_STOP_OK`、等待 Form 时 stop、迟到回答拒绝且文件散列不变，以及无 worker 的 cold history/sync。

本轮暴露并修复 Pi 扩展文本输入桥接：原 permission 选项无法携带文本值，不能用模型声称 `P6_PERMISSION_OK` 代替真实工具结果。现使用标准 `elicitation/create`，调用固定 pi-acp SDK 0.26 的 `unstable_createElicitation`；真实用户提交 `P6_ALLOW` 后，持久 Form 值、实际工具成功及隔离文件均已核对。七项回归覆盖精确文本、取消/拒绝、无效/超长、空编辑器结果、请求失败以及固定 SDK 方法。新源码需要完整 bundle/安装回归；旧 GNU36/musl89/VSIX468 的报告仍是历史候选证明，旧 VSIX 不包含此次桥接修复。

原 OpenAI 请求失败归因为 OAuth 过期且 refresh 返回 invalid_grant；改用配置中可用的 `stable/gpt-6.1-sol` 后文本通过。Telegram 当前实现明确不支持入站图片，只接纳了图片说明文本，不计为图片输入通过。此次隔离写文件没有进入 workspace Diff，亦不将该路径算作 Diff 捕获证明。

内部诊断增补进行中：`WORKBENCH_DIAGNOSTICS=1` 才采集 admission/registry/owner 排队、owner durable fence 和 SQLite COMMIT 调用时间及 owner/task/queue 数；静态标签、固定直方图区间，正常 join 后输出一次。存储 executor 的 execution 仍包含 SQL、序列化和校验，不冒充纯 SQL；区间统计不冒充精确分位数。Linux 资源采样遍历所有线程的 children，汇总当时存活进程树，退出/重新托管的子进程不计为历史峰值证明。

资源短测发现真实缺口：`.test-results/p6/owner-churn-first.json` 显示连续 40 次冷加载保留 40 个 owner，仅在关闭时回落为零。测试正常 join，但运行中 owner 平台化未通过。保留失败证据，继续诊断安全回收，不能用较早的两小时 host RSS 报告豁免。新诊断源码尚未完成完整生产候选门禁，当前不更新最终通过散列或提升制品。

### 2026-10-23 owner 收敛修复与正式回归安排

诊断候选批次 `async-0e2dd69c-bcac-41d8-b2c6-33a3a9a082b0` 整体保留 failed：GNU `7fb20f40…`、musl `d0d4b7d9…` 两平台生产矩阵、源码门禁（Rust 363 passed/3 ignored、TS 39 files/254 tests）、离线 SDK、安装 VSIX native15/Trust4 与五轮完整混合负载通过，但 200 次冷加载保留 200 owner。`partial-review.json` 独立核对 393 输入、288 dist、两个候选/manifest、实际 VSIX bundle、九份专项报告及全部正常退出和预期 SIGKILL 窗口；失败不改成通过。

随后将 owner 改为目标 64 个的空闲 LRU 缓存。只有没有已排队/执行消息、活动轮次、未决交互、配置意图或物理 worker 附着的 owner 可退休。消息入队前计数，处理后才发布空闲快照并释放计数；关闭 sender 让 actor 自然排空，JoinSet 始终持有 join，且每次路由迭代回收已结束句柄。忙或 pinned owner 不为凑缓存数量被驱逐；临时总数仍受 ingress/worker/IO 预算约束，64 是可回收缓存目标，不是取消活动任务的硬限额。淘汰后命令通过有界 IO lane 原子重载，worker attach 与既有 load 共用同一 lane；provider 事件不触发隐式重载。取消立即隔离事件 epoch，但 worker 附着 pin 直到匹配 epoch 的物理 join 通知后才释放，旧通知不解除新 worker 的 pin。

定向回归 16 项通过，含冷加载平台化、淘汰后未预先 Load 的变更、受阻提交及排队消息、配置 pin、worker pin/迟到 join、attach 合并 load，以及 owner panic 后关闭根而非跨未完成写入重载。实际 debug 宿主短测：200 冷加载、80 次合成 warm 轮次和首会话 native 恢复，owner 峰值 64、owner task 峰值 65，关闭时均零；warm worker/adapter task 与槽位峰值均 1，81 个 prompt 精确一次，旧 receipt replay 无派发。证据为 `owner-cache-cold-green.json` 与 `owner-cache-warm-v3.json`。这些短测不是新 release、musl 或无 RSS 泄漏证明。

前两次 warm runner 失败保留：第一次漏 attach 导致无 revision 订阅超时，旧 runner 当时没有保留临时 root，此项原始证据不完整，不据此归因产品；第二次连续 attach 触及现有 32 订阅上限并返回 backpressure，完整 root/log/trace 已保留。runner 现逐会话 detach，不放宽生产预算，并在失败时保留原 root、全部宿主日志和合成 provider trace。正式批次将重新冻结源码，验证两平台冷/热 churn、更长 mixed/600 秒与 GNU 两小时回归；尚未完成前不更新最终通过状态或提升根制品。

### 2026-10-23 完整门禁发现合同回归后的修正

新 owner 候选批 `async-0d794dc0-c133-4490-b58e-37356a52ec89` 保留 failed。GNU `639d6768…`、musl `1c5a71b0…` 构建成功，源码的 type/audit/build/format/clippy 通过，但 workspace Rust 测试为 367 passed、2 failed、3 ignored，后续阶段及长测均未启动。`failure-review.json` 独立核对 396 冻结输入、两个二进制/manifest 和阶段日志；未完成 dist 冻结，不提升制品。

失败揭示两个既有合同被回收实现改变：单个 session actor 的 panic 应隔离，不能关闭整个 registry；cold list/inspect 不激活 owner，未经宿主 admission 的命令仍应要求显式 Load。保留两个原测试及要求，撤回“owner panic 关闭根”的改动；结束的 task 仍每轮非等待回收，但单个 actor panic 不升级为全局故障。只有应用 admission 路径使用内部 `command_admitted`/带 operation 的命令，允许缓存淘汰后的原子重载；这个标记随 registry lane 保存，不进入外部 IPC 或业务 JSON。普通 RegistryHandle `command` 保持显式加载合同。

修正后包括上述两个既有回归在内的 actor 相关 31 项通过，clippy 通过。新正式批次增加构建前的 workspace Rust 门禁以尽早捕获回归，完整 Rust 只跑一次，后续源码阶段继续验证 TS/格式/制品 bundle。新的两平台资源、真实在线及长测仍需冻结候选重新执行，不将这次失败改成通过。

## 2026-10-23 owner 生命周期修复后的完整回归与在线补测

当前 GNU `29005517…` / musl `9f2a1c1b…` 的父批为 `.test-results/p6/async-3bd17da8-ad7a-46bb-8f22-66f63d47b07d`。20 阶段中 19 阶段通过，Pi 在线 Form 阶段失败；原 `status.json` 和日志保持 failed。`partial-review.json` 独立核对 396 个冻结源文件、288 个实际构建 dist 文件、VSIX 中实际 bundle、173 份结构化报告及两个候选/manifest 散列。Rust 369 passed / 3 ignored、TS 254、runner 52、process-tree 1 均通过；两平台生产矩阵、八个 provider barrier、11 个 SIGKILL 窗口、实际离线 SDK 18 个零模型请求进程、已安装 VSIX 的 native 15 / Trust 4、Codex 真实 extended 均通过。

两平台各完成 2000 次冷加载、400 次 warm 轮转；warm 含首次 native 恢复，共 401 次实际 synthetic prompt，原 receipt 重放不重复执行。owner 峰值 64，owner/task 终态回到 0，warm worker/adapter/slot 峰值 1。逐会话 detach 保持原订阅限额；busy/active/授权/config/fork/物理 attached worker 均不可为了缓存限额强制回收。旧 epoch join 不解除新 worker pin。既有契约保持：单会话 actor panic 隔离；普通 registry command 仍须显式 Load，仅可信 app admission 可在淘汰后重载。第一版违背这两个契约的源门禁失败批 `async-0d794…` 保留，未修改原 actor 测试来绕过失败。

两平台五轮 full mixed 及各 600 秒 soak 通过；GNU 新候选同一 PID `1273814` 持续 7200.817741 秒、6072 轮、139656 个成功 IPC 请求，正常退出/join。全进程树采样为 17 个进程；host RSS 峰值 121.664 MiB、末值 118.547 MiB，首十分钟（排除第一分钟）与末十分钟中位数 91.783 / 97.090 MiB。末十分钟 WAL 42.863–51.185 MiB。1507 次 checkpoint 中 78 次未 busy，观测最大耗时 22.312 ms；配置的 20 ms busy wait 不等于调度后的总耗时不超过 20 ms。原始报告和 `long-resource-summary.json` 保留。以上证明该负载下的观测范围，不能宣称所有资源无泄漏；运行期固定分桶包含启动和尝试，不是成功 loaded 请求的精确 p95/p99。DB execution 含 SQL/codec，SQLite COMMIT 另计。

父批 Pi 在成功 native fork 后，独立 branch 占着唯一 worker 槽且可能自主唤醒，生产规则正确拒绝自动回收；source 的下一次 Form 探针因此收到持久化 WorkerCapacity。失败根 DB 保留且凭据 profile 清理。修正验收 runner：明确 cancel 这个隔离 branch，再启动 source Form；没有放宽生产回收规则或修改业务 bundle。

同候选补充批 `.test-results/p6/async-7dcaad18-e75d-4a24-909c-d24dd7f73c40` 两阶段通过，`review.json` 核对 682 个冻结文件与父批相同生产源码/dist/二进制，以及两归档解包各 32 项内部 checksum 和真实 artifact smoke。Pi 真实低 thinking、canonical 32×32 PNG 读取/颜色识别、活跃生成 cancel（18 ms 含 join）、同 native 继续、安全 native fork 全部通过；重复正文切点拒绝、源文件/history/usage 不变、branch 独立 identity、继承 usage 为零及原 fork receipt 重放均核对。真实 SDK Form 的 native 工具结果 authorized=true / isError=false / P6_PERMISSION_OK，确认授权后才写文件；等待第二个 Form 时取消约 19.94 ms 含 join，迟到回答拒绝、文件不变、原 answer receipt 重放通过。临时 native/profile 已清理，只保留冻结断言及脱敏结构化证据，不冒称可再次读取已删除文件。

本地管理变更的 commit 前/commit 后未观测 receipt、undo 文件发布后 settlement 失败再 SIGKILL 的专项已另用同候选后台调度；结果以实际补充批报告为准，不能预先标通过。当前根 dist/service-dist/VSIX/归档仍是旧候选，完成最终文档和制品复核前不提升。尚需明确关闭的范围包括：有意义的 P0 同机 A/B、历史间歇 timeout 一一归因、完整 provider 自主后台/能力受限矩阵、任意媒体/compaction native cut、外部账单对账及未覆盖的精确故障切点。Telegram 入站照片当前未实现，Claude 用户排除；二者不得写成已测通过。仅 runner/文档变化不机械重复已核对的两小时。

### 本地 mutation / undo 丢收据的实际进程补测

补充批 `async-35feab2e-b261-4473-88f6-d799d169f2c4` 两平台通过；`review.json` 核对 684 个冻结文件、runner/peer/两个二进制散列及每平台三次 SIGKILL 和最后一次 exit 0。SQLite writer lock 下的本地 rename 在 commit 前被杀：没有 operation row 或 title 变更；rename 已 commit、客户端没有观察 receipt 时被杀：重启查询 completed，原 command/operation 返回完全相同 receipt，只有一条 operation。真实 synthetic shell 修改产生完整 Diff 后，通过仅针对该 operation 的 SQLite 触发器使 undo settlement 失败，确认文件已经恢复、operation 仍 Started，再 SIGKILL；重启保留 uncertain，原 operation 拒绝重执行，后来文件内容保持不变。这是文件发布后的精确结算故障加真实进程丢失，**不是任意多文件发布中途的受控切点**。

首轮 `async-e9c6…` 的两个 rename 窗口已过，第三项因脚本把 wire 的 `complete` 写成 `Complete` 而失败；`failure-review.json` 核对原输入、DB 中实际 title 和正常 join，原失败 root/report/log 保留。只修正验收断言并补独立 title 断言，没有改生产代码。

## 最后能力补测与当时未闭合出口（历史快照，已由最终矩阵更新）

`async-5f610e79-0e7c-4a15-8810-9632ced9c834/partial-review.json` 独立核对 686 个冻结文件，Pi 六种实际 advertised thinking 设置逐个确认、无效 mode 拒绝、恢复 low 通过。所选 `stable/gpt-6.1-sol` 不在 Pi Fast 支持的 openai/openai-codex profile 内：实际目录隐藏 Fast，明确 `set_option` 拒绝且不修改设置，不能记为 Fast 模型调用通过。先前假设所有 profile 都提供 Fast 的探针失败完整保留。

Codex 最终单阶段批 `async-d5589f27-dd7f-42fd-b146-b3883d1bf4ee` 已通过，`review.json` 核对冻结源/runner/相同业务源码和 dist、实际响应及正常退出。四种 advertised mode（read-only/workspace-write/agent/agent-full-access）切换与无效值拒绝通过，恢复原 agent。Fast on/off 各有精确实际模型响应；物理 cancel 后 native load 先显示 provider 默认 off，但 host 持久偏好仍 on，**下一次 prompt 前重新配置后实际响应和目录恢复 on**，native identity 不变；无效 Fast 值拒绝，最后 off。不要把 native load 瞬间的 off 隐藏，或声称启动目录立即恢复了偏好。Plan collaboration 的真实设置、模型响应及恢复 default 通过；这不证明模型输出了非空 task Plan。早前模型多输出句号导致严格 marker 断言失败，原报告保留；只明确了无标点独立一行提示，未放宽断言。

同一批次当前 GNU small 工作集五轮通过，完整逐请求分布保留；P0 原样冻结 ELF（SHA `0c2765d3…`）在 small 第一轮 24 rounds 后 IPC closed，没有完整 run。旧 full 工作集也曾在八 lane 公平性屏障失败。因此两者均不能作为有效 P0 A/B，不生成回归百分比，也不拿未完成样本均值推导通过。P0 原临时构建源码目录已不存在，冻结二进制与旧报告散列一致；这里不声称重新构建了旧基线。当前候选 full 五轮和两小时结果独立成立。

本轮可执行验证已到最终制品阶段；将保持生产 bundle/二进制不变，只更新两份文档后重打归档和 VSIX、实际解包 smoke/安装验证并生成可重建源码补丁。根制品的最终提升以最终制品批 review 与当前 final-status 为准，不能用本段预先证明完成。

以下是明确的验收边界，P6 继续 `[~]`，不伪称完整出口通过：

- **用户排除**：Claude，不是等待凭据的阻塞项。
- **实现不支持**：Telegram 入站照片（caption/text 有界流程已验）、terminal stdout/stderr port（客户端 terminal:false）、当前 Pi stable profile 的 Fast；不能把这些写成成功能力。
- **证据不足**：有效 P0 可比分布；严格成功 loaded 请求内部阶段 p95/p99（已有启动/尝试合并固定分桶、SQLite COMMIT 独立计时）；历史所有 image/RPC timeout 的一一原始归因。缺失原始 trace 不会因重跑绿而补回。
- **有限专项之外仍未覆盖**：完整在线自主后台轮次与授权/恢复矩阵、任意工具/媒体/compaction native cut、外部账单核对，以及全部 expiry/dispatch/trust/多文件撤回部分发布切点组合。已测三 local loss/11 provider+HTTP loss/八 barrier/native15+Trust4 不外推任意组合。

无需为 runner/文档变化重复已通过的两小时；未部署、未迁移旧 root，真实 Telegram 旧服务已经恢复，不再要求用户发测试消息。

## 只读 P0 对照与过期/回答竞争补验（2026-10-23；后续出口见最终矩阵）

`async-65f54a5a-a4fc-478d-b788-636caa806f60/review.json` 独立核对 690 个冻结文件及全部原始样本。P0 冻结 ELF 与当前 GNU 同机交替五轮，每轮 10 次预热后采样 100 次 list/history/content 并发成功查询；每版每类 500 个样本，共 3000 个，20 次宿主正常退出。数据集均为 10000 会话、单会话 100000 条历史、1 MiB 正文及 4 MiB 图片 fixture。测量期无活跃 provider、UI 或 Telegram 调度，读取前后 operation/session/entry 计数不变。

| 查询         | P0 p95（ms） | 当前 p95（ms） |
| ------------ | -----------: | -------------: |
| list         |     1.483365 |       1.239932 |
| history      |     1.791394 |       1.650211 |
| content 分页 |     1.846521 |       1.662682 |

各类 median/p95/p99 均未发生超过 20% 的回退，list/history p95 低于 200 ms。独立复核从原始 samples 重算各 percentile，结果完全一致。这关闭普通并发只读查询的**窄范围同机对照缺口**，不关闭完整 mixed P0 比较；原 full 公平性失败与旧 small IPC closed 证据仍保留。

`async-c0087c5e-28a6-480c-8eb3-d8f53340ab47/review.json` 核对冻结文件和测试差异：仅在隔离 snapshot 的两个既有 cfg(test) 模块追加四个测试，根源码和测试不变。精确时钟 now=99/100/101、Permission/Elicitation 与 cancel 前后组合共 12 项边界通过。真实 owner + SQLite 测试另验证：过期回答不改变已提交状态；取消后迟到回答拒绝且 revision 不变；两个客户端同时回答只有一次成功和一次 revision 增长；cancel/answer 两个入队顺序最终清空 turn/interaction，后续回答不能再次提交。4 passed / 0 failed / 0 ignored。

这些是 domain/owner 边界证据；当前 ACP interaction 映射固定 expires_at=None，不能把注入测试当成真实 provider 截止时间透传，也未覆盖任意 trust/dispatch/expiry 的全部排列。完整 mixed 对照、精确成功 loaded 内部 SLO、原始 timeout 缺失 trace、完整在线自主流程/媒体 compaction cut 和外部账单等缺口继续保留。所有业务二进制与上轮相同，无需重跑两小时；新增文档的归档/VSIX 一致性另在本轮最终制品批核对。

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

仅验收 runner、测试扩展和文档更新；生产 GNU/musl/dist 与已验证两小时候选相同，不机械重跑两小时。最终发布候选仍需另行部署授权；日常服务已恢复，不迁移或清空旧 root。
