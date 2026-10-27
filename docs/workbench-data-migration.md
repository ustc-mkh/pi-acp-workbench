# 旧数据迁移与历史保留

本文说明从旧 daemon、旧 JSON 存储或较早开发版 SQLite root 切换到当前单宿主版本时，哪些数据能保留、哪些需要转换，以及如何避免重复执行任务。本文是操作方案，**不代表迁移工具已经实现，也不构成停止服务或操作真实数据的授权**。

## 当前能做什么

当前发布合同是 `ipc:3`、`storage:3`、`rootPolicy:new-root-no-migration`，没有旧格式 reader、`storage import` 或通用跨格式迁移。通过完整现有 v3 schema 与完整性校验的 2.0.x root，启动时可事务性新增模型价格倍率、context override/投影表及已删除会话标题列，保留历史、operation 和 Telegram 状态；这不代表任意早期 storage 3 root 都兼容。即使两个版本都标为 storage 3，缺少必需表/列或 payload 格式不同仍不兼容；不要修改 version marker、`PRAGMA user_version` 或手工补几列来强行启动。

- **只换机器/目录、继续使用完全相同的旧组合**：停机后完整备份，并在隔离副本验证。这是旧环境搬迁，不是向新版转换；还要核对绝对路径、账号权限和 provider native 路径。
- **开始使用新版，旧历史允许留在旧环境**：采用“新 root 启用、旧环境归档保留”。这是目前可执行的切换方式，旧会话不会自动出现在新版列表里。
- **要求旧会话、历史、统计、Telegram 绑定等进入新版**：需要先开发并验收一个针对确定旧版本的离线转换器。当前不能直接完成这种完整迁移，不能把 export、Markdown 或复制 native 文件当成导入器。

切换与回退的通用检查见[发布切换清单](workbench-cutover.md)，维护命令约束见[离线存储维护](workbench-storage.md)。

兼容 2.0.x 升级应先停止宿主，备份完整 root 及关联 Pi profile，再整体更新扩展、宿主与 adapter；不要主动清空历史。以下新 root/转换器流程针对不兼容的旧格式。

## 数据逐项处理

| 数据                                                       | 当前建议                                                        | 不会自动恢复的内容                                                                     |
| ---------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 宿主 root：会话、entries、归档正文/图片、operation/receipt | 保留完整旧 root 和匹配旧 binary；新版使用独立空 root            | 跨格式会话 identity、顺序、operation 防重记录                                          |
| provider 原生会话文件                                      | 另外备份实际使用的 native 文件、目录结构、适配器版本及路径关系  | 复制到磁盘不等于新版宿主已收养会话；`discover/load` 针对已登记会话，不是任意旧文件导入 |
| 历史 Markdown                                              | 用旧版本已有导出功能另存，供人工查阅                            | 工具状态、媒体原件、native cut identity、授权、receipt、可继续执行的上下文             |
| usage、价格覆盖、标题、偏好                                | 旧环境保留并导出可读报告；新版按需人工配置设置                  | 历史用量不能靠模型重放补算；不能将继承记录再次当新增费用                               |
| Telegram offset、inbox、outbox、callbacks、绑定、导出游标  | 与旧 root 一起保存；复用同一 Bot 前必须制定独立的积压与防重方案 | 新 root 不继承旧 update 高水位、已发确认或话题映射                                     |
| 工作区真实文件、Git 状态、未提交修改                       | 在 root 之外独立备份；记录切换时文件状态                        | root 备份不等于工作区备份，恢复 root 不会撤销工具已写入的文件                          |
| 配置、VSIX、binary、manifest、外部 worker 版本             | 保留匹配组合；新版配置按当前示例重新核对                        | 旧配置不能直接假定字段兼容；socket、workspace、worker 参数和 allowlist 需要确认        |
| provider/Bot 凭据                                          | 按原有凭据管理方式保留、核验权限；配置只记录环境变量名等引用    | 不打进源码、归档、迁移报告或聊天记录；不把凭据复制给不受信任目录                       |
| 未完成任务、待授权、Started/uncertain operation            | 原样保存证据，在旧环境查原 operation；确认外部效果后人工决定    | 不自动续跑，不换 ID 重发，不把丢失连接当回滚                                           |

## 旧格式切换流程：新 root 启用，旧历史保留

### 1. 盘点并确定是否接受历史分开保存

记录旧 binary/VSIX/worker 的版本与散列、配置位置、root、所有实际 native 文件位置、工作区路径，以及同一 Bot 是否还被其它进程接收更新。只记录位置和版本，不在报告里输出 secret。

若必须在新版界面看到并继续全部旧会话，或者必须无缝继承同一 Bot 的去重状态，停在此步，先完成下文的离线转换器方案。不要以创建空 root 假装满足了这两个要求。

### 2. 获得切换窗口后停止写入

停止接收新任务，查清已接受 operation。等待完成，或明确 cancel 并等待 provider/adapter 物理 join；对 uncertain 保留原 ID 和外部效果证据。关闭旧宿主及自动重启入口，确认没有其它进程继续写 root、native 文件或工作区。

保留 `.workbench.lock`，不删除它来绕过 lease。残留 socket 要先确认已无持有者并按对应版本规程处理，不能看到文件存在就认定它失效。Telegram 不允许两个接收器同时争用同一 Bot。

### 3. 备份完整旧组合并验证

优先使用**与旧 root 匹配且确实提供该命令的旧 binary**进行离线 export。例如：

```sh
/absolute/path/to/matching-old/pi-acp-workbenchd storage export \
  --root /absolute/canonical/old-root \
  --destination /absolute/existing-parent/new-private-backup --confirm
```

这是占位示例，不是针对本机服务的现成命令。目标父目录必须存在、备份目标必须是新路径且与源分离。export 复制字节并生成 `EXPORT-MANIFEST.json`，**不是转换数据格式**；它不包含 root 外的 native 文件、工作区或凭据。

若旧 binary 没有 export 或不支持该旧格式，不能改用新版 binary 强读。对已停写的完整旧目录另行做私有文件系统备份/一致性快照，并单独备份 native、工作区和旧制品配置。SQLite 不能只取 `workbench.sqlite3`：同时保留实际存在的 WAL/SHM sidecar；不要对正在写入的目录逐文件复制来冒充一致快照。

核对文件清单、大小和 SHA-256，将备份再放到隔离路径，用匹配旧组合验证会话和代表性历史可读。若需启动恢复副本，禁用 Telegram/真实 provider 及自动任务，防止验读触发发送或执行；旧版本没有这种隔离开关时，只做离线验读，不能直接启动它。原备份保持不变，不在唯一备份上演练。

### 4. 准备新版独立配置与空 root

使用当前 binary、匹配 VSIX 和当前配置示例，设置新的绝对 `storage.root`。人工核对 worker executable/args、workspace、权限、socket 和 allowlist；VS Code 指向新 root 的 `workbench.sock`，修改后重载扩展。先在隔离工作区验证创建、文本、历史读取、取消、重启和同 native 恢复。

旧历史继续由旧环境或导出文档查阅。不要把旧 journal/entries、SQLite 表、图片目录或 native ID 零散塞入新 root；它们有相互引用、hash、revision、身份和防重约束。

### 5. 单独决定 Telegram 的接续方式

新 root 的 Telegram 状态不认识旧 offset/inbox/outbox，**不能默认安全接续同一 Bot**。旧积压更新可能被重新接受，旧按钮可能指向不存在的会话，旧 Pending 发送与新发送也可能重叠。

验证阶段使用独立测试 Bot，日常 Bot 继续留在旧组合。正式复用日常 Bot 前，须停旧接收器，清点未接受更新、已接受未完成操作、未确认发送及话题绑定，明确哪些继续处理、哪些由用户决定放弃，并验证不会重跑已接受的 Agent 输入。不要擅自 `drop_pending_updates`、归零 offset 或删除 outbox；外部发送成功但未持久 ack 仍只能保留 at-least-once 边界。当前没有自动转换这些状态的工具，要求无缝接续时需要先实现并验收转换方案。

### 6. 切换与回退

授权后整组切换 binary、VSIX、配置、root 和 socket，再用小任务确认。记录切换时间，保留新旧两套数据和工作区变化，不自动续跑旧任务。

回退时停止新宿主、等待物理 join 并保存完整新 root 和未决 operation；恢复旧组合及其对应旧 root。**不得用旧 binary 打开新 root，也不得合并两个 root 的 journal/outbox/usage。** 新组合已经产生的文件修改、模型费用、Telegram 消息不会因回退消失；继续旧任务前要人工核对这些外部效果。

## 完整离线转换器需要满足什么

以下为待实现要求，不是当前可用 CLI。应针对盘点得到的具体旧格式制作单向转换，不恢复长期双 reader/双写兼容层。

1. **只读源、独立目标**：冻结旧 binary/config/root/native 的匹配备份与散列；转换只读取副本，拒绝写源、覆盖现有目标或启动 provider/Bot。先 dry-run 报告记录数、引用缺失、损坏和无法转换项。
2. **显式映射**：逐项定义 session/native identity、entry 顺序/消息边界、正文/图片 hash、工具/Plan、usage 来源、价格/标题/偏好及删除状态的映射。任何缺失或不可证明关系报错或明确列为未迁移，不能猜 cut、用摘要冒充原历史。
3. **防重和未知结果**：定义 operation ID/fingerprint/receipt、Telegram offset/inbox/outbox/绑定/callback/导出身份的映射。已接受操作不重新执行，未知远端结果不自动重试；旧待授权与过期按钮不能直接变成新授权。
4. **native 与费用**：证明 native 文件和 workspace 归属、适配器支持的 load 行为及源文件不变；不能重发全部 prompt 来重建会话。继承历史与新增 usage 分开，无法恢复的用量保持缺失，不造零或重复计费。
5. **可中断与可审计**：目标在全部验证前不可上线；失败保留报告和目标供诊断。恢复转换不得重复计数、重复发布文件或触发发送；提交完整目标后才允许人工切换。
6. **验收**：逐类记录数/引用/hash 检查，SQLite 完整性检查，代表性长历史/图片/工具/分支/usage 对照；验证未决任务不派发、旧 receipt 防重、Telegram 丢 ack 边界和迁移中断恢复。仅在隔离副本验证后，才安排真实切换窗口。

如果旧格式本身没有可靠的 operation、native identity 或发送确认，转换器也不能凭空补出“恰好一次”。应保留旧数据作为归档，在新版建立明确的新会话，并将不能续接的部分列入迁移结果供操作者接受。

## 执行前确认表

- [ ] 已确定“保留旧历史”还是“完整导入”，没有混淆两者。
- [ ] 已验证完整备份、匹配旧组合、native 文件和工作区的可恢复性。
- [ ] 旧任务/授权/未知远端结果有清单，未默认重放。
- [ ] 新 root 与旧 root 分离，配置、worker、权限和 socket 已确认。
- [ ] 若使用同一日常 Bot，积压、防重和绑定接续方案已验收；否则暂不切换该 Bot。
- [ ] 完整导入所需转换器确实存在并有针对本次旧版本的报告；否则只执行归档保留方案。
- [ ] 已另行获得真实切换授权，回退组合和外部效果核对方式明确。
