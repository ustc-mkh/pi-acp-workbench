# Pi ACP Workbench

在 VS Code 和 Telegram 中使用同一个 AI 编码工作台，接入 Pi、Codex、Claude 等 ACP Agent。会话、历史和设置由本机 `pi-acp-workbenchd` 统一管理；Agent 作为独立子进程运行。

## 功能

- **编辑器对话**：流式 Markdown、代码高亮、LaTeX、Mermaid、思考与工具过程折叠，支持选区、文本文件及图片附件。
- **会话管理**：历史检索、Markdown 导出、消息复制与复用、原生会话恢复，以及 provider 支持的原生分支。
- **模型与用量**：模型、thinking/mode 和能力设置，按模型、日期、会话统计 token 与估算费用；支持自定义价格和 Pi context 设置。
- **变更审阅**：逐轮工作区 Diff、原生编辑器查看、确认撤回与冲突保护。
- **Telegram**：话题绑定会话，菜单新建/打开会话、选择模型、回答授权、停止任务、查询状态及导出历史和图片；可设置静默或关闭自动通知。
- **后台任务**：关闭 VS Code 后已接受的任务继续运行；历史持久化，Telegram 输出支持排队、失败重试和按话题顺序投递。

各 Agent 的能力取决于其 ACP adapter。Pi 自主后台轮次需要匹配的增强 adapter；Codex/Claude 原生 fork、Pi stable Fast、Telegram 入站照片及终端输出流不属于已支持能力。详见[使用文档](docs/README.md)。

## 安装

支持 Linux x86_64；VS Code 需 **1.96+**。Remote SSH/WSL 中，扩展、daemon 和 Agent 安装在同一扩展宿主机器、使用同一账户。

### 1. 准备程序

从 [Releases](https://github.com/ustc-mkh/pi-acp-workbench/releases) 下载同一版本的 `.vsix` 和 Linux 服务包，按发布校验和验证后解压。服务包包含 `pi-acp-workbenchd`、配置示例和 systemd 示例。

也可以从源码构建，需要 **Node.js 22+** 和 **Rust/Cargo**：

```sh
git clone https://github.com/ustc-mkh/pi-acp-workbench.git
cd pi-acp-workbench
npm ci
npm run build
npm run build:services
npm run package
```

服务程序位于 `service-dist/pi-acp-workbenchd`，扩展安装包位于仓库根目录。需要可分发服务归档时运行 `npm run package:services`，输出在 `service-artifacts/`。

### 2. 配置并启动服务

复制并编辑 [`examples/workbench.json`](examples/workbench.json)：

- 将 `storage.root` 改为绝对路径，例如 `/home/YOU/.pi/pi-acp-workbench`。首次安装使用空目录；升级前备份，兼容性见[数据迁移说明](docs/workbench-data-migration.md)。
- 单独安装所需 Agent 的 ACP executable，完成 provider 登录，再填写 `workers.pi/codex/claude` 的 `command`、`args`、`env`；`null` 表示禁用。
- 默认示例使用 PATH 中的 `pi-acp`。使用本仓库 Pi 增强功能时，将 `command` 设为 Node 的绝对路径，`args` 设为构建后的 `dist/pi-adapter.mjs` 绝对路径。

在源码目录启动：

```sh
./service-dist/pi-acp-workbenchd --config /absolute/path/workbench.json
```

使用已解压的发布包时，运行包内的 `./pi-acp-workbenchd`。长期运行可编辑并安装 [`examples/pi-acp-workbenchd.service`](examples/pi-acp-workbenchd.service) 用户级 systemd unit；具体步骤见[构建与部署](docs/workbench-release.md)。

### 3. 连接 VS Code

在扩展面板选择 **Install from VSIX…**，安装下载或构建的 `.vsix`，然后打开并信任项目。

设置 `piAcp.workbenchSocket` 为 `<storage.root>/workbench.sock`；留空默认使用 `~/.pi/pi-acp-workbench/workbench.sock`。修改路径后执行 **Developer: Reload Window**。

点击活动栏 **Pi Agent**，或运行 **Pi: Open Chat**，新建会话并选择 Agent。扩展需要已运行的 daemon；选中代码后可通过 **Pi: Add Selection to Chat**（`Ctrl+Alt+P` / macOS `Cmd+Alt+P`）加入上下文。

### 4. 可选：连接 Telegram

按 [Telegram 配置指南](docs/workbench-telegram.md) 设置 Bot、forum 群、workspace 和允许的用户/chat ID。Bot token 从 `bot_token_env` 指定的环境变量读取。启动服务后，通过 `/menu` 新建或打开会话，通过 `/status` 查询任务、`/history` 导出历史。

## 使用须知

Agent 以服务账户权限执行命令和修改文件。取消任务不会撤销已发生的文件或远端副作用；多文件撤回可能部分成功。断线后恢复观察，daemon 崩溃后不会自动重放工具调用。Telegram 外部投递采用 at-least-once，部分发送或崩溃时可能重复。

升级时配套更新扩展、宿主和 Pi adapter，并备份停止后的数据目录及关联 Pi profile。不兼容的非空目录会拒绝启动；不要通过删除数据或锁文件绕过检查。维护方法见[存储维护](docs/workbench-storage.md)。

[文档索引](docs/README.md) · [贡献与测试](CONTRIBUTING.md) · [更新历史](CHANGELOG.md) · [MIT 许可证](LICENSE)
