# Pi ACP Workbench

VS Code 和 Telegram 共用的 ACP 编码工作台。当前源码使用一个 **`pi-acp-workbenchd` 控制进程**；Pi、Codex、Claude ACP worker 仍是独立子进程。

```text
VS Code → external IPC v3 ─┐                       ┌─ Pi ACP worker
                          ├─ pi-acp-workbenchd ────┼─ Codex ACP worker
Telegram → Bot API adapter┘   SessionActor/store   └─ Claude ACP worker
```

> 当前为未部署的重构工作树。旧双 daemon、内部 socket client 和旧格式 reader 已删除；不会回退旧协议，也不会迁移或清空既有数据。请使用独立空 storage root。本地自动化通过不代表完整功能对齐、长期性能或真实 provider/Bot 验收；历史已发布的 VSIX/服务包不代表当前源码。剩余工作统一见[下一版重构计划](docs/workbench-next-rewrite-plan.md)。

## 当前功能与边界

- VS Code 直接使用 typed IPC v3：创建/选择会话、cold history inspection、文字 prompt、思考/文本/tool metadata、模型/mode、权限与多字段表单、取消、明确的 archived image 读取、原生 fork 和精确 fork operation 取消。
- SessionActor 独占会话状态；历史提交后才发布，持久化 native identity 供显式恢复。关闭 VS Code 只断开 observer，不撤销已接收任务；daemon 崩溃不自动重放工具调用。
- Telegram 在同一宿主进程内授权、分类、持久入箱及投递。支持文字 prompt/answer、权限按钮、取消、状态和归档图片输出；新增持久 `/menu`，提供授权目录有界浏览→已配置 Harness→新建、分页会话打开、真实 catalogue 模型/mode 与状态/停止入口，支持首任务前模型发现。另有按话题持久保存的 `/notifications on|off`、`/silent on|off`；关闭自动推送不停止任务，授权/错误/主动查询仍投递。`/history` 导出最近窗口，`/history all` 从头续批完整归档正文/图片；显式历史与自动完成输出共享已确认正文/图片去重，复用可靠 outbox，不重跑 Agent（`/sync` 按稳定活动范围分批同步）。Plan/Todo 只在显式 `/status` 展示。
- Outbox 使用 durable admission FIFO、同 topic 串行和最多八个独立 topic 并发投递；失败重试不重新运行 Agent。Multipart 部分成功或发送后崩溃可能重复之前的 parts（at-least-once）。
- Pi native fork 要求独立 native identity 和可证明安全的 entry cut；不以摘要/文本重播代替，不猜 timestamp。Codex/Claude 私有 native fork 支持未经验证；不支持或不明确的 cut 显式拒绝。

历史、工具和正文已有有界分页与冷查询。已有显式有界文本文件附件、全历史 Markdown 导出、轮次过程折叠、思考显示偏好、独立 Plan 区域和 Mermaid/代码复制入口。已恢复[每轮工作区 Diff 与确认撤回](docs/turn-diff.md)：有界 Git-visible 净快照、冷历史按需正文、单文件/总 Diff 原生编辑器入口，完整快照才可撤回；多文件可能部分成功，外部编辑器/残留后台进程不受宿主锁保护，真实 Extension Host/在线 provider 仍待验。已接通[用量统计、价格/模型设置、自动/手动命名与 Telegram 配置向导](docs/workbench-management.md)：按模型/日期/会话 SQL 聚合，cache 与 missing/unpriced 明示，Pi context 仅显式授权修改，标题调用独立限时、不阻塞业务 prompt；消息复制/复用及列表高度/跟随输出偏好已有入口。尚未恢复的 UI 包括 thinking/Fast/config options、自主轮次和图片 prompt 输入；文本附件仍封装为 prompt 文本，尚非 typed context parts。tool binary archives 属于额外能力。Enter 发送、Shift+Enter 换行（IME 不误发）；有界文本草稿随 Webview 保存，只有匹配的发送接受响应才清除，不因 reload 自动重发。扩展只持久化一个所选会话 ID 与有限 operation handles；reload 后冷 attach 原会话、查询宿主原 operation ID，不保存或重发命令正文。断连/订阅 gap 后以有界退避恢复观察，不自动 load provider 或重新提交 mutation。Started 保守显示 uncertain，不能当作模型成功。未完成的功能差异与验收要求统一列于[下一版重构计划](docs/workbench-next-rewrite-plan.md)。工具路径、URI 和 terminal references 只是显示 metadata，不授权读文件、联网或执行命令。图片校验目前是 MIME/signature/hash/size，不等于完整解码或 sanitization。

## 从源码本地运行

环境：Linux x86_64、Node.js 22+、Rust/Cargo；VS Code 1.96+。Remote SSH/WSL 中，扩展、Unix socket 和 daemon 位于同一扩展宿主机器、同一账户。

```sh
npm ci
npm run build
npm run build:services
npm run package:services
```

`service-dist/` 只包含一个控制 binary 和 manifest。发布归档在 `service-artifacts/`，包含 SHA256SUMS、许可证、文档和单个 systemd 示例。这里只本地打包，不自动安装、部署或更新真实服务。校验、ABI、手动配置和备份边界见 [当前单宿主发布指南](docs/workbench-release.md)。

复制并编辑 [`examples/workbench.json`](examples/workbench.json)：

- `storage.root` 替换为显式绝对路径，例如 `/home/YOU/.pi/pi-acp-workbench`，首次使用空目录。
- `workers.pi/codex/claude` 分别设置 ACP executable 的 `command`、`args`、`env`；`null` 表示禁用，没有其他 provider fallback。先独立完成 provider CLI 登录，不将凭据写入仓库。
- 默认示例使用 PATH 中的 `pi-acp`。需要本仓库 Pi 增强功能时，配置 Node 的绝对路径，并将 `args` 设为构建后的 `dist/pi-adapter.mjs` 绝对路径；核对实际构建输出，不能依赖交互 shell PATH。
- Telegram 为可选配置，token 只从 `bot_token_env` 指定的环境变量读取，不写入 JSON；workspace/chat/user 授权必须显式设置。详见 [Telegram 配置](docs/workbench-telegram.md)。

```sh
./service-dist/pi-acp-workbenchd --config /absolute/path/workbench.json
```

socket 为 `<storage.root>/workbench.sock`。不兼容/损坏/未版本化非空目录一律拒绝，不做隐式清理。离线维护在同一 binary 中提供，持有与 host 相同的独占 flock，见 [存储 export/reset/typed GC](docs/workbench-storage.md)。

### 可选 systemd（仅手动部署）

编辑 [`examples/pi-acp-workbenchd.service`](examples/pi-acp-workbenchd.service) 的绝对 binary/config 路径后，按自己的运维策略安装到用户 unit 目录。保持 workspace/storage 私有、使用最小权限账户，单独向服务注入 token 环境变量。仓库脚本不会执行 `systemctl`，也没有旧式 Telegram setup 向导。

### VS Code

```sh
npm run package
```

将本次构建的 VSIX 手动安装到扩展宿主，打开并信任项目。设置 **`piAcp.workbenchSocket`**（空值默认 `~/.pi/pi-acp-workbench/workbench.sock`），修改路径后 reload。扩展不包含 native daemon，也不会启动/安装 daemon。编辑器选择只能通过显式 **Pi: Add Selection to Chat** 附加；不是任意工具路径读取功能。

完整行为、授权、CSP 和限制见 [VS Code 接入](docs/workbench-vscode.md)；外部 IPC 方法、错误与 operation replay 见 [IPC v3](docs/workbench-ipc.md)。

## 验证与开发

```sh
npm run test:rewrite             # check/build/fmt/clippy/Rust/contracts/browser/full/package/artifact
npm run test:workbench:storage   # builds host, isolated offline maintenance tests
npm run test:workbench:process-loss # real host SIGKILL; explicit fixture-only stale socket cleanup
npm run test:workbench:soak -- --duration-seconds 600 # joined synthetic fixture loops; not a two-hour single-host soak
```

真实 Pi 1.3.0 SDK/native-file 的独立离线验收（需要本地 SDK 和 Cargo cache，不执行真实模型请求）：

```sh
PI_OFFLINE_PI_CLI=/absolute/path/to/pi/dist/cli.js npm run test:native-fork:offline
```

默认 fixtures 使用 synthetic ACP peers 与本地 mock Bot，不等于 live Pi/Codex/Claude 或真实 Telegram 验收。程序可使用服务账户权限执行命令、修改文件；不是安全沙箱。取消也不撤销已发生的文件或远端副作用。

- [文档索引](docs/README.md) · [贡献指南](CONTRIBUTING.md)
- [下一版重构计划](docs/workbench-next-rewrite-plan.md)
- [更新历史](CHANGELOG.md) · [MIT 许可证](LICENSE)
