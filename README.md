# Pi ACP Workbench

在 VS Code 和 Telegram 中使用 Pi 的编码工作台，也可接入 Codex / Claude Code。桌面与手机共享会话，Agent 由服务器上的独立会话服务运行，关闭 VS Code 后已提交的任务仍可继续。

## 核心功能

- **桌面编码助手**：侧栏流式对话，附加代码选区、文件和粘贴图片，查看思考过程、工具调用与实时终端输出，处理工具授权或停止任务。
- **跨端继续任务**：Telegram 每个话题对应一个会话，支持远程发指令、流式回复、完成通知、授权与停止；桌面输入、Agent 回复及支持的图片可同步到手机。
- **修改审阅与撤回**：按轮汇总工作区文件及增删行数，查看单文件或多文件总 Diff；对满足完整快照与无冲突条件的文本修改，可确认后撤回。支持 Pi / Codex / Claude。[范围与限制](docs/turn-diff.md)。
- **会话与历史**：保存、恢复和跨端继续会话，运行中切换到其他会话或 Agent，支持 Pi 原生会话分支和 Markdown 导出。
- **模型管理与用量统计**：选择模型、思考强度和适配器支持的 Fast 模式；管理模型可见性、价格与 Pi context 长度；按模型、时间、会话查看 token 用量和费用估算。
- **丰富内容展示**：流式 Markdown、代码高亮、LaTeX 数学公式、Mermaid 图表、图片与上下文占用。

```text
VS Code ─┐                                  ┌─ Pi
         ├─ Unix socket ─ 独立会话服务 ─ ACP ├─ Codex
Telegram ┘                                  └─ Claude Code
```

## 安装与开始使用

### 1. 准备环境

会话服务目前支持 **Linux x86_64**，需要 **Node.js 22+、Pi 和用户级 systemd**；从源码构建服务还需要 **Rust/Cargo**。VS Code 要求 **1.96+**。使用 Remote SSH / WSL 时，服务与扩展安装在扩展宿主所在的机器，并使用同一账户。

安装 Pi，并完成模型供应商登录或 API key 配置：

```bash
npm install -g @earendil-works/pi-coding-agent
pi
```

插件与会话服务复用该账户的 Pi 凭据。

### 2. 部署会话服务

以下从源码构建；也可使用 [Release](https://github.com/ustc-mkh/pi-acp-workbench/releases/latest) 的 Linux 服务包，按[服务发布指南](docs/service-release.md#校验安装与回滚)校验和安装。

```bash
git clone https://github.com/ustc-mkh/pi-acp-workbench.git
cd pi-acp-workbench
npm ci
npm run build:services

mkdir -p ~/.config/pi-acp-workbench ~/.config/systemd/user
chmod 700 ~/.config/pi-acp-workbench
cp examples/sessions.json ~/.config/pi-acp-workbench/sessions.json
cp examples/pi-sessions.service ~/.config/systemd/user/pi-sessions.service
```

编辑 `pi-sessions.service`，将占位路径替换为仓库的实际绝对路径，指向 `service-dist/pi-acp-session-daemon`。

- 默认自动查找 `pi`，无需填写 Pi 安装路径。
- 确保 **Node 在服务的 PATH 中**；systemd 不读取 `.bashrc` 或 nvm / Volta 的交互式初始化配置。
- 代理及模型环境变量放在 `sessions.json` 的 `env` 中，不写入仓库。

```bash
chmod 600 ~/.config/pi-acp-workbench/sessions.json
systemctl --user daemon-reload
systemctl --user enable --now pi-sessions
```

需要退出 SSH 后仍运行时，为账户启用 linger：`loginctl enable-linger "$USER"`，是否需要管理员权限取决于服务器策略。

默认最多 16 个 Agent 工作进程，包含执行中与空闲驻留进程；按需启动，不会预先启动 16 个。空闲进程按活跃度分层回收，容量满时可提前回收空闲进程。历史保存在服务账户的数据目录。完整配置与排障见[会话服务](docs/session-service.md)。

### 3. 安装插件并开始对话

从 [Release](https://github.com/ustc-mkh/pi-acp-workbench/releases/latest) 下载 VSIX，在 VS Code 执行 **Extensions: Install from VSIX…**。远程开发时安装到远端，然后重新加载窗口。

打开并信任项目文件夹，点击活动栏 **π** → **新建会话**：

- **Enter** 发送，**Shift+Enter** 换行。
- 编辑器右键 **Pi: Add Selection to Chat** 可附加选区，也可粘贴图片。
- 顶部选择 Agent、模型、思考强度和可用的 Fast 模式。
- 任务结束后在「本轮修改」中审阅 Diff；运行中可切换会话，原任务继续执行。

插件默认连接 `~/.pi/pi-acp-workbench/service/sessions.sock`，自定义路径使用 VS Code 设置 `piAcp.serviceSocket`。

更多操作见[桌面使用指南](docs/usage.md)。

## 接入 Telegram

1. 准备 Bot token，建立私人群组并启用 **Topics / 话题**；将 Bot 加入群组，设为管理员并允许管理话题。
2. 在运行会话服务的服务器上，以同一账户执行：

   ```bash
   npm run telegram:setup
   ```

   使用服务发布包时，在解压目录执行 `node scripts/setup-telegram.mjs`。向导需要 curl，隐藏输入 token，通过群内配对码获取群组与用户 ID，并配置用户级自启动，无需 sudo。

3. 在群组 General 中发送 `/menu`，选择目录和 Agent 创建会话；进入对应话题后直接发文字。

| 命令                         | 用途                                                   |
| ---------------------------- | ------------------------------------------------------ |
| `/menu`                      | General 管理会话与全局开关；会话话题管理当前模型和任务 |
| `/new /绝对路径`             | 在服务器指定目录创建会话                               |
| `/sessions`、`/open 编号`    | 列出或打开已有会话                                     |
| `/history`、`/history all`   | 同步本话题更多或完整历史                               |
| `/sync`                      | 为已有会话建立话题并同步历史摘要                       |
| `/status`                    | 查看任务进度及待授权操作                               |
| `/stop`、`/interrupt 新指令` | 停止任务，或停止后发送新指令                           |
| `/notifications`、`/silent`  | 自动推送与静音开关                                     |

路径指服务器上的已有目录。默认允许服务账户可访问的任意目录，可配置目录限制；此限制不是工具执行沙箱。服务使用长轮询，无需开放入站端口。

Telegram 目前仅支持文字输入，输出与历史同步支持文字及部分图片。详细配置、代理与恢复说明见[Telegram 指南](docs/telegram.md)。

## 可选：Codex / Claude Code

在服务所在机器安装对应 ACP 适配器，并完成其认证：

```bash
npm install -g @agentclientprotocol/codex-acp
npm install -g @agentclientprotocol/claude-agent-acp
```

确保服务 PATH 可找到适配器，然后在插件顶部切换 Agent，或在 Telegram 新建会话时选择。自定义命令、参数及环境变量放在 `sessions.json` 的 `harnesses.codex` / `harnesses.claude` 中，见[配置说明](docs/session-service.md#codex--claude-配置)。功能以适配器声明的 ACP 能力为准，Pi 原生分支等专属能力不适用于其他 Agent。

## 使用边界

- **独立服务是必需组件**：VSIX 不包含原生 daemon，插件不自动安装或启动服务。插件、会话服务与 Telegram relay 需配套更新，当前要求 v4 服务协议。
- **不是沙箱**：Agent 可在服务账户权限范围内执行命令和修改文件；仅在可信项目与私人群组中使用，生产部署建议最小权限账户或容器隔离。
- **任务继续不等于故障续跑**：关闭 VS Code 不影响已提交任务；停止服务、服务器重启或掉电会中断任务，服务不会自动重放工具操作。
- **撤回有范围限制**：取消任务不撤销已发生的修改；手动撤回只覆盖已完整采集且无冲突的文件，不是多文件原子事务，也不回退模型上下文。
- **费用是估算值**：统计依赖 Agent 返回的用量与已配置价格，不等于供应商账单。Fast 优先级服务和自动会话命名可能产生额外费用。

## 文档与开发

- [文档索引](docs/README.md)：按使用、部署、开发主题导航。
- [桌面使用指南](docs/usage.md)：会话、模型、用量统计与后台任务扩展。
- [参与开发](CONTRIBUTING.md) · [架构](docs/architecture.md) · [测试与发布](docs/testing.md)。
- [更新记录](CHANGELOG.md)：版本变更与发布历史。

本项目采用 [MIT 许可证](LICENSE)。
