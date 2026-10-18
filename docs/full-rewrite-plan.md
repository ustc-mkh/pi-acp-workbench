# ACP Workbench 六目标彻底重构计划

## 1. 目标与原则

本计划完成以下六个目标：

1. 全面重写 ACP protocol 类型。
2. 重写整个 Telegram bridge。
3. 合并 session daemon 和 Telegram daemon，成为一个宿主进程。
4. 将业务层的 `serde_json::Value` 全部替换为强类型。
5. 引入 Tokio 原生异步 actor 架构。
6. 重构 history、outbox、journal 系统。

最终目标不是在旧实现旁边增加一套新实现，而是删除旧路径：

```text
旧：Telegram daemon -> Unix socket -> Session daemon -> ACP worker
新：Telegram adapter ─┐
                      ├─ Runtime / RegistryActor / SessionActor -> ACP worker
VS Code IPC adapter ──┘
```

ACP worker 仍然是外部子进程。这里的“合并 daemon”指控制平面和 Telegram 运行在一个 Rust 进程中，不把 Codex、Claude 或 Pi 进程编译进宿主程序。

用户已确认：

- 允许破坏现有 IPC 兼容性。
- 允许破坏旧的 history、outbox、journal、Telegram 本地数据格式。
- 不引入专用 actor crate，使用 Tokio 原生 `mpsc`、`oneshot`、`JoinSet`、`CancellationToken`。
- 最终不保留旧 daemon socket client、旧 Value 业务路径和旧双进程启动方式。

## 2. 当前基线

当前代码主要由以下部分组成：

```text
pi-acp-core
├─ protocol.rs
├─ types.rs
├─ wire.rs
└─ harness.rs

pi-acp-session-daemon
├─ agent.rs
├─ server.rs
├─ service.rs
├─ service/turn.rs
├─ service/worker_pool.rs
├─ history.rs
├─ journal.rs
├─ outbox.rs
└─ updates.rs

pi-acp-telegram-daemon
├─ sessions.rs
├─ bridge.rs
├─ bridge/commands.rs
├─ bridge/inbox.rs
├─ bridge/permissions.rs
├─ bridge/delivery.rs
├─ bridge/history.rs
└─ bridge/settings.rs
```

当前已提交基线：

```text
4bf6f32 feat: normalize todo and ACP user interactions
```

当前已有但属于重构前临时实现的文件：

```text
docs/architecture-rewrite.md
rust/crates/pi-acp-session-daemon/src/interaction.rs
rust/crates/pi-acp-session-daemon/src/service/interactions.rs
```

它们在重构阶段会被新的 domain interaction 模型替代。

## 3. 目标架构

### 3.1 进程拓扑

```text
pi-acp-workbenchd
├─ Config
├─ Supervisor
├─ Runtime
│  ├─ RegistryActor
│  ├─ SessionActor(session A)
│  ├─ SessionActor(session B)
│  ├─ WorkerSupervisor
│  ├─ HistoryStore
│  ├─ JournalStore
│  └─ OutboxStore
├─ ACP adapter
│  └─ one child process per active session
├─ VS Code IPC adapter
└─ Telegram adapter
```

### 3.2 数据流

```text
ACP JSON-RPC
    ↓ typed ACP DTO
AcpAdapter
    ↓ DomainEvent
SessionActor
    ↓ DomainEvent
├─ Web/VS Code event sink
├─ Telegram event sink
├─ History projection
└─ Outbox projection

Telegram update / VS Code command
    ↓ typed DomainCommand
RegistryActor → SessionActor
```

### 3.3 核心模块

计划新增的目标模块：

```text
rust/crates/pi-acp-workbenchd/src/
├─ main.rs
├─ app.rs
├─ config.rs
├─ supervisor.rs
├─ actor/
│  ├─ mod.rs
│  ├─ registry.rs
│  ├─ session.rs
│  └─ worker.rs
├─ domain/
│  ├─ ids.rs
│  ├─ command.rs
│  ├─ event.rs
│  ├─ session.rs
│  ├─ interaction.rs
│  ├─ plan.rs
│  ├─ transcript.rs
│  ├─ usage.rs
│  └─ error.rs
├─ acp/
│  ├─ codec.rs
│  ├─ dto.rs
│  ├─ client.rs
│  ├─ adapter.rs
│  └─ provider.rs
├─ transport/
│  ├─ vscode.rs
│  └─ telegram.rs
├─ telegram/
│  ├─ polling.rs
│  ├─ update.rs
│  ├─ command.rs
│  ├─ callback.rs
│  ├─ render.rs
│  ├─ delivery.rs
│  └─ state.rs
└─ persistence/
   ├─ history.rs
   ├─ journal.rs
   ├─ outbox.rs
   ├─ inbox.rs
   └─ format.rs
```

具体 crate 名可以根据实现阶段调整，但最终只保留一个生产 daemon binary；公共类型放在 `pi-acp-core` 或新的 `pi-acp-domain` library crate 中。

## 4. 总体实施顺序

六个目标不是平行重写。必须按以下依赖顺序完成：

```text
阶段 0：基线冻结与设计
阶段 1：Domain 类型和命令/事件
阶段 2：Session Actor 与 Worker Supervisor
阶段 3：ACP protocol 全面强类型化
阶段 4：单进程 Runtime，合并两个 daemon
阶段 5：History / Journal / Outbox 重构
阶段 6：Telegram bridge 全面重写
阶段 7：删除所有业务 Value 和旧路径
阶段 8：迁移、测试、压力验证和发布
```

原因：

- Telegram 必须依赖稳定的 DomainCommand/Event。
- 持久化必须依赖稳定的 DomainEvent。
- ACP DTO 必须转换成 DomainEvent，不能直接成为领域状态。
- Actor 必须先明确 SessionState 的所有权。
- `Value` 清理只能在边界稳定后进行，否则会反复建模。

## 5. 阶段 0：基线冻结与重构安全网

### 5.1 工作内容

1. 在当前提交 `4bf6f32` 上建立重构分支。
2. 保存当前完整测试结果和工具版本。
3. 给所有重要数据目录建立临时 fixture：
   - history
   - journal
   - outbox
   - Telegram state
   - service socket 协议
4. 记录当前行为契约：
   - session create/load/list/state
   - prompt/cancel/permission
   - plan update
   - usage update
   - Telegram `/status`
   - Telegram callback
   - 文本回答
5. 新增统一测试命令：

```bash
npm run test:rewrite
```

至少包含：

```bash
npm run check
npm run build
cargo test --manifest-path rust/Cargo.toml --workspace
npm run test:contract
npm run test:contract:telegram
npm run test:browser
npm run clippy
```

### 5.2 输出

- 重构测试矩阵。
- ACP payload fixture 集合。
- 新格式版本号，例如：

```rust
const FORMAT_VERSION: u32 = 2;
```

- 明确“允许破坏兼容”，旧数据只允许被拒绝或由显式清理命令删除。

### 5.3 完成标准

- 基线所有测试通过。
- 旧测试不能依赖新实现。
- 每个关键状态转换至少有一个 fixture 或状态机测试。

## 6. 阶段 1：建立 Domain 类型和命令/事件

这是整个重构的基础阶段。

### 6.1 强类型 ID

新增不可混用的 ID 类型：

```rust
#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub struct SessionId(String);

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub struct TurnId(String);

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub struct InteractionId(String);

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub struct EntryId(String);
```

所有输入构造函数统一做长度、字符和空值验证。

### 6.2 Domain Command

```rust
pub enum DomainCommand {
    CreateSession(CreateSession),
    LoadSession(SessionId),
    Prompt { session: SessionId, prompt: Prompt },
    Cancel { session: SessionId },
    AnswerInteraction { session: SessionId, answer: InteractionAnswer },
    SetModel { session: SessionId, model: ModelId },
    SetMode { session: SessionId, mode: ModeId },
    Fork { session: SessionId, request: ForkRequest },
    RemoveSession(SessionId),
    Inspect(SessionId),
}
```

Telegram、VS Code IPC 和测试都只能生成这些命令，不得直接修改 SessionState。

### 6.3 Domain Event

```rust
pub enum DomainEvent {
    SessionCreated(SessionSnapshot),
    SessionLoaded(SessionSnapshot),
    UserPromptAdded(UserMessage),
    AgentText(AgentTextChunk),
    AgentThought(AgentThoughtChunk),
    ToolCall(ToolCallEvent),
    PlanChanged(Plan),
    InteractionRequested(Interaction),
    InteractionResolved(InteractionResolution),
    UsageChanged(Usage),
    TurnStarted(TurnInfo),
    TurnFinished(TurnResult),
    TurnCancelled(TurnId),
    SessionError(SessionError),
    SessionRemoved(SessionId),
}
```

### 6.4 Domain State

```rust
pub struct SessionState {
    pub id: SessionId,
    pub harness: Harness,
    pub cwd: WorkspacePath,
    pub status: SessionStatus,
    pub transcript: Transcript,
    pub plan: Plan,
    pub active_turn: Option<TurnState>,
    pub pending_interactions: BTreeMap<InteractionId, Interaction>,
    pub usage: UsageState,
    pub config: SessionConfig,
}
```

### 6.5 完成标准

- Domain 层不依赖 `serde_json::Value`。
- Domain 层不依赖 Telegram、ACP transport 或 Unix socket。
- Domain reducer 测试可以只用 enum 命令和事件运行。
- 取消、权限回答、计划更新和 worker crash 都有明确状态转换。

## 7. 阶段 2：Session Actor 与 Worker Supervisor

### 7.1 RegistryActor

职责：

- session ID 到 actor mailbox 的映射。
- 创建、加载、删除 session。
- 全局 worker 数量限制。
- 路由命令。
- 处理 actor 退出和重启策略。

```rust
pub struct RegistryHandle {
    tx: mpsc::Sender<RegistryCommand>,
}
```

### 7.2 SessionActor

每个 session 一个 actor：

```rust
pub struct SessionActor {
    state: SessionState,
    rx: mpsc::Receiver<SessionCommand>,
    worker: Option<WorkerHandle>,
    persistence: PersistenceHandle,
    sinks: EventSinks,
}
```

actor loop：

```rust
while let Some(command) = rx.recv().await {
    match command {
        SessionCommand::Prompt(prompt) => self.prompt(prompt).await?,
        SessionCommand::Agent(event) => self.apply_agent_event(event).await?,
        SessionCommand::Answer(answer) => self.answer(answer).await?,
        SessionCommand::Cancel => self.cancel().await?,
        SessionCommand::WorkerClosed(exit) => self.worker_closed(exit).await?,
        SessionCommand::Shutdown => break,
    }
}
```

原则：

- 只有 SessionActor 能修改 SessionState。
- Worker 回调只发送 `SessionCommand::Agent`。
- Telegram 回答只发送 `SessionCommand::Answer`。
- 持久化由 actor 发起，不允许外部读写内部状态。
- 每个 mailbox 有明确上限，满时返回 `Backpressure`。

### 7.3 WorkerSupervisor

职责：

- 启动 ACP 子进程。
- 每 session 一个 worker handle。
- 维护 worker epoch。
- 处理 crash、EOF、SIGTERM、SIGKILL。
- 将 typed ACP event 投递给 SessionActor。
- 退出时等待所有子进程组清理。

### 7.4 取消和关闭

必须定义严格顺序：

```text
cancel command
→ mark turn cancelled
→ cancel ACP request
→ resolve pending interaction as cancelled
→ finish publication
→ persist final state
→ start queued turn or become idle
```

daemon shutdown：

```text
stop intake
→ stop Telegram polling
→ stop external IPC intake
→ tell RegistryActor shutdown
→ tell SessionActors shutdown
→ stop workers
→ flush journal/outbox/history
→ join all tasks
```

### 7.5 完成标准

- Runtime 不再需要通过 `Arc<Mutex<Runtime>>` 让多个模块直接修改状态。
- SessionActor 单线程拥有单个 SessionState。
- session 并发、取消、重启和 worker crash 测试通过。
- mailbox 满、actor panic、worker panic 都有隔离测试。

## 8. 阶段 3：ACP protocol 全面强类型化

### 8.1 JSON-RPC 层

保留一个很窄的 codec 边界：

```rust
pub enum JsonRpcMessage {
    Request(JsonRpcRequest),
    Response(JsonRpcResponse),
    Notification(JsonRpcNotification),
}
```

仅 codec 可以处理原始 JSON。进入 adapter 后必须转换成 typed enum。

### 8.2 ACP DTO

定义：

```rust
struct InitializeRequest {
    protocol_version: ProtocolVersion,
    client_info: ClientInfo,
    client_capabilities: ClientCapabilities,
}

struct SessionPromptRequest {
    session_id: NativeSessionId,
    prompt: Vec<ContentBlock>,
}

enum SessionUpdate {
    AgentMessage(AgentMessageUpdate),
    AgentThought(AgentThoughtUpdate),
    ToolCall(ToolCallUpdate),
    Plan(PlanUpdate),
    Usage(UsageUpdate),
    AvailableCommands(AvailableCommandsUpdate),
}

enum InboundUserRequest {
    Permission(PermissionRequest),
    Elicitation(FormRequest),
}
```

### 8.3 Content block

```rust
enum ContentBlock {
    Text(TextContent),
    Image(ImageContent),
    Resource(ResourceContent),
    Unknown(ExtensionData),
}
```

未知 provider 内容只能落入明确的 `ExtensionData`，不能在业务代码中继续传播 `Value`。

### 8.4 Provider 差异

```rust
enum Harness {
    Pi,
    Codex,
    Claude,
}

struct ProviderExtensions {
    pi: Option<PiExtensions>,
    codex: Option<CodexExtensions>,
    claude: Option<ClaudeExtensions>,
}
```

标准 ACP 字段和 provider 私有扩展必须分开。

### 8.5 ACP → Domain

```text
AcpSessionUpdate::Plan → DomainEvent::PlanChanged
AcpSessionUpdate::AgentMessage → DomainEvent::AgentText
AcpRequest::Permission → DomainEvent::InteractionRequested
AcpRequest::Elicitation → DomainEvent::InteractionRequested
AcpResponse ← InteractionResolution
```

### 8.6 完成标准

- Session service 不再接收 ACP 原始 Value。
- `agent.rs` 不把 ACP payload 直接写入 ChatState。
- Codex、Claude、Pi fixture 全部可解析。
- 新增未知 update 类型不会破坏连接，而是进入明确的 unknown 分支或返回协议错误。
- ACP validation 和 serialization 测试覆盖所有标准消息。

## 9. 阶段 4：合并 session daemon 和 Telegram daemon

### 9.1 合并方式

不直接把两个 `main.rs` 拼在一起。先提取 library：

```text
session daemon main
    → app::SessionRuntime
telegram daemon main
    → app::TelegramAdapter
new main
    → app::WorkbenchApp
```

最终：

```rust
pub struct WorkbenchApp {
    runtime: RuntimeHandle,
    telegram: TelegramHandle,
    external: ExternalTransportHandle,
}
```

### 9.2 删除内部 Unix socket

删除：

- Telegram `Sessions::connect` 作为业务后端。
- Telegram 到 session daemon 的 `sessions.sock` 调用。
- 重复的 session client DTO。
- 两个 daemon 间的 `state/list/prompt/permission` IPC。

仍可保留一个新的外部 IPC adapter，供 VS Code 使用；它直接连接 `RuntimeHandle`，不再作为 session daemon 内部 API。

### 9.3 配置合并

新配置分区：

```json
{
  "workers": {},
  "sessions": {},
  "telegram": {},
  "storage": {},
  "limits": {}
}
```

启动时一次校验：

- Bot token 不进入 JSON。
- workspace 路径规范化。
- worker command/args/env 校验。
- socket/Telegram/storage 路径校验。
- mailbox、worker、Telegram queue 上限校验。

### 9.4 完成标准

- 生产只启动一个 Rust daemon。
- 只有 ACP worker 是子进程。
- Telegram 测试可以直接构造 `WorkbenchApp`，不需要启动 session socket。
- 任何一个 fatal supervisor error 都能取消并 join 其他任务。
- systemd、package、setup、README 和 scripts 只引用新 binary。

## 10. 阶段 5：History / Journal / Outbox 重构

### 10.1 共同原则

三者不再接收 ACP `Value` 或 Telegram 原始 update，而只接收强类型命令/事件。

### 10.2 History

目标模型：

```rust
struct HistorySnapshot {
    format_version: u32,
    session: SessionSnapshot,
    entries: Vec<TranscriptEntry>,
    plan: Plan,
    usage: UsageState,
    revision: Revision,
}
```

改造：

- snapshot、entry、plan、usage 全部强类型。
- 每次 commit 生成 revision。
- atomic temp + rename。
- checksum 与 session ID 校验。
- 旧格式不兼容，启动时 fail-closed。
- 提供显式 `reset-storage` 或 `export-old-history` 工具，不在 daemon 内隐式迁移。

### 10.3 Journal

目标模型：

```rust
enum JournalRecord {
    Started(OperationStarted),
    Completed(OperationCompleted),
    Failed(OperationFailed),
    Tombstone(OperationTombstone),
}
```

保持不变的语义：

```text
先写 durable Started
→ 执行副作用
→ 写 Completed / Failed
→ 崩溃后不重复执行已确认副作用
```

需要明确：

- operation ID 类型。
- request fingerprint 类型。
- result reference 类型。
- corruption 行为。
- GC 规则。

### 10.4 Outbox

目标模型：

```rust
struct DeliveryEvent {
    id: DeliveryId,
    target: DeliveryTarget,
    payload: DeliveryPayload,
    status: DeliveryStatus,
    attempt: u32,
}

enum DeliveryPayload {
    SessionCompleted(SessionCompletedNotice),
    AgentMessage(AgentMessageNotice),
    Image(ImageNotice),
    Interaction(InteractionNotice),
}
```

保持：

- 至少一次投递。
- ack 后删除或标记完成。
- 失败重试不重跑 Agent。
- 事件只引用 immutable entry/image ID。
- 大 payload 外置存储，事件只保存 reference。

### 10.5 Telegram Inbox

```rust
enum TelegramCommand {
    Prompt { topic: TopicId, text: String },
    Answer { topic: TopicId, answer: InteractionAnswer },
    Callback(CallbackCommand),
    Control(ControlCommand),
}
```

入队时完成分类，避免执行阶段重新把普通文字猜成回答。

### 10.6 完成标准

- History、journal、outbox 的业务结构无 `Value`。
- 新格式有明确 format version。
- 崩溃点测试覆盖 write-before-side-effect、ack、重启、损坏文件。
- session actor 可以只通过 persistence trait 测试。

## 11. 阶段 6：Telegram bridge 全面重写

### 11.1 分层

```text
Telegram API
    ↓
Polling
    ↓ typed TelegramUpdate
Admission / Inbox
    ↓ TelegramCommand
RuntimeHandle
    ↓ DomainEvent
Renderer
    ↓ Telegram API request
Delivery / retry
```

### 11.2 删除旧职责混合

原来的 `Bridge` 不再同时负责所有事情，拆成：

- `TelegramPoller`：只负责 getUpdates。
- `TelegramAdmission`：授权、offset、去重、入箱。
- `TelegramCommandParser`：命令、文本、callback。
- `TelegramRuntimeAdapter`：DomainCommand 转 Runtime。
- `TelegramRenderer`：DomainEvent/Interaction 转 Telegram message。
- `TelegramDelivery`：发送、重试、ack。
- `TelegramStateStore`：只保存 Telegram adapter 自己的状态。

### 11.3 Interaction UI

统一使用：

```rust
InteractionView {
    id: InteractionId,
    title: String,
    detail: String,
    fields: Vec<InteractionFieldView>,
    expires_at: Timestamp,
}
```

Telegram 不再伪造 ACP permission JSON。

### 11.4 Todo

Telegram 只在 `/status` 展示 Domain `Plan`：

```text
PlanChanged → SessionState.plan
/status → format_plan(&state.plan)
```

不单独发送 Todo live event。

### 11.5 完成标准

- Telegram bridge 不依赖 ACP DTO。
- Telegram bridge 不依赖 session socket client。
- 普通文本回答和普通 prompt 在 admission 时明确分类。
- 回调过期、错误 topic、重复 callback、服务重启都有测试。
- 旧 `bridge.rs` 聚合状态被删除或只剩 facade。

## 12. 阶段 7：清理所有业务 `serde_json::Value`

### 12.1 允许保留的范围

重构完成后允许 `Value` 存在于：

1. JSON-RPC 编解码边界。
2. 明确命名的 `RawExtension` / `OpaqueContent`。
3. 测试 fixture 与 debug 输出。
4. 外部 provider 未知字段的暂存区。

### 12.2 必须清除的范围

以下目录不应再出现业务 Value：

```text
src/domain
src/actor
src/persistence
src/telegram business modules
session state / plan / usage / interaction
history / journal / outbox
```

### 12.3 检查

使用静态检查：

```bash
rg 'serde_json::Value|\bValue\b' rust/crates/pi-acp-workbenchd/src/domain
rg 'serde_json::Value|\bValue\b' rust/crates/pi-acp-workbenchd/src/persistence
```

将允许的边界集中到少数文件，避免业务代码绕过 adapter。

## 13. 阶段 8：删除旧路径与发布切换

必须删除：

- `pi-acp-session-daemon` 和 `pi-acp-telegram-daemon` 生产启动入口。
- Telegram `Sessions::connect` 业务客户端。
- daemon 间 `sessions.sock`。
- 旧的 `ServiceCommand` Value 适配路径。
- 旧 history/journal/outbox 格式读取器。
- 旧 Telegram bridge 聚合实现。
- 旧双 daemon systemd unit。
- 旧安装、构建、contract scripts。
- 过渡兼容类型和私有 marker。

允许保留：

- 面向 VS Code 的新 external IPC transport。
- ACP worker 子进程协议层。
- 显式数据清理/导出工具，但不能被 daemon 正常启动隐式调用。

## 14. 测试计划

### 14.1 Unit tests

- Domain reducer。
- SessionActor mailbox。
- Interaction 状态机。
- Plan normalization。
- ACP DTO parse/encode。
- Telegram parser/render。
- History revision。
- Journal crash points。
- Outbox ack/retry。

### 14.2 Contract tests

每个 ACP provider fixture 至少覆盖：

- initialize capability。
- session/new。
- session/prompt。
- agent message。
- thought。
- tool call。
- plan。
- usage。
- permission。
- elicitation form。
- cancel。
- worker disconnect。

### 14.3 Integration tests

- 单 daemon 创建 session + Telegram topic。
- VS Code 和 Telegram 同时订阅同一 session。
- Telegram 回答来自 ACP elicitation。
- Worker crash 后 session actor 恢复。
- daemon 重启后 history 恢复。
- outbox 失败重试不重复执行。
- journal 重放和重复请求。
- 多 session mailbox 背压。

### 14.4 Soak tests

- 16 workers 并发。
- 100 个 session 命令。
- 32 个 pending interaction 上限。
- 长文本、Unicode、图片引用。
- 反复 cancel / prompt / worker crash。
- 连续重启和磁盘损坏模拟。

### 14.5 发布检查

```bash
npm run check
npm run build
cargo fmt --manifest-path rust/Cargo.toml --all -- --check
cargo clippy --manifest-path rust/Cargo.toml --workspace --all-targets -- -D warnings
cargo test --manifest-path rust/Cargo.toml --workspace
npm run test:contract
npm run test:browser
npm run test:full
npm run package:services
npm run test:service:artifact
```

## 15. 里程碑和完成定义

### M1：Domain 基础

完成 command/event/state/ID/interaction/plan 类型，旧系统仍可编译。

### M2：Actor Runtime

RegistryActor、SessionActor、WorkerSupervisor 可独立运行，完成 session 的 prompt/cancel/permission/plan 流程。

### M3：Typed ACP

三种 Harness 都经过 typed adapter，业务层不接触 ACP Value。

### M4：Persistence v2

History、journal、outbox 使用新强类型格式，崩溃恢复和幂等测试完成。

### M5：Single daemon

Telegram 和 VS Code adapter 直接连接同一 Runtime，删除 daemon 间 socket。

### M6：Telegram v2

Telegram bridge 完全基于 DomainCommand/Event，旧 Bridge 删除。

### M7：Value cleanup

业务路径 Value 清零，保留的 Value 全部集中并有注释说明。

### M8：Final cutover

旧 crate、binary、unit、scripts、format reader、compatibility path 全部删除；完整测试、打包和部署验证通过。

## 16. 最终验收标准

只有同时满足以下条件，六目标才算完成：

1. 生产只运行一个 `pi-acp-workbenchd` 控制进程。
2. Session 状态由 SessionActor 唯一拥有。
3. Telegram、VS Code、ACP 都通过 DomainCommand/Event 接入。
4. ACP protocol 使用强类型 DTO。
5. Domain、Telegram、persistence 不使用 `serde_json::Value`。
6. History、journal、outbox 使用新版本强类型格式。
7. 旧 socket client、旧 daemon binary、旧格式 reader 和旧 bridge 已删除。
8. Codex、Claude、Pi 的 plan、permission、elicitation、usage、cancel 均有 fixture 和集成测试。
9. 崩溃恢复、重启、取消、重试、背压和并发行为有测试。
10. 构建、clippy、workspace tests、contract tests、browser smoke、artifact smoke 全部通过。
