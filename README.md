# Pi ACP Workbench

在 VS Code 和 Telegram 中使用 Pi Agent 的对话插件。桌面与手机共享会话，Pi 由服务器上的独立服务执行，关闭 VS Code 后任务仍可继续。

## 功能

- **Telegram 远程控制**：每个会话对应一个群组话题，支持流式回复、完成通知、工具授权、停止任务，以及旧会话与历史消息同步。桌面输入和 Pi 回复可同步到手机。
- **桌面编码助手**：侧栏对话、模型可见性管理、思考强度与适配器支持的 Fast 选择、代码选区和文件上下文、粘贴图片、工具调用与 diff 查看。
- **每轮总 Diff**：输出末尾展示该轮工作区的文件和增删行数汇总，可展开补丁或打开编辑器对比；支持 Pi / Codex / Claude。[采集范围与限制](docs/turn-diff.md)。
- **会话管理**：保存与恢复历史、跨端继续对话、Pi 原生会话分支、Markdown 导出。
- **内容展示**：流式 Markdown、代码高亮、LaTeX 数学公式、Mermaid 图表，以及 token 用量与费用估算。
- **其他 Agent**：可选接入 Codex / Claude Code 的 ACP 适配器；Telegram 和独立会话服务目前用于 Pi。

## 配置 Pi 与 VS Code

### 1. 准备运行环境

Pi 服务使用 Rust 常驻进程，运行需要 **Linux x86_64、Node.js 22+ 和用户级 systemd**；从源码构建还需要 Rust/Cargo。使用 Remote SSH / WSL 时，以下操作在扩展宿主所在的机器、同一用户账户下完成。

```bash
npm install -g @earendil-works/pi-coding-agent
pi
```

在 Pi 中完成模型供应商登录或 API key 配置。插件和会话服务复用该账户的 Pi 凭据。

下载 [Release 中的 VSIX](https://github.com/ustc-mkh/pi-acp-workbench/releases/latest)，在 VS Code 执行 **Extensions: Install from VSIX…**，远程开发时安装到远端。安装后重新加载窗口。

### 2. 启动独立会话服务

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

编辑两个文件：

- `sessions.json`：将 `env.PI_ACP_PI_COMMAND` 改为 Pi 可执行文件的绝对路径；Pi 的代理变量也放在 `env` 中。
- `pi-sessions.service`：将仓库的占位路径替换为实际绝对路径，指向 `service-dist/pi-acp-session-daemon`。该目录同时包含 JS 适配器；Node 必须在服务的 PATH 中，否则在 `sessions.json` 显式设置 Node `command` 和适配器 `args`。

```bash
chmod 600 ~/.config/pi-acp-workbench/sessions.json
systemctl --user daemon-reload
systemctl --user enable --now pi-sessions
```

默认最多 3 个 Pi 工作进程，空闲 15 分钟回收；允许在当前账户有权限访问的任意目录运行，无需目录白名单。完整参数见 [会话服务配置](docs/session-service.md)。

### 3. 在插件中对话

打开并信任项目文件夹，点击活动栏 **π** → **新建会话**。Enter 发送，Shift+Enter 换行；编辑器右键可将选区加入对话。

插件默认连接 `~/.pi/pi-acp-workbench/service/sessions.sock`，自定义路径使用 VS Code 设置 `piAcp.serviceSocket`。历史记录默认保存在该服务器账户的 `~/.pi/pi-acp-workbench/history/`。

模型与 thinking 组合固定保存在 `~/.pi/pi-acp-workbench/preferences/{pi,codex,claude}.json`，按 harness 隔离、跨工作区共享。成功选择立即保存，新建自动读取；恢复旧会话保留其自身设置，不覆盖默认组合，实际发送或修改设置后才更新。关闭历史保存也不影响偏好。Pi 桌面与 Telegram 共用服务端偏好；自定义 `--data-dir` 时 Pi 使用该目录下的 `preferences/pi.json`。旧工作区偏好不自动迁移。

## 接入 Telegram

### 1. 创建 Bot 和话题群组

在 Telegram 的 **@BotFather** 中使用 `/newbot` 创建 Bot。建立私人群组并启用 **Topics / 话题**，将 Bot 加入群组、设为管理员并允许管理话题。

服务器需要能够访问 Telegram API；接入使用长轮询，无需开放入站端口。

### 2. 配置身份与 Token

创建 `~/.config/pi-acp-workbench/telegram.json`，替换下列数字 ID：

```json
{
  "chatId": -1001234567890,
  "allowedUserIds": [123456789],
  "workspaces": {
    "project": "/absolute/path/to/project"
  }
}
```

只有指定群组中的指定用户可以控制 Pi。`workspaces` 是可选快捷别名，不限制目录；也可直接用绝对路径创建会话。

创建 `~/.config/pi-acp-workbench/telegram.env`：

```text
PI_TELEGRAM_BOT_TOKEN=替换为BotFather给出的token
```

```bash
chmod 600 ~/.config/pi-acp-workbench/telegram.json ~/.config/pi-acp-workbench/telegram.env
cp examples/pi-telegram.service ~/.config/systemd/user/pi-telegram.service
```

编辑 `pi-telegram.service` 中的仓库绝对路径，指向 `service-dist/pi-acp-telegram-daemon`，然后启动：

```bash
systemctl --user daemon-reload
systemctl --user enable --now pi-telegram
loginctl enable-linger "$USER"
```

`linger` 让用户服务在退出 SSH 后继续运行。Token 不要提交到仓库；Pi 和 Telegram 服务使用同一账户。获取数字 ID、代理与部署排错见 [Telegram 指南](docs/telegram.md)。

### 3. 在手机上使用

在配置的群组中发送命令，进入对应话题后直接发文字即可继续对话。

| 命令                               | 用途                                                           |
| ---------------------------------- | -------------------------------------------------------------- |
| `/new project` 或 `/new /绝对路径` | 新建 Pi 会话及独立话题                                         |
| `/sync`                            | 自动创建话题并同步旧会话消息；大量历史可重复执行继续，自动去重 |
| `/sessions`、`/open 编号`          | 列出或打开已有会话                                             |
| `/status`                          | 查看任务状态、当前回复和待授权操作                             |
| `/stop`、`/interrupt 新消息`       | 停止任务，或停止后发送新指令                                   |
| `/notifications`                   | 自动投递总开关，默认开启；关闭后暂停自动回复与授权卡片         |
| `/silent`                          | 静音开关，默认关闭；开启后正常投递但不请求声音提醒             |
| `/help` 或 `/commands`             | 查看全部命令与说明                                             |

若希望收到回复但不响铃，保持 `/notifications` 开启，再开启 `/silent`。静音仍可能显示手机通知，实际效果受 Telegram 和系统设置影响。两个开关跨服务重启保留。

桌面与手机可使用同一会话，消息按顺序执行；关闭 VS Code 不会中断已提交任务。Telegram 目前支持文字输入，桌面的非文本附件只同步提示。更多操作见 [Telegram 指南](docs/telegram.md#日常使用)。

## 可选：Codex / Claude Code

在扩展宿主安装对应 ACP 适配器并完成其认证，然后在插件顶部切换 Agent：

```bash
npm install -g @agentclientprotocol/codex-acp
npm install -g @agentclientprotocol/claude-agent-acp
```

自定义启动路径、参数和环境变量使用 `piAcp.codex.command/args/env` 或 `piAcp.claude.command/args/env`。这些适配器由插件直接启动；实际功能取决于适配器支持的 ACP 能力。

详细资料：[架构说明](docs/architecture.md) · [开发与测试](docs/testing.md) · [更新记录](CHANGELOG.md)

长任务期间 context 占用会持续刷新并保存在会话快照中；终端工具实时显示输出，“全部修改”展开后显示采集说明。Telegram 通知保留 Markdown 格式。
