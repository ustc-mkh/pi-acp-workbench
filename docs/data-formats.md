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
│       └── session-<sha256(sessionId)>.json  # 每会话最近一次收据副本
├── service.lock/                      # mkdir 目录锁（daemon 单例）
├── history/
│   ├── index.json                     # 共享历史索引（原子 rename 提交）
│   ├── conversations/
│   │   └── <sha256(id + ':' + revision)>.json   # 完整快照
├── telegram/
│   ├── bot-<botId>.lock/              # bot 单实例锁
│   ├── bot-<botId>-chat-<chatId>.json # 绑定/游标状态
│   └── events/
│       └── <sha256(eventId)>.json     # 桌面→Telegram outbox 事件
└── preferences/
    └── <harness>.json                 # pi / codex / claude
```

## 2. 单实例与原子提交

`service.lock` 与 `telegram/bot-<id>.lock` 是 daemon 单实例 mkdir 锁，10 秒更新、30 秒过期。锁失效立即停止服务。历史目录仅由 session daemon 写入，进程内 mutex 保护事务；不再有 history.lock、session 文件租约或跨语言历史锁协议。不要让旧插件与新 daemon 同时写入数据目录。

## 3. `history/` 共享历史

### 写路径（协议 v3）

所有 harness 的 worker 与历史写入都在 daemon 中。客户端通过 socket list/state 读取，通过 historyRemove 删除，不支持委托快照写入或磁盘降级。

### index.json

```json
{"sessions":[<SnapshotStub>], "deleted":[<sessionId>], "nextSessionNumber":<int>}
```

写入完整快照并同步文件及快照目录后，才提交 durable 索引；索引在同步临时文件后原子 rename，提交后同步索引目录。索引必须含 `sessions` 和 `deleted`，未知字段或错误类型会被 Rust 拒绝，原文件保留。

`SnapshotStub` = 完整 Snapshot 去掉 `entries`/`nativeForks`（或置 `entries:[]`）并带 `stored:true`。`deleted` 是墓碑列表：已删 id 不得复活保存。

### 快照文件 `conversations/<sha256(id:revision)>.json`

完整 `Snapshot`（含 `entries`）。读取时校验 `id`/`cwd`/`entries` 一致性、`harness` 合法且与 ID 命名空间匹配、`contextComplete===true`，且**共享版本必须带 `revision`**；任何不满足即拒绝读取。

Snapshot 字段：`id`、`cwd`、`title`、`updated`(ms)、`entries`、`harness`、`sessionNumber`、`revision`、`conversationId`（fork 前原会话 id，编号按此归属）、`contextWindow`、`usage`（`{used:number|null,size:number}`，当前 context 占用，非累计计费）、`contextComplete`、`configs`、`modes`、`commands`、`nativeForks`、`stored`。未知字段容忍；必需字段缺失即拒绝。

乐观锁：`read` 记录 `seen[id]=revision`；`write` 要求拥有进程内运行时且当前 `revision` 等于 `seen`，写时生成新 `revision`（UUID），旧版本文件在 index commit 后删除。

`sessionNumber` 分配：同一 `conversationId||id` 复用已有编号；否则取 `nextSessionNumber`（缺省 1）与现有最大编号+1 的较大者，写回 `nextSessionNumber=number+1`。

## 4. `service/requests/` 任务收据

```json
{"id":"<requestId>","sessionId":"...","fingerprint":"<sha256 hex>","status":"running|completed|interrupted","result":<any>?,"error":"<string>"?}
```

- `fingerprint` = `sha256(JSON.stringify(canonical({method,params})))`；`canonical` 把对象 key 按 **UTF-16 code unit 序**（JS `<` 字符串序）递归排序，数组顺序保留，所有值参与。**Rust 注意**：键排序按 UTF-16 而非 UTF-8 字节序（BMP 与代理项混排时不同）。
- 文件上限 256 KiB；`id`/`sessionId`/`status`/`fingerprint`(64 hex) 格式校验失败即拒绝执行。
- `session-<hash>.json` 是同会话最近一次收据副本，用于启动时报告"上次任务被服务中断"；两者写顺序：先收据后标记。
- 生命周期：执行前 `running` → `completed`/`interrupted`。daemon 重启把残留 `running` 标记为 `interrupted` 并写一条 `failed` outbox 事件。**已完成/中断收据保留 30 天后由启动清理删除**（防重放窗口，见 session-service.md）。

## 5. `telegram/` 状态

### `bot-<botId>-chat-<chatId>.json`

```json
{"version":1,"botId":<int>,"chatId":<int>,"offset":<int>?,
 "topics":[{"sessionId":"...","threadId":<int>}],
 "delivered":[<eventId>…最近2000],
 "notifications":<bool>?,"silent":<bool>?,
 "historySent":{"<sessionId>":[<sha256 hex>…]}}
```

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
- Pi 原生会话文件（`.jsonl`）由 Pi 进程持有；native-fork 流程只读复制 + 校验，不修改源文件（见 `native-branch.ts` 与 `pi-native-fork.ts`）。

## 8. nativeForks / fork 哈希

`_pi_workbench/inspect` 返回的 `forkPoints` 与 `_pi_workbench/fork` 的 `hash` 校验依赖 `native-branch.ts` 的确定性计算：按 leaf→root 取原生历史链 → `canonicalEntries`（剔除 `label` 节点、label→下一节点 id 映射、剥离 `parentId`、compaction 的 `firstKeptEntryId` 重映射）→ 逐节点 `JSON.stringify` 连接（`,` 分隔）做流式 SHA-256 得前缀 hash。Rust 移植时必须对同一组 fixtures 得到逐比特一致的 hash——把 `test/native-branch.test.ts` 的用例导出为 JSON fixtures 供 Rust 侧断言。

通用任务事件由 `pi-acp-core::TurnEvent` 同时供 outbox 写入与 socket 消费，磁盘格式仅由会话服务管理。可选 `pendingPermissions` 和 `nonTextBlocks` 均为非负计数，缺省为 0，服务不拼接通知呈现文案。工具条目可附 `terminal`（id/output/cwd/exitCode/signal/truncated），用于流式输出与恢复查看。
