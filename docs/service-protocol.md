# 会话服务 Wire 协议规范

本文件是 `src/session-wire.ts` 与 `src/session-protocol.ts` 的**冻结规范**，供 Rust 重写与第三方客户端实现对照。任何实现（TS 或 Rust）都必须满足本文件的字节级语义；协议变更需要同时更新本文件、实现与 contract 测试。

黑盒验证入口：`npm run test:contract`（`scripts/service-contract.mjs`，只依赖 socket，不 import 服务实现）。

## 1. 传输层

- Unix domain socket，默认路径 `~/.pi/pi-acp-workbench/service/sessions.sock`，即 `<data-dir>/service/sessions.sock`。
- daemon CLI 约定：`--config <sessions.json 绝对路径>` 与可选 `--data-dir <目录>`（默认 `~/.pi/pi-acp-workbench`）。
- 服务目录 `0700`，socket 文件 `chmod 0600`。**无应用层认证**：访问控制仅依赖文件权限，同 UID 进程均可连接（与 docker.sock 同级边界）。
- 服务启动时 `rm` 旧 socket 文件后 listen；同一 `<data-dir>` 只允许一个 daemon（依赖 `<data-dir>/service` 的目录锁，见 data-formats.md）。第二个 daemon 必须拒绝启动而非接管。

## 2. 帧格式

- 每个消息是**单行 UTF-8 JSON**，`\n` 结尾。单行内不得出现未转义的 `\n`（`JSON.stringify` 输出天然满足）。
- 客户端 → 服务端请求帧：`{"id": "<string>", "method": "<string>", "params": {…}}`
- 服务端 → 客户端帧：
  - 成功响应 `{"id": "<同请求>", "value": <any>}`
  - 错误响应 `{"id": "<同请求>", "error": "<string>"}`
  - 事件推送 `{"event": <object>}`（无 `id`，不对应任何请求）
  - 分块帧 `{"fragment": "<string>", "last": <boolean>}`（见 §5）

## 3. 客户端约束（服务端强制执行）

| 约束 | 值 | 违反时行为 |
| --- | --- | --- |
| `id` | string，≤200 字符 | 销毁 socket |
| `method` | string | 销毁 socket |
| `params` | 必须是 object（非数组/null） | 销毁 socket |
| 单连接入站缓冲 | 16 MiB | 销毁 socket |
| 不完整帧超时 | 10 s（无 `\n` 收尾的残留缓冲） | 销毁 socket |
| 全局并发连接 | 32 | 新连接立即销毁 |
| 全局 pending 请求 | 128 个 / 32 MiB | 响应 `{id, error: 队列已满}` |
| 每 socket 会话订阅 | ≤32 个 sessionId | 响应 `{id, error: 订阅已满}` |
| 每请求 sessionId | ≤1000 字符非空 string | 响应 `{id, error}` |

非法 JSON、上述字段校验失败 → 服务端直接销毁该连接，**不回错误响应**。

客户端实现约定（`SessionClient`，Rust 侧可简化但需兼容服务端）：连接超时 5 s；默认请求超时 30 s（长任务类调用传 0 表示不设超时）；socket 断开时所有 pending 请求 reject。

## 4. 方法清单

入参校验逻辑对应 `serviceCommand()`。所有 `text` 参数规则：非空 string、≤10000 字符，违反返回 `{id,error:"无效参数：<name>"}`。

| method | params | 返回值 | 持久化 |
| --- | --- | --- | --- |
| `hello` | `{}` | `{protocolVersion:1, agentInfo:{name:'pi-session-service',title,version:'1'}, agentCapabilities:{loadSession:true, promptCapabilities:{image:true,embeddedContext:true}, _meta:{'pi-workbench':{version:1,inspect:true,nativeFork:true}}}}` | 否 |
| `list` | `{}` | `Snapshot[]`（仅 `harness==='pi'`，按 `updated` 降序；快照的 `entries` 为空数组） | 否 |
| `create` | `{cwd}` | 新 `Snapshot`（含 `sessionNumber`、`revision`、`stored:true`、`entries:[]`）。`cwd` 必须是已存在目录的绝对路径（服务端 `realpath`） | **是** |
| `state` | `{sessionId}` | `ServiceState = {snapshot, busy, permissions, commands, error?}`；`snapshot` 含完整 `entries` | 否 |
| `cancel` | `{sessionId}` | `boolean`（无可取消任务返回 `false`） | 否 |
| `remove` | `{sessionId}` | `undefined`（响应帧为 `{"id":…}`，无 `value` 键） | 否（排队执行） |
| `permission` | `{sessionId, permissionId, optionId?}` | `boolean`（票据不存在/选项非法返回 `false`） | 否 |
| `prompt` | `{sessionId, prompt:ContentBlock[], source?:'desktop'\|'telegram'}` | `{stopReason:string}` | **是** |
| `request` | `{sessionId, method, params?}` | 透传 ACP 结果 | 部分是 |
| `_watch` | `{sessionId, enabled:boolean}` | `true` | 否 |

`request.method` 白名单（`AGENT_METHODS`）：`_pi_workbench/inspect`、`_pi_workbench/fork`、`_pi_workbench/cancel_fork`、`session/set_mode`、`session/set_config_option`。其中 `fork`、`set_mode`、`set_config_option` 走持久化队列（journal）；`inspect` 走会话队列；`cancel_fork` 直接执行。

`request.params` 附加校验：`set_mode` 要求 `modeId`；`set_config_option` 要求 `configId`+`value`；`fork` 要求 `entryId`+`hash`。`_pi_workbench/inspect` 在 `params.force` 非真且会话无活动 worker 时短路返回 `{records:[], contextWindow:<快照缓存值>}`。

`prompt.prompt` 必须是非空数组，每个元素是含 `type` string 的 object；整体 JSON 序列化 ≤12 MiB（`checkPromptSize`）。

**持久化（durable）方法**在执行前写请求收据，见 data-formats.md §requests。同 id 同指纹直接返回原结果；同 id 不同指纹/会话拒绝；中断收据同 id 重试拒绝（不自动重放）。

**排队模型**：同 sessionId 的命令串行执行；全局工作进程上限 `maxWorkers`（配置 1–8，默认 3）；队列上限 100/会话；`cancel` 使该会话当时已排队的请求失效（epoch 失效），不影响执行中请求的结果写回。

## 5. 大响应分块（关键兼容点）

- 响应帧编码后（`JSON.stringify(value)+'\n'`）按 **JS string 的 UTF-16 code unit** 计量。
- body ≤512 KiB：整帧一次写入。
- body >512 KiB：按每片 **128 KiB UTF-16 code unit** 切片，逐片发送 `{"fragment": "<切片文本>", "last": bool}`。
- **切片点可以落在 UTF-16 代理对中间**。此时切片含孤立代理项，`JSON.stringify` 会将其转义为 `\uXXXX`——合法的 JSON 字符串。接收端必须先把各 `fragment` 的**解码后字符串**按顺序拼接还原，再对完整 body 做 `JSON.parse`（body 末尾的 `\n` 由 parser 容忍）。
- **Rust 实现注意**：Rust `String` 无法表示孤立代理项。正确做法是将要发送的 body 编码为 UTF-16 `Vec<u16>`，按 128 Ki code unit 边界切片，序列化 fragment 时对落在切片边界的孤立代理项输出 `\uXXXX` 转义（serde_json 拒绝孤立代理，需手写该转义）。接收端同样：拼接 fragment 的 UTF-16 序列后再转 UTF-8。
- 分块传输期间同 socket 不得交错其他消息；接收端发现交错应销毁连接。
- 每 socket 待写出响应 ≤64 MiB，全局 ≤128 MiB；超限销毁该 socket。
- 分块序列若 10 s 内未续传，接收方销毁连接（partialMs 同样约束分块间隔）。

## 6. 事件推送

`_watch` 建立会话级订阅。事件帧为 `{"event": <object>}`，只投递给订阅了该 sessionId 的连接：

| event.type | 载荷 | 触发 |
| --- | --- | --- |
| `state` | `{type:'state', snapshot, busy, permissions, commands, error?}` | 会话运行时状态变化（含 prompt 生命周期结束） |
| `update` | `{type:'update', notification:<ACP SessionNotification>}` | worker 发出 `session/update`（replay 阶段除外） |
| `serviceError` | `{type:'serviceError', sessionId, error}` | 状态超过 64 MiB 等无法传输的错误 |

路由依据：`event.snapshot.id` 或 `event.notification.sessionId`。事件帧同样受 64 MiB 编码上限约束；超限降级为 `serviceError` 帧。

## 7. 生命周期与错误语义

- 客户端断线**不取消**已提交任务；客户端不得自动重发（防重放由收据保证）。
- 服务关闭时销毁所有连接；客户端把 pending 全部 reject。
- 错误响应的 `error` 是人类可读字符串（当前为中文），**不作为程序契约**；契约仅以成功与否区分。
- 授权请求（`permissions`）5 分钟无人应答自动按取消处理；同会话并发授权上限 32，单次请求载荷 ≤256 KiB。

## 8. 明确不做的事

- 不监听 TCP/公网端口，不做 TLS、认证、多用户。
- 不提供批量原子操作、事务、消息重放或客户端断线重传。
- 不保证恰好一次执行：收据在 Linux 文件系统正确 fsync 的前提下提供"中断不重放"保证，不是分布式事务。
