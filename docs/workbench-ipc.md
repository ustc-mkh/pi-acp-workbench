# 本地 IPC v3

宿主在 `<storage.root>/workbench.sock` 提供 Unix socket，权限 0600，并检查对端 UID。这是同账户本地接口，客户端需与宿主使用配套协议；不会回退到旧协议或自动启动 daemon。

## 请求、回执与错误

使用 UTF-8 NDJSON。每个请求包含 `version: 3`、连接内不复用的安全整数 `id` 和 `command`；mutation 另带跨连接持久化的字符串 `operation`。

```json
{"version":3,"id":1,"command":{"method":"create","harness":"Pi","cwd":"/absolute/workspace"},"operation":"example-create"}
{"version":3,"id":2,"command":{"method":"list"}}
{"version":3,"id":3,"command":{"method":"attach","session":"SESSION_ID"}}
```

mutation 返回 `type: reply` 和类型化 receipt；普通查询返回 `type: query`、`result: {kind,value}`；图片使用 `type: image`；错误使用 `type: error`、请求 ID、code 和 message。

相同 operation 和参数返回原已提交结果，不同参数拒绝。prompt 的 Accepted 只表示输入已持久接受，不表示模型执行成功。`operation {operation}` 查询 `unknown`、`uncertain`、`expired`、`completed` 或 `failed`；断线或未知结果不授权自动重新发送。

## 输入和设置

`prompt {session,prompt:{parts:[...]}}` 使用有序 parts：

- `{type:"text",text}`
- `{type:"context",id,name,text}`
- `{type:"image",asset:IMAGE_ASSET}`

最多 10 parts、8 个 context、1 张 4 MiB 原始图片。文本加 context 最多 100000 个 Unicode 标量；单个 context 最多 64 KiB，全部 context 最多 80000 标量。图片能力协商、解码和重新编码在接受前完成，输入与归档引用同事务持久化。

`set_model`、`set_mode` 和 `set_option {session,id,value}` 只接受实际 provider 选项。catalogue 最多 32 个 select、每项 500 个 choice、总计 128 KiB。配置流程持久准备状态并确认 provider 观察值，未知结果不自动重试。

`manage {session,action}` 提交重命名、模型价格/可见性、命名策略或 Pi context 设置。`model_config` 可一次保存价格、倍率、可见性和 context。完整字段以 `src/workbench-protocol.ts`、Rust `domain/command.rs` 和 `domain/management.rs` 为准。

## 查询接口

| 查询                                                 | 行为与预算                                                             |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `inspect {session}`                                  | 热视图，不含完整历史和工具正文；冷查询不创建 actor                     |
| `list {cursor?,limit?}`                              | 默认 50、最多 100 个摘要，游标固定初始最大序号                         |
| `history {session,cursor?,limit?}`                   | 默认 100、最多 200 条，向旧历史分页、页内升序                          |
| `history_turns {session,cursor,turns}`               | 最多 20 轮、每页 200 条；超大单轮用 `partial` 标明前缀待继续读取       |
| `tools {session,turn,cursor?,limit?}`                | 类型化工具摘要，正文保留 ContentRef                                    |
| `content {ref,offset,length?}`                       | 最多 64 KiB，offset 为 UTF-8 字节边界                                  |
| `content_batch {reads}`                              | 最多 8 个消息正文请求，每片最多 128 KiB；返回有序前缀，null 表示不可读 |
| `image {image}`                                      | 校验归档描述、base64、大小、哈希和 MIME 签名后返回图片                 |
| `turn_diff {session,turn,offset?}`                   | 每页最多 16 个文件摘要，缺失采集返回 unavailable                       |
| `turn_diff_content {session,turn,file,after,offset}` | 读取最多 64 KiB 归档文本，不读实时工作区                               |
| `validate_undo {session,turn,files?}`                | 只读工作区预检，不授权后续写入                                         |
| `management {query}`                                 | 设置或 SQL 用量聚合，每页最多 10 组及完整筛选总计                      |

分页使用服务端返回的游标，不自行构造；切换筛选重新开始。归档正文完整读取后校验哈希，单片所带全内容哈希不能独立验证该片。`content_batch` 因帧预算省略的尾部请求需继续读取。

`management` 额外指定 `refresh_models:true` 时会启动临时 Pi metadata worker，只读本地目录，不创建业务会话或推理；普通查询只读缓存。时间过滤和日期分组使用 UTC 毫秒，费用与缺失值规则见[模型与用量](workbench-management.md)。

## 订阅与恢复

`attach {session}` 先注册观察，再原子读取视图和近期历史，建立初始 revision。后续 `type: batch` 包含 session、revision、可选替换视图、已提交消息摘要和工具更新；无变化操作不增加 revision。

重复 revision 被忽略，缺口或订阅积压触发 `resync_required` 并断开。客户端重新 attach，不重发 mutation。`detach {session}` 只结束观察；取消请求观察者也不撤销宿主工作。删除会话通过持久 tombstone revision 发布终态。

## 容量与实现

帧最大 8 MiB，不完整帧期限 10 秒。每连接普通/控制/后台查询/前台历史容量为 16/4/4/1。普通页和批次完整 JSON envelope 最大 1 MiB，视图 512 KiB，内联正文 16 KiB，单个归档正文最大 64 MiB；整数必须是 JS-safe。

宿主入口为 `transport/vscode.rs`，共享类型在 `domain/query.rs`；TS 校验和客户端位于 `src/workbench-{protocol,schema,client}.ts`。操作提交与进程生命周期见[架构说明](workbench-architecture.md)，撤回语义见 [Diff 与撤回](turn-diff.md)。
