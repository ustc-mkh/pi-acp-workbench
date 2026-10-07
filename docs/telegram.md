# Telegram 接入

Telegram relay 是独立的常驻进程，关闭 VS Code 后仍可对话和执行任务。提供两个等价实现：`node dist/telegram-daemon.mjs`（Node.js，默认）和 `rust/target/release/pi-acp-telegram-daemon`（Rust，单二进制，空闲 RSS ~5 MB 对比 Node ~60-100 MB）。两者接受完全相同的 `--config` / `--data-dir` / `--discover` 参数与环境变量，读写相同的 `~/.pi/pi-acp-workbench/telegram/` 格式；切换只需改 systemd unit 的 `ExecStart` 并重启。Rust 构建：`cargo build --release --manifest-path rust/Cargo.toml`；等价性验证：`npm run test:contract:telegram`（默认测 Rust 二进制，`PI_TG_DAEMON="node dist/telegram-daemon.mjs"` 可跑 TS 实现）。一个私人群组 Topic 对应一个 Pi session；话题绑定、共享历史和待发送的完成通知都保存在服务器上。默认最多同时执行 3 个不同会话，同一会话一次执行一个任务。

本版支持文字输入、Pi slash 命令、节流流式回复、工具授权按钮、停止任务及完成/失败通知。暂不处理 Telegram 图片、语音或文件上传。回复使用纯文本，避免不完整 Markdown 导致 Telegram 拒绝流式更新。

## 配置与部署

### 1. 建立 Bot 和私人 Topics 群组

1. 在 Telegram 的官方 **@BotFather** 用 `/newbot` 创建专用 Bot，保存 token。
2. 建立私人群组，启用 **Topics / 话题**，将 Bot 加入并设为管理员，允许管理话题。管理员 Bot 可接收群组普通消息。
3. 将群组限定为自己或可信成员；群内所有成员都能看到回复，但只有配置的用户 ID 能控制 Pi。

服务使用 `getUpdates` 长轮询，只需服务器能够访问 `https://api.telegram.org`，不开放入站端口。该 Bot 不应同时用于另一个轮询器或 webhook 服务；已有 webhook 时服务会拒绝启动，不会擅自删除它。

协议依据：[Topics](https://core.telegram.org/bots/api#createforumtopic)、[长轮询](https://core.telegram.org/bots/api#getupdates)、[消息编辑](https://core.telegram.org/bots/api#editmessagetext)、[速率限制](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this)。

先完成 [Pi 会话服务部署](session-service.md)，Telegram 只负责消息接入。两者使用同一个服务器账户和数据目录。

### 2. 配置服务器

要求 Node.js 22+、已配置凭据的 Pi、当前仓库的构建产物。以实际执行 Pi 的服务器账户操作：

```bash
npm ci
npm run build
mkdir -p ~/.config/pi-acp-workbench
chmod 700 ~/.config/pi-acp-workbench
cp examples/telegram.json ~/.config/pi-acp-workbench/telegram.json
```

编辑配置，填入真实的群组 ID、自己的 Telegram 用户数字 ID 和允许使用的项目绝对路径：

```json
{
  "chatId": -1001234567890,
  "allowedUserIds": [123456789],
  "workspaces": {
    "workbench": "/absolute/path/to/pi-acp-workbench",
    "another": "/absolute/path/to/another-project"
  }
}
```

数字是占位符，必须替换。使用数字 ID，不使用昵称、用户名或“第一个给 Bot 发消息的人”作为授权依据。群组 ID 和用户 ID 必须同时匹配。匿名管理员、Bot、其他群组及其他用户的输入均不执行。

Token 只通过 `PI_TELEGRAM_BOT_TOKEN` 环境变量提供。可使用编辑器创建 `~/.config/pi-acp-workbench/telegram.env`，内容如下，再设置 `chmod 600 ~/.config/pi-acp-workbench/telegram.env`。不要把真实 token 放到仓库或命令参数中。

```text
PI_TELEGRAM_BOT_TOKEN=替换为BotFather给出的token
```

前台验证时，先将 token 放入当前 shell 的环境；例如在 Bash 中隐藏输入：

```bash
read -rsp 'Telegram bot token: ' PI_TELEGRAM_BOT_TOKEN
export PI_TELEGRAM_BOT_TOKEN
npm run telegram -- --config "$HOME/.config/pi-acp-workbench/telegram.json"
```

如果不知道 ID，在群组中向 Bot 发 `/help`，然后在服务**尚未启动**时执行 `npm run telegram -- --discover`。它只打印收到消息的 chatId / userId / threadId，不执行任务，也不打印 token。填入配置后启动服务，再重新发送 `/help`；首次启动会跳过配置前积压的消息。

Pi 的 `command` / `args` / `env`、代理和 `maxWorkers` 全部放在 `sessions.json`。旧 Telegram 配置中的这些字段必须移走；`maxConcurrent` 改为服务端的 `maxWorkers`。Telegram 配置仅保留群组、用户与可选工作区别名。`workspaces` 只是 `/new` 的快捷入口，不限制目录访问；可直接使用 `/new /absolute/path`。Token 不进入 Pi 服务或 Pi 子进程。

### 3. 作为用户服务常驻

```bash
mkdir -p ~/.config/systemd/user
cp examples/pi-telegram.service ~/.config/systemd/user/pi-telegram.service
```

编辑服务中的 `WorkingDirectory` 和 `ExecStart`，替换所有 `/absolute/path/...`。Node 的实际路径可用 `node -p process.execPath` 查询；systemd 不会自动加载交互式 shell 的 Node 版本管理器配置。随后运行：

```bash
systemctl --user daemon-reload
systemctl --user enable --now pi-telegram
journalctl --user -u pi-telegram -f
```

如果需要退出 SSH 后用户服务仍常驻，服务器还需为此账户启用 linger：`loginctl enable-linger "$USER"`（是否需要管理员权限取决于服务器配置）。关闭 VS Code 不影响这个独立服务；关闭服务器会停止任务。

使用 Rust 实现时把 `ExecStart` 改为 `/absolute/path/pi-acp-telegram-daemon --config /absolute/path/telegram.json`，其余不变（同一目录、锁与状态文件）。

升级代码后重新构建并执行 `systemctl --user restart pi-telegram`。只重启 Telegram 不会停止已提交到 Pi 服务的任务；尚未提交的内存排队消息不会重放。升级 Pi 服务前先等待任务完成。停止服务用 `systemctl --user stop pi-telegram`。

### 4. 桌面与手机共享会话

安装新插件并重载窗口。VS Code 和 Telegram 均连接 `pi-sessions.service`，不再通过桌面控制端点或抢占会话锁。关闭 VS Code 后任务继续，手机在对应话题直接发送消息即可。通知由执行服务保存到 outbox，Telegram `/notifications` 控制是否推送，无需桌面单独启用通知设置。

旧版本升级时先等待任务结束，退出旧插件连接并停止旧 Telegram，再按新配置启动会话服务与 Telegram。不要混用仍直接启动 Pi 的旧客户端。

## 存储与恢复边界

- `~/.pi/pi-acp-workbench/telegram/` 保存话题绑定、处理游标和完成通知记录，不保存 Bot token。新目录/文件权限为 0700/0600。
- `telegram/events/` 是磁盘待发送队列，可能含完整回复；成功发送后删除，启动中的服务清理超过 7 天的遗留记录。服务未运行时文件保留，重新启动后处理。
- 同一服务器上的同一 Bot 只有一个服务能持有轮询锁；Telegram 返回其他轮询器冲突时停止服务并报告。
- 任务游标在执行前落盘，优先避免重复运行工具。进程若恰好在落盘后、执行前崩溃，该条任务不会自动重放，请检查历史后手动重发。
- 完成通知在发送前落盘，网络恢复后重试。发送已成功但确认落盘前崩溃时可能重复通知，不会重跑 Pi 任务。
- 强制杀进程不会自动继续中断的模型请求；原生历史和本地记录保留。需要继续时在原话题发新消息。

`--data-dir` 可改用隔离数据目录，主要用于测试；改动后不会自动读取扩展默认目录。不要用真实 Bot/凭据运行自动测试。`PI_TELEGRAM_API_BASE` 与 `PI_TELEGRAM_PACE_MS` 是两个实现共有的测试钩子（覆盖 Bot API 基地址与发送节奏），永远不要出现在生产 unit 中。

## 维护与升级范围

共享历史要求快照含明确 harness 和原生会话 ID。旧版待重建快照、跨存储自动迁移和缺失元数据推断已移除；已有文件不会被自动删除。升级前可备份 `~/.pi/pi-acp-workbench/` 和 Pi 原生会话目录。维护源码后，应先验证、打包，再在任务空闲时更新插件与常驻服务。配置文件中的 token 和代理凭据始终留在用户配置目录，不进入仓库。

## 日常使用

以下命令在配置的私人 Topics 群组中使用，只有白名单中的用户能够控制 Pi。

发送 `/help` 或 `/commands` 可查看全部服务命令及简要说明；`/start` 也显示同一份帮助。Pi 自身的命令取决于已安装的扩展，其他斜杠命令会转交 Pi。

### 创建和继续会话

发送 `/new /ssddata/miaokehao/LLMRouterBench` 可在任意有效绝对目录新建会话，无需预先配置。也可发送 `/new workbench` 创建会话及独立话题；仅配置一个工作区时可以省略名称。在话题中直接发文字即可与对应 Pi session 对话，`/compact` 等未被服务占用的命令转交 Pi。当前仅支持文字输入，回复为纯文本。

`/sessions` 列出最近 50 个 Pi 会话（不限工作目录），`/open 12` 为已有编号会话创建或打开话题。也可以使用完整 Session ID。

### 将以前的会话同步到 Telegram

- `/sync`：自动为旧 Pi 会话创建话题，并在各自话题同步未导出的文字历史；已有话题也会补齐。每次最多 20 个会话、每个会话 100 条消息。重复 `/sync` 跳过已同步内容并继续，无需再发 `/history`。
- 在会话话题中发送 `/history`：同步最近 20 条用户/助手消息中尚未导出的部分。
- `/history all`：从早到晚分批同步文字历史，每次最多 100 条，可重复执行。

历史来自服务器的共享会话记录，不重新请求模型。同步位置跨服务重启保留，正常重复执行不会再次发送相同内容。消息发送成功但同步位置尚未落盘时进程崩溃，最后一条可能重复。仅同步文字，不复制思考过程、工具输出和图片原文。历史同步是主动查询，即使关闭自动推送仍会回复；静音发送仍可能出现在手机通知栏。

### 桌面与手机同时使用

桌面提交的每轮消息会连同你的文字输入一起推送到 Telegram，标记为“你（VS Code）”与“Pi”；非文本附件只显示提示，原内容在 VS Code 查看。手机提交的消息不再次转发用户输入，避免重复。

两端连接同一个 Pi 会话服务。在对应话题直接发消息即可，桌面仍可查看输出并处理授权。关闭 VS Code 不会中断已提交任务，手机继续使用同一 Session ID。

- 忙碌时，新消息排队；不同会话受服务的工作进程上限限制。
- `/stop` 停止当前任务并取消已排队请求；取消不撤销已发生的文件修改。
- `/interrupt 新指令` 停止后执行新指令。
- `/status` 查看最近输出与待处理授权；任一端处理授权后另一端不能重复批准。
- 桌面和手机共享服务会话，不存在接管操作；`/takeover`、`/desktop` 接口已删除。

每个话题最多 20 条手机消息排队，Pi 服务全局最多接受 100 个排队或执行请求。尚未执行的内存队列不会在重启后重放。Pi 服务重启会中断任务并保留中断状态；Telegram 接入重启不会取消已交给 Pi 服务的任务。

### 全局推送开关

发送 `/notifications`，点击 **开启全部推送 / 暂停全部推送**。开关作用于所有话题，默认开启，服务重启后保留显式设置；已有 `false` 设置不会因升级被覆盖。

关闭时停止自动发送 Agent 回复、完成/失败通知和工具授权卡片；任务仍继续，内容保存在会话历史中。可随时用 `/history` 或 `/status` 主动查询；需要授权时可通过 `/status` 取得按钮，原有授权超时仍生效，不会自动批准。

开启后发送后续进度和完成结果（含本轮修改的文件/行数汇总），不自动发送完整补丁，也不批量补发已处理的旧通知。长回复分段发送；生成中合并增量消息，群组写入约每 3 秒最多一次。关闭前已经提交给 Telegram 的请求可能仍会到达。

这个开关控制 Bot 是否自动发送消息，不修改手机系统或 Telegram 群组的通知设置。开启推送后，是否响铃仍由手机设置决定。群组中的白名单用户共享此开关，操作反馈和主动查询不受自动推送开关限制。

### 静音发送开关

Telegram Bot API 的 [`sendMessage.disable_notification`](https://core.telegram.org/bots/api#sendmessage) 支持正常发送消息但不播放通知声音。官方说明用户仍会收到无声通知，因此不能承诺完全不显示通知栏、横幅或角标；Bot 也不能替用户修改手机系统或群组通知设置。

发送 `/silent`，点击开启或关闭静音。默认关闭，设置跨重启保留，所有话题共用。静音开启后，完成通知、授权卡片和普通操作回复使用 `disable_notification=true`；流式预览、历史同步和帮助菜单始终静音。

`/notifications` 仍是自动投递总开关：关闭后暂停自动回复，`/silent` 不会重新开启投递。若只想接收无声回复，请保持 `/notifications` 开启，再开启 `/silent`。关闭静音只允许正常提醒，实际声音仍由手机与群组设置决定。

### 常见情况

- 一直提示会话占用：确认旧版插件/旧 Telegram 已退出，不要抢锁；检查 Pi 会话服务日志。
- 已关闭推送，Agent 等待授权：发送 `/status`，在卡片中选择授权或取消；也可 `/stop`。
- 模型请求失败或重试耗尽：按错误提示检查 Pi 凭据和服务代理配置。systemd 不继承交互式终端环境，参见配置文档。
- `/stop` 对工具的取消能力取决于 Pi；取消不撤销工具已经完成的文件修改。

持久化写入失败时，通知、话题绑定及推送开关都不会在内存中假定成功。通知发送成功但确认未保存时可能重复；话题创建成功但绑定保存失败时可能留下未绑定的话题。先恢复服务器磁盘权限或空间，再重试操作。
