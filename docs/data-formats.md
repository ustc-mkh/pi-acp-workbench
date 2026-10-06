# 磁盘数据格式规范

本文件冻结 `~/.pi/pi-acp-workbench/`（或 `--data-dir` 指定目录）下的全部持久化格式。Rust 重写与 TS 实现**并发读写同一目录**，因此以下均为字节级不变量；格式变更需要更新本文件、全部实现与 contract 测试。

通用约定：

- 目录一律 `0700`，文件一律 `0600`。
- 原子写入：内容先写 `<file>.<uuid>.tmp`（`0600`），成功后 `rename` 到目标文件；**durable** 写入（收据、Telegram 游标/绑定、outbox 终态、preferences）额外对文件 `fsync` 再 `rename`，随后对父目录 `fsync`。临时文件在任何路径都必须删除。
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
├── service.lock/                      # proper-lockfile 目录锁（daemon 单例）
├── history/
│   ├── index.json                     # 共享历史索引（原子 rename 提交）
│   ├── conversations/
│   │   └── <sha256(id + ':' + revision)>.json   # 完整快照
│   └── session-<sha256(id)>.lock/     # 活动会话租约锁
├── history.lock/                      # 索引事务锁
├── telegram/
│   ├── bot-<botId>.lock/              # bot 单实例锁
│   ├── bot-<botId>-chat-<chatId>.json # 绑定/游标状态
│   └── events/
│       └── <sha256(eventId)>.json     # 桌面→Telegram outbox 事件
└── preferences/
    └── <harness>.json                 # pi / codex / claude
```

## 2. 锁语义（proper-lockfile 兼容，重写前请对照 `proper-lockfile@4.1.2` 源码核实）

**不得改用 `flock`/`flockfile`**——mkdir 锁与 flock 互不感知，混用会导致双写。

- 锁 = 名为 `<target>.lock` 的**空目录**，以 `mkdir` 互斥（已存在 → `ELOCKED`）。
- 持有方每 `update=10000` ms 刷新锁目录 mtime；锁目录 mtime 距今超过 `stale=30000` ms 视为 stale，获取方可 `rmdir` 后重试获取。
- 心跳刷新失败（锁目录消失/被夺）→ 持锁方视为 compromised：立即停止并放弃提交，不得再写数据文件。
- 用途三处：`history.lock`（索引事务，读改提交全程持有）、`history/session-<sha256(id)>.lock`（活动会话独占租约，抢占失败报"会话正在另一个窗口中使用"）、`service.lock` 与 `telegram/bot-<id>.lock`（进程单例，`retries:0` 直接失败）。
- 会话索引写事务规则：先 commit `index.json`（含 tombstone）再删除/修改快照文件——失败不得复活已删历史。

## 3. `history/` 共享历史

### index.json

```json
{"sessions":[<SnapshotStub>], "deleted":[<sessionId>], "nextSessionNumber":<int>}
```

`SnapshotStub` = 完整 Snapshot 去掉 `entries`/`nativeForks`（或置 `entries:[]`）并带 `stored:true`。`deleted` 是墓碑列表：已删 id 不得复活保存。

### 快照文件 `conversations/<sha256(id:revision)>.json`

完整 `Snapshot`（含 `entries`）。读取时校验 `id`/`cwd`/`entries` 一致性、`harness` 合法且与 ID 命名空间匹配、`contextComplete===true`，且**共享版本必须带 `revision`**；任何不满足即拒绝读取。

Snapshot 字段：`id`、`cwd`、`title`、`updated`(ms)、`entries`、`harness`、`sessionNumber`、`revision`、`conversationId`（fork 前原会话 id，编号按此归属）、`contextWindow`、`contextComplete`、`configs`、`modes`、`commands`、`nativeForks`、`stored`。未知字段容忍；必需字段缺失即拒绝。

乐观锁：`read` 记录 `seen[id]=revision`；`write` 要求持租约且当前 `revision` 等于 `seen`，写时生成新 `revision`（UUID），旧版本文件在 index commit 后删除。

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

写入方是 session-service（durable 终态），消费方是 telegram-daemon（`consume` 成功后删除）。消费方跳过：mtime >7 天（自动清除）、>16 MiB、字段类型不符、`sha256(event.id)` 与文件名不符的事件。

## 6. `preferences/<harness>.json`

```json
{"version":1,"preferences":[{"kind":"model|thinking","value":"<string>"}]}
```

最多 2 项、kind 不重复。新建会话读取并应用；格式不符报错且**不覆盖**原文件。扩展端写 codex/claude，服务写 pi——同文件双写者，必须原子写。

## 7. 第三方/不归本规范

- `pi-adapter` 的状态目录（`PI_ACP_WORKBENCH_STATE_DIR` 或 `~/.pi/pi-acp`）的 `session-map.json` 由 JS 适配器持有（`mutateAdapterStore` 事务），Rust daemon 不直接读写。
- Pi 原生会话文件（`.jsonl`）由 Pi 进程持有；native-fork 流程只读复制 + 校验，不修改源文件（见 `native-branch.ts` 与 `pi-native-fork.ts`）。

## 8. nativeForks / fork 哈希

`_pi_workbench/inspect` 返回的 `forkPoints` 与 `_pi_workbench/fork` 的 `hash` 校验依赖 `native-branch.ts` 的确定性计算：按 leaf→root 取原生历史链 → `canonicalEntries`（剔除 `label` 节点、label→下一节点 id 映射、剥离 `parentId`、compaction 的 `firstKeptEntryId` 重映射）→ 逐节点 `JSON.stringify` 连接（`,` 分隔）做流式 SHA-256 得前缀 hash。Rust 移植时必须对同一组 fixtures 得到逐比特一致的 hash——把 `test/native-branch.test.ts` 的用例导出为 JSON fixtures 供 Rust 侧断言。
