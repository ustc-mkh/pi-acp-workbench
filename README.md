# Pi ACP Workbench

在 VS Code 和 Telegram 中使用 Pi Agent 的对话插件。桌面与手机共享会话，Pi 由服务器上的独立服务执行，关闭 VS Code 后任务仍可继续。

## 功能

- **Telegram 远程控制**：每个会话对应一个群组话题，支持流式回复、完成通知、工具授权、停止任务，以及旧会话与历史消息同步。桌面输入和 Pi 回复可同步到手机。
- **桌面编码助手**：侧栏对话、模型可见性管理、思考强度与适配器支持的 Fast 选择、代码选区和文件上下文、粘贴图片、工具调用与 diff 查看。
- **每轮总 Diff**：输出末尾展示该轮工作区的文件和增删行数汇总，可展开补丁或打开编辑器对比；支持 Pi / Codex / Claude。[采集范围与限制](docs/turn-diff.md)。
- **会话管理**：保存与恢复历史、跨端继续对话、Pi 原生会话分支、Markdown 导出。
- **内容展示**：流式 Markdown、代码高亮、LaTeX 数学公式、Mermaid 图表，以及 token 用量与费用估算。Codex / Claude 可统计适配器上报的输入、输出和缓存用量，显示上下文占用；只记录启用后经本服务执行的轮次，不回填原生历史。
- **其他 Agent**：可选接入 Codex / Claude Code 的 ACP 适配器；三种 Agent 共用独立会话服务，Telegram 可打开已有会话。

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

- `sessions.json`：启动时动态查找 `pi`，无需填写安装路径：优先 PATH，再查找当前账户的 Pi 托管安装、Node 所在目录和 npm 实际全局 prefix；Pi 的代理变量放在 `env` 中。需要指定某个 Pi 安装时设置 `env.PI_ACP_PI_COMMAND`，有效覆盖优先，失效路径自动回退并记录提示。
- `pi-sessions.service`：将仓库的占位路径替换为实际绝对路径，指向 `service-dist/pi-acp-session-daemon`。该目录同时包含 JS 适配器；Node 必须在服务的 PATH 中，否则在 `sessions.json` 显式设置 Node `command` 和适配器 `args`。

示例 unit 的 PATH 包含 `%h/.local/bin` 和常用系统安装目录，`%h` 由 systemd 展开为运行账户的 home。适配器也支持从 `PI_CODING_AGENT_DIR`（默认 `~/.pi/agent`）或 `PI_MANAGED_INSTALL_ROOT` 推导托管启动器位置。使用 nvm、Volta 时仍需确保服务可以启动 Node；systemd 不会读取交互式 shell 的启动文件。不要把某台机器的 Pi 绝对路径复制到其他机器。

```bash
chmod 600 ~/.config/pi-acp-workbench/sessions.json
systemctl --user daemon-reload
systemctl --user enable --now pi-sessions
```

默认最多 3 个 Pi 工作进程，空闲 15 分钟回收；允许在当前账户有权限访问的任意目录运行，无需目录白名单。完整参数见 [会话服务配置](docs/session-service.md)。

### 3. 在插件中对话

打开并信任项目文件夹，点击活动栏 **π** → **新建会话**。Enter 发送，Shift+Enter 换行；编辑器右键可将选区加入对话。

工作时模型输出直接显示在滚动消息流中，连续的工具调用与思考默认归为一个折叠组；结束后整轮过程自动折叠，保留最终回答。运行中可以新建对话、切换历史会话或 Harness，原任务在服务中继续执行，切回后可查看进度或停止。

历史列表默认显示最新 4 个会话，底部可展开更多或收回。打开后会一直保持展开，选择会话、刷新、发送消息或重新连接均不会收起；再次点击历史记录按钮才会关闭。

Pi 的 `/compact` 成功后只显示压缩成功，不输出内部上下文摘要。压缩后的上下文占用暂时显示等待更新，下一次模型回复后恢复实际占用。

计费统计的默认价格直接读取 Pi 返回的模型配置，更新 Pi 或模型价格后刷新统计即可使用最新单价。模型价格设置中的用户自定义价格优先；“恢复默认”移除该项覆盖并使用 Pi 的最新价格。没有 Pi 默认价或自定义价格的模型显示未定价，不套用静态价格表。

Telegram 可在仓库执行 `npm run telegram:setup`，按向导输入 token、在话题群发送配对码，即可完成配置和用户级自启动，无需 sudo。详见 [Telegram 配置](docs/telegram.md#一键配置推荐)。

右上角的模型管理按钮可选择输入框模型列表中显示的模型。Pi 使用 OpenAI / Codex Responses 时提供 Fast mode 开关，请求优先级服务，可能增加费用；是否可用取决于模型、账户和 Pi 扩展支持。它与思考级别独立，默认关闭，设置随原生会话分支恢复。

插件默认连接 `~/.pi/pi-acp-workbench/service/sessions.sock`，自定义路径使用 VS Code 设置 `piAcp.serviceSocket`。历史记录默认保存在该服务器账户的 `~/.pi/pi-acp-workbench/history/`。

模型与 thinking 组合固定保存在 `~/.pi/pi-acp-workbench/preferences/{pi,codex,claude}.json`，按 harness 隔离、跨工作区共享。成功选择立即保存，新建自动读取；恢复旧会话保留其自身设置，不覆盖默认组合，实际发送或修改设置后才更新。关闭历史保存也不影响偏好。Pi 桌面与 Telegram 共用服务端偏好；自定义 `--data-dir` 时 Pi 使用该目录下的 `preferences/pi.json`。旧工作区偏好不自动迁移。

## 接入 Telegram

### 1. 准备 Bot 和话题群组

已有 Bot token 可直接使用。建立私人群组并启用 **Topics / 话题**，将 Bot 加入群组、设为管理员并允许管理话题。服务器需能访问 Telegram API；使用长轮询，无需开放入站端口。

### 2. 运行配置向导

在运行 Pi 的服务器上，以同一用户账户执行：

```bash
# 在本仓库中运行
npm run telegram:setup
```

如果使用包含配置脚本的服务发布包，在解压目录运行 `node scripts/setup-telegram.mjs`，无需安装 npm 依赖。

按提示隐藏输入 token，用个人身份在群里发送终端显示的配对码，再确认应用配置。向导自动获取群组和用户 ID、保存配置并启动用户级服务，全程无需 sudo。Node.js 22+、Pi、curl、用户级 systemd 和服务程序需事先安装。

首次配置无需选择或登记项目目录。完成后用 `/menu` 的按钮向导选择目录和 Harness，或发送 `/new /项目的绝对路径` 直接选择 Harness，可在当前服务账户能访问的任意已有目录创建会话；换项目无需重新配置。路径指的是服务器上的目录。

向导尝试启用 linger，使服务退出登录后继续运行并在开机时启动；若本机策略不允许，会明确提示，目前只保证登录后自启动。手工配置、代理、已有目录限制的取消方式见 [Telegram 指南](docs/telegram.md)。

### 3. 在手机上使用

在配置的群组中发送命令，进入对应话题后直接发文字即可继续对话。

| 命令                         | 用途                                                           |
| ---------------------------- | -------------------------------------------------------------- |
| `/menu`、`/settings`         | 按钮选择模型、思考强度、新建 Harness 和会话                    |
| `/history`、`/history all`   | 手动补充本话题更多或完整历史                                   |
| `/new /绝对路径`             | 选择 Harness，在指定服务器目录新建会话及独立话题               |
| `/sync`                      | 最新 5 个会话各取最后 10 条，其余各取最后 2 条；setup 同样处理 |
| `/sessions`、`/open 编号`    | 列出或打开已有会话                                             |
| `/status`                    | 查看任务状态、当前回复和待授权操作                             |
| `/stop`、`/interrupt 新消息` | 停止任务，或停止后发送新指令                                   |
| `/notifications`             | 自动投递总开关，默认开启；关闭后暂停自动回复与授权卡片         |
| `/silent`                    | 静音开关，默认关闭；开启后正常投递但不请求声音提醒             |
| `/help` 或 `/commands`       | 查看全部命令与说明                                             |

若希望收到回复但不响铃，保持 `/notifications` 开启，再开启 `/silent`。静音仍可能显示手机通知，实际效果受 Telegram 和系统设置影响。两个开关跨服务重启保留。

桌面与手机可使用同一会话，消息按顺序执行；关闭 VS Code 不会中断已提交任务。Telegram 目前支持文字输入，桌面的非文本附件只同步提示。更多操作见 [Telegram 指南](docs/telegram.md#日常使用)。

## 可选：Codex / Claude Code

在扩展宿主安装对应 ACP 适配器并完成其认证，然后在插件顶部切换 Agent：

```bash
npm install -g @agentclientprotocol/codex-acp
npm install -g @agentclientprotocol/claude-agent-acp
```

三种 Agent 都由 Rust daemon 托管，插件只通过 socket 连接。自定义启动路径、参数和环境变量放在 `sessions.json` 的 `harnesses.codex` / `harnesses.claude` 中；实际功能取决于适配器声明的 ACP 能力。配置示例见 [会话服务](docs/session-service.md#codex--claude-配置)。需要将插件与 v3 daemon 一起更新，没有文件写入降级路径。

详细资料：[全部文档](docs/README.md) · [架构说明](docs/architecture.md) · [开发与测试](docs/testing.md) · [服务发布与回滚](docs/service-release.md) · [更新记录](CHANGELOG.md)

长任务期间 context 占用会持续刷新并保存在会话快照中；终端工具实时显示输出，“全部修改”展开后显示采集说明。Telegram 通知保留 Markdown 格式。
