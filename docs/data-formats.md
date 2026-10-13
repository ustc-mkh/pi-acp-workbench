# 磁盘数据格式规范

本文件冻结 `~/.pi/pi-acp-workbench/`（或 `--data-dir` 指定目录）下的全部持久化格式。历史由 Rust session daemon 独占读写；Telegram 和 Pi 适配器各自维护下述独立文件。格式变更需要更新本文件、对应实现与 contract 测试。

通用约定：

- 目录一律 `0700`，文件一律 `0600`。
- 原子写入：内容先写 `<file>.<uuid>.tmp`（`0600`），成功后 `rename` 到目标文件；**durable** 写入（历史索引及完整快照、adapter registry、原生分支文件头、收据、Telegram 游标/绑定、outbox 终态、preferences）额外对文件 `fsync` 再 `rename`，随后对父目录 `fsync`。临时文件在任何路径都必须删除。
- 所有哈希文件名均为**小写 hex SHA-256**。
- 损坏/不兼容文件原则：报错并保留原文件，不迁移、不补字段、不静默删除。

## 1. 目录布局

```
<data-dir>/
├── service/
│   ├── sessions.sock                  # socket，0600；见 service-protocol.md
│   └── requests/
│       ├── <sha256(requestId)>.json   # 请求收据
│       ├── session-<sha256(sessionId)>.json  # 每会话最近一次收据副本
│       └── results/<sha256(result-json)>.json  # 大结果的不可变正文
├── service.lock/                      # mkdir 目录锁（daemon 单例）
├── history/
│   ├── index.json                     # 共享历史索引（原子 rename 提交）
│   ├── conversations/
│   │   └── <sha256(id + ':' + revision)>.json   # 完整快照（Diff 正文可通过引用保存）
│   └── diffs/
│       └── <sha256(diff-json)>.json     # 不可变 Diff 正文
├── telegram/
│   ├── bot-<botId>.lock/              # bot 单实例锁
│   ├── bot-<botId>-chat-<chatId>.json # 绑定/游标状态
│   └── events/
│       └── <sha256(eventId)>.json     # 桌面→Telegram outbox 事件
└── preferences/
    ├── <harness>.json                 # pi / codex / claude
    └── title.json                     # {"model":""}，Pi 自动标题模型
```

## 2. 单实例与原子提交

`service.lock` 与 `telegram/bot-<id>.lock` 是 daemon 单实例 mkdir 锁，10 秒更新、30 秒过期。锁失效立即停止服务。历史目录仅由 session daemon 写入，进程内 mutex 保护事务；不再有 history.lock、session 文件租约或跨语言历史锁协议。不要让旧插件与新 daemon 同时写入数据目录。

## 3. `history/` 共享历史

### 写路径（协议 v4）

所有 harness 的 worker 与历史写入都在 daemon 中。客户端通过 socket list/state 读取，通过 historyRemove 删除，不支持委托快照写入或磁盘降级。

### index.json

```json
{"sessions":[<SnapshotStub>], "deleted":[<sessionId>], "nextSessionNumber":<int>}
```

写入完整快照并同步文件及快照目录后，才提交 durable 索引；索引在同步临时文件后原子 rename，提交后同步索引目录。索引必须含 `sessions` 和 `deleted`，未知字段或错误类型会被 Rust 拒绝，原文件保留。

`SnapshotStub` = 完整 Snapshot 的 `entries` 置为空数组、移除 `nativeForks` 与 `usageRecords`，并带 `stored:true`。`deleted` 是墓碑列表：已删 id 不得复活保存。

### 快照文件 `conversations/<sha256(id:revision)>.json`

完整 `Snapshot`（含 `entries`）。读取时校验 `id`/`cwd`/`entries` 一致性、`harness` 合法且与 ID 命名空间匹配、`contextComplete===true`，且**共享版本必须带 `revision`**；任何不满足即拒绝读取。

自动命名另有可选 `titleAttempted:true`、`titleSource:"generated"|"agent"` 元数据：尝试标记在额外模型调用前提交，避免重启重放；titleSource 让后续保存保留语义标题而非覆盖为首条输入。旧会话不自动补生成。`preferences/title.json` 内容为 `{model:string}`，默认空字符串跟随 Pi 当前模型，`off` 关闭，其余为 provider/model；上限 4 KiB，损坏时拒绝启动且不覆盖原文件。标题模型更新使用 durable 原子写入。

Snapshot 字段（含可选项）：`id`、`cwd`、`title`、`updated`(ms)、`entries`、`harness`、`sessionNumber`、`revision`、`conversationId`（fork 前原会话 id，编号按此归属）、`contextWindow`、`usage`（`{used:number|null,size:number}`，当前 context 占用，非累计计费）、`contextComplete`、`configs`、`modes`、`commands`、`nativeForks`、`usageRecords`、`stored`。未知字段容忍；必需字段缺失即拒绝。

乐观锁：`read` 记录 `seen[id]=revision`；`write` 要求拥有进程内运行时且当前 `revision` 等于 `seen`，写时生成新 `revision`（UUID），旧版本文件在 index commit 后删除。

`sessionNumber` 分配：同一 `conversationId||id` 复用已有编号；否则取 `nextSessionNumber`（缺省 1）与现有最大编号+1 的较大者，写回 `nextSessionNumber=number+1`。

### Diff 正文引用

TurnDiff 可带 `contentRef`（64 位 hex）。此时 files 保留路径、状态、行数、权限和省略原因，before/after/patch 位于 `diffs/<contentRef>.json`。正文以完整 TurnDiff 的 Rust 紧凑 JSON 序列化求 SHA-256，先 durable 写正文，再提交引用快照；读取时验证哈希。单份正文读取上限 32 MiB。旧 inline Diff 继续可读；新提交保存引用格式。

`historyBefore` 只描述 socket 窗口，不是磁盘历史裁剪。删除历史后不可达 Diff 正文在下一次正常启动回收；活跃服务期间不清理尚未提交的内容引用。启动先验证全部已引用快照和正文，失败时保留证据。完整契约见 [持久化与恢复](persistence-recovery.md)。

## 4. `service/requests/` 任务收据

```json
{"id":"<requestId>","sessionId":"...","fingerprint":"<sha256 hex>","status":"running|completed|completed_ref|interrupted","result":<any>?,"resultRef":"<sha256 hex>"?,"error":"<string>"?}
```

- `fingerprint` = `sha256(JSON.stringify(canonical({method,params})))`；`canonical` 把对象 key 按 **UTF-16 code unit 序**（JS `<` 字符串序）递归排序，数组顺序保留，所有值参与。**Rust 注意**：键排序按 UTF-16 而非 UTF-8 字节序（BMP 与代理项混排时不同）。
- 收据文件上限 256 KiB；`id`/`sessionId`/`status`/`fingerprint`(64 hex) 格式校验失败即拒绝执行。超出收据容量的成功结果存到 `results/<sha256>.json`（上限 64 MiB），哈希基于 Rust 紧凑 JSON 原始字节；先 durable 写结果，再提交仅含 `resultRef` 的 `completed_ref` 收据。`result` 与 `resultRef` 不得同时出现；读取正文有界并校验哈希，缺失/损坏拒绝返回缓存结果，绝不重跑操作。
- `completed_ref` 在服务内部等同于 completed，线协议结果不变。旧 daemon 不认识此状态，会拒绝读取/启动，不会误将已完成大结果返回为 null；使用外置结果后回滚旧 daemon 必须恢复升级前备份。旧 inline 收据继续可读，不迁移原文件。
- `session-<hash>.json` 是同会话最近一次收据副本，用于启动时报告"上次任务被服务中断"；两者写顺序：先收据后标记。
- 生命周期：执行前 `running` → `completed`/`completed_ref`/`interrupted`。daemon 重启把残留 `running` 标记为 `interrupted` 并写一条 `failed` outbox 事件。**已完成/中断收据保留 30 天后由启动清理删除**（防重放窗口，见 session-service.md）。结果正文只在无收据/最近标记引用且超过 30 天后清理；近期孤立结果保留作提交失败的证据，无法确认引用关系时停止清理。

## 5. `telegram/` 状态

### `bot-<botId>-chat-<chatId>.json`

```json
{"version":1,"botId":<int>,"chatId":<int>,"offset":<int>?,
 "topics":[{"sessionId":"...","threadId":<int>}],
 "delivered":[<eventId>…最近2000],
 "notifications":<bool>?,"silent":<bool>?,
 "historySent":{"<sessionId>":[<sha256 hex>…]}}
```

新增可选 `inbox:[{id,update,phase,prompt?}]`，为空时省略，旧文件缺省为空。`phase` 为 `pending|started|interrupted`；`prompt` 仅保存 `/interrupt` 取消完成后的替代提示词。接收 update 与 offset 同一原子事务提交；id 必须唯一、等于 update.update_id 且小于 offset，最多 136 条。执行前 durable 标记 started，成功处理后移除。重启将 started 转为 interrupted 并告知结果未确认，不重放；pending 才可继续执行。

校验失败即拒绝启动（不重放旧任务）。`topics` 在 daemon 启动时剔除已不存在会话的绑定（会话服务不可用时跳过，保留绑定）。

### `events/<sha256(eventId)>.json`（outbox）

```json
{"id":"service:<requestId>|uuid","sessionId":"...","cwd":"...","title":"...",
 "sessionNumber":<int>?,"inputText":"<桌面端用户输入>"?,"text":"...",
 "status":"running|completed|cancelled|failed","error":"<string>"?,"updated":<ms>}
```

此目录是 session-service 的内部存储，由服务写入（durable 终态）并删除。telegram-daemon 仅通过 socket 消费；`events.ack` 使用事件 ID 和读取版本的 token 比较后删除并 fsync 目录，陈旧确认不会删除更新版本。服务读取时跳过：mtime >7 天（自动清除）、>16 MiB、字段或类型不符、`sha256(event.id)` 与文件名不符的事件；损坏文件保留供检查。

## 6. `preferences/<harness>.json`

```json
{ "version": 1, "preferences": [{ "kind": "model|thinking", "value": "<string>" }] }
```

最多 2 项、kind 不重复。新建会话读取并应用；格式不符报错且**不覆盖**原文件。所有 harness 均由会话服务独占 durable 原子写入。

## 7. 第三方/不归本规范

- `pi-adapter` 的状态目录（`PI_ACP_WORKBENCH_STATE_DIR` 或 `~/.pi/pi-acp`）的 `session-map.json` 由 JS 适配器持有（`mutateAdapterStore` 事务），Rust daemon 不直接读写。
- adapter registry 的 session 记录可含 `workbenchFastMode: "on" | "off"`，缺省不恢复 Fast 设置，非法值拒绝恢复且保留原文件；仅用于 Pi 尚未持久化对话的空会话。已有对话或 Fast custom 节点时原生分支优先。原生 `customType: "pi-acp-workbench/fast-mode"` 节点使用 `data: {version:1, enabled:boolean}`，不进入模型上下文；按 leaf 的 parent 链寻找最近设置，不使用其他分支节点。registry upsert 保留此可选字段，写入沿用已有锁与 durable 原子提交。
- Pi 原生会话文件（`.jsonl`）由 Pi 进程持有；native-fork 流程只读复制 + 校验，不修改源文件（见 `native-branch.ts` 与 `pi-native-fork.ts`）。

## 8. nativeForks / fork 哈希

`_pi_workbench/inspect` 返回的 `forkPoints` 与 `_pi_workbench/fork` 的 `hash` 校验依赖 `native-branch.ts` 的确定性计算：从 leaf 沿 parentId 回溯、检查完整性与重复后反转成 root→leaf 顺序 → `canonicalEntries`（剔除 `label` 节点、label→下一节点 id 映射、剥离 `parentId`、compaction 的 `firstKeptEntryId` 重映射）→ 逐节点 `JSON.stringify` 连接（`,` 分隔）做流式 SHA-256 得前缀 hash。当前原生树安全校验与前缀哈希只有 TS 实现；Rust `native.rs` 将已校验 forkPoints 绑定到显示条目，不重新生成原生树哈希。冻结样例由 `npm run fixtures` 导出，`test/native-fixtures.test.ts` 校验输出；Rust canonical 请求指纹与 UTF-16 wire 各自有兼容性测试。样例说明见 [Fixtures](../test/fixtures/README.md)。

用户显示条目可包含 `sendError?: string`，表示该输入被拒绝、未进入模型上下文；消息显示“发送失败”和左侧淡红色感叹号。服务端输入条目使用 `input:<requestId>` 关联一次发送，失败收据重放仍为失败；拒绝条目不计作实际首次输入、不绑定原生分支，也不作为完成通知的输入。客户端在 UI 准入阶段拒绝的条目仅作为会话作用域内的本地显示，不写入模型历史。

通用任务事件由 `pi-acp-core::TurnEvent` 同时供 outbox 写入与 socket 消费，磁盘格式仅由会话服务管理。可选 `pendingPermissions` 和 `nonTextBlocks` 均为非负计数，缺省为 0，服务不拼接通知呈现文案。工具条目可附 `terminal`（id/output/cwd/exitCode/signal/truncated），用于流式输出与恢复查看。

### 客户端模型价格偏好

价格偏好位于 VS Code `ExtensionContext.storageUri` 目录的 `price-overrides.json`；无工作区存储目录时使用 `globalStorageUri`（无工作区窗口共享此文件）。文件格式为 `{version:1, overrides:{"<模型 ID>":Price|null}}`，`Price` 包含 `input/output/cacheRead/cacheWrite/source`；`null` 是恢复默认的持久化标记。上限 4 MiB / 10000 个模型，损坏或超限拒绝写入并保留原文件。

写入使用 proper-lockfile 的跨进程锁，锁内重新读取最新文件、只修改目标模型，然后 durable 原子替换并释放锁；不同模型的写入合并，同一模型按事务提交顺序覆盖。文件尚不存在时只读兼容 Memento 的旧 `prices` 表和 `price:<模型 ID>` 键，首次成功提交一并迁移；文件存在后以文件为唯一价格来源，不再导入其他窗口的旧缓存，也不写回 Memento。备份需包含该文件；旧客户端不读取它，回滚后不会看到新格式保存的价格。

### 客户端模型显示偏好

模型显示偏好位于 VS Code `ExtensionContext.globalStorageUri` 目录的 `model-visibility.json`，同一扩展存储范围内的工作区窗口共享。文件格式为 `{version:1, preferences:{pi:{hidden:["<模型 ID>"]},codex:{hidden:[]}}}`，按 harness 保存隐藏名单；空隐藏名单是显式重置，不再导入旧缓存。文件上限 4 MiB，每个 harness 最多 10000 个模型，损坏或超限拒绝写入并保留原文件；显示路径回退旧 Memento 值并报告错误。

写入使用跨进程锁，锁内重读最新文件，仅修改本次操作的模型，durable 原子提交；目录外的隐藏模型继续保留，新加入的模型不会因旧页面提交而被隐藏。Webview 提交包含 `affected`（本次操作的模型）、`models`（其中应显示的模型）和 `sessionId`；过期会话提交被忽略，缺少 `affected` 的旧版全量勾选提交被拒绝。

文件不存在时兼容读取旧 `globalState.visibleModels`（测试或没有 globalState 的宿主回退 workspaceState）。首次成功写入导入各 harness 的旧偏好；旧白名单仅在该 harness 有已知目录并保存时转成隐藏名单，其他 harness 的白名单保持原样。显示路径不执行迁移写入。备份需包含该文件；旧客户端不读取新文件，回滚后不会看到新保存的显示设置。

### Codex / Claude 用量记录

完整会话快照可包含 `usageRecords`（旧快照缺省为空），每条包含 `id/sessionId/model/timestamp/kind/input/output/cacheRead/cacheWrite`。`kind` 为 `acp-turn`，Pi 独立标题调用返回的用量为 `session-title`；输入、缓存读写和输出分别计数，推理不重复加入输出。记录仅保存适配器返回的数据，缺少可选缓存字段时按协议缺省值 0 汇总，不代表供应商账单完整。记录不写入索引，也不随状态广播发送，通过 `_pi_workbench/inspect` 分页读取。上下文占用仍在独立 `usage.used/size` 中。
