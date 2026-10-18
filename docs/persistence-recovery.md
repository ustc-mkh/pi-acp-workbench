# 持久化提交与恢复契约（workbench format 2）

本页只描述当前单宿主。旧索引/Diff reader、跨 daemon ack token、自动 orphan cleanup 和协议 v4 不适用于本实现。

## Durable ordering

| 组件           | 提交顺序与故障行为                                                                                                                                                                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Journal        | `operation` + typed command fingerprint → durable `Started` → 副作用 → immutable result → `Completed`/`Failed`。已开始但结果未知时不自动执行第二次；corrupt/missing/mismatched result、conflict、interrupted、expired 均 fail-closed。                     |
| History        | Actor 验证 epoch/reducer → immutable entry/interaction/image/notice archive → atomic versioned/checksummed snapshot（state + delivery intents）→ actor 换 state 并发布。保存失败不发布新 state；可能留下安全 orphan，不能产生已发布的 dangling reference。 |
| Revision       | session identity/cwd 必须保持；更低 revision、同 revision 内容冲突、checksum/format/ID 不匹配均拒绝。Cold inspect/list 不创建 worker，不进行 native load。                                                                                                 |
| Outbox         | 从 history ledger 投影到 typed record；durable admission sequence 决定 FIFO，不使用跨源 revision 当时钟。ack 保留 delivered tombstone，阻止 ledger 再投影并保留 sequence high-water。满容量时 ledger 继续持有未投影 intent。                               |
| Remove         | 先停止/join worker、drain actor，把 intents 转移到 outbox 后才 unlink history。归档继续保留；既有 session scope 不绕过当前 Telegram binding/chat/workspace 授权。                                                                                          |
| Telegram inbox | update offset、冻结 command 分类、callback consumption 原子提交。执行失败/重启不将旧 answer 重新解释为 prompt。通知进入 durable outbox 后 inbox 才 complete。                                                                                              |
| Cancel/config  | durable intermediate intent 在远端动作前；停止/恢复与最终 commit 失败不能谎报成功。worker physical join 和所有 accepted 文件事务完成后才释放 host lease。                                                                                                  |

IPC numeric request ID 只关联连接上的响应；durable `operation` 才负责跨连接/重启 replay。断开、超时和取消 observer 不证明副作用撤销，不自动换 operation 重发。普通 query 不写 journal；image query 禁止 operation，pixels 只在专用 response 中返回。

## 文件与媒体

History、journal、outbox、inbox 使用强类型 version/checksum 格式（history checksum 覆盖 state + intent ledger）；不接受 ACP/Telegram raw JSON 业务对象。图片 byte archive 自身另有格式、hash、MIME、size/identity/signature 验证。URI/path 不授权 fetch/read；signature 校验不是完整解码或 sanitization。Payload 外置，不进入 snapshot/event/journal 的 base64。

Multipart 投递为 at-least-once：部分发送成功、取消或响应未知时重试可能重复先前 parts，但不会重跑 Agent。不同 topic 可并发，同 topic 的 backoff head 阻止后续记录越过。

## 离线维护与保留

正常启动不自动迁移、reset 或扫描删除 orphan。所有数据目录由 host-wide flock 排他拥有；维护必须使用同一 binary 的 `storage` subcommand，不能 unlink `.workbench.lock` 绕过 lease。

显式 export、marker-only reset 与 typed Telegram GC 见 [存储维护](workbench-storage.md)。GC 仅原子删除 completed inbox 与不被 pending inbox 引用的 expired callbacks，保留 offset 和未过期的 consumed bindings。Archive reachability、projection ledger、outbox tombstone/high-water 的 GC 尚未实现，全部保留。Journal 的 typed `expire` API 先写 tombstone 再删除 result；不可直接手动删除 operation 收据来恢复执行。

整个 snapshot/list 暂无 paging，仍受 bounded IPC frame 限制；browser 的窗口化不是存储分页。三 provider 的真实 host SIGKILL 已有独立隔离测试：验证 stale socket 拒绝后，仅 fixture 显式确认并删除自己的死 host socket，随后 cold recovery、receipt/image 保持和同 native ID 继续。它不证明自动 stale-socket 恢复或任意 provider descendants 在 host 被杀后的清理。持续 synthetic soak 与短 gate 分开记录；长期磁盘故障、live provider/Bot、完整 storage retention 仍需额外证据。

## 验证入口

- `cargo test --manifest-path rust/Cargo.toml --workspace`：typed stores、actor commit failures、replay、cancel/config、recovery、joined cleanup。
- `npm run test:workbench:storage`：实际 binary 的确认、flock exclusion、私有 byte export、symlink/overlap、marker-only reset、corrupt-state refusal。
- `npm run test:contract:workbench` / `npm run test:contract:workbench:telegram`：真实 daemon + synthetic ACP/local mock Bot。
- [验收 ledger](rewrite-verification.md)：完整 gate 与独立 offline SDK 的当前证据，不把 historical baseline 当作 current release acceptance。
