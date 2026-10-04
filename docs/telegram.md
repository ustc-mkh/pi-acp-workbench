# 手机 Telegram 控制 Pi

Telegram relay 是独立的 Node.js 常驻进程，关闭 VS Code 后仍可对话和执行任务。一个私人群组 Topic 对应一个 Pi session；话题绑定、共享历史和待发送的完成通知都保存在服务器上。默认最多同时执行 3 个不同会话，同一会话一次执行一个任务。

本版支持文字输入、Pi slash 命令、节流流式回复、工具授权按钮、停止任务及完成/失败通知。暂不处理 Telegram 图片、语音或文件上传。回复使用纯文本，避免不完整 Markdown 导致 Telegram 拒绝流式更新。

## 1. 建立 Bot 和私人 Topics 群组

1. 在 Telegram 的官方 **@BotFather** 用 `/newbot` 创建专用 Bot，保存 token。
2. 建立私人群组，启用 **Topics / 话题**，将 Bot 加入并设为管理员，允许管理话题。管理员 Bot 可接收群组普通消息。
3. 将群组限定为自己或可信成员；群内所有成员都能看到回复，但只有配置的用户 ID 能控制 Pi。

服务使用 `getUpdates` 长轮询，只需服务器能够访问 `https://api.telegram.org`，不开放入站端口。该 Bot 不应同时用于另一个轮询器或 webhook 服务；已有 webhook 时服务会拒绝启动，不会擅自删除它。

协议依据：[Topics](https://core.telegram.org/bots/api#createforumtopic)、[长轮询](https://core.telegram.org/bots/api#getupdates)、[消息编辑](https://core.telegram.org/bots/api#editmessagetext)、[速率限制](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this)。

## 2. 配置服务器

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
  },
  "maxConcurrent": 3
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

默认使用 `dist/pi-adapter.mjs`。Pi 不在服务的 PATH 时，可在配置的 `env` 中设置 `PI_ACP_PI_COMMAND` 为绝对路径。可选 `command` / `args` 指定其他 Pi ACP 适配器，但其并发索引安全由该适配器负责；建议保留内置适配器。`maxConcurrent` 范围为 1–8。Token 不会作为环境变量内容传给 Pi 子进程。

## 3. 作为用户服务常驻

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

升级代码后重新构建并执行 `systemctl --user restart pi-telegram`。重启会停止正在运行的手机任务，先用 `/status` 检查。停止服务用 `systemctl --user stop pi-telegram`。

## 4. 手机端操作

| 命令 | 行为 |
| --- | --- |
| `/help` | 显示用法 |
| `/new workbench` | 在指定工作区创建 Pi session 和独立话题；仅一个工作区时可省略名称 |
| `/sessions` | 列出允许工作区内最近 50 个 Pi 会话 |
| `/open 12` | 为已有 `#012` 会话创建/打开话题；也可使用完整 Session ID |
| 话题中直接发文字 | 在该 session 中执行任务 |
| `/compact` 等 Pi 命令 | 转交给当前话题的 Pi session |
| `/status` | 查看该话题是否正在执行手机任务 |
| `/stop` | 取消该话题的手机任务；5 秒未停止则终止连接 |

每个话题只绑定一个会话，不通过“当前选中的全局会话”路由输入。切换手机话题即可切换 session。绑定在服务重启后保留；已有历史不会自动批量回发到 Telegram。

生成期间更新一条静音预览消息，并合并快速到达的 token；群组输出约每 3 秒最多一个 API 写操作，多会话时会更慢。结束后完整回复分段落地，再发送一条**非静音**的完成、停止或失败通知。手机是否弹出通知仍由 Telegram 的群组静音和系统通知设置决定。长回复可能需要额外时间发送。

Agent 发起权限请求时，话题中显示工具说明和原始选项按钮；按钮绑定用户白名单、话题、会话和当次请求，5 分钟后失效。没有授权请求的 Pi 工具仍按 Pi 自身的权限规则执行；本服务不是工具沙箱。

## 5. 与 VS Code 共享及桌面通知

服务与扩展使用同一服务器账户和默认共享历史目录 `~/.pi/pi-acp-workbench/history`。手机任务执行时持有会话独占锁，结束即保存并释放。VS Code 可从历史中查看这些会话，并在释放后继续。

如果会话当前由 VS Code 占用，手机会收到占用提示；先在 VS Code 点击**释放会话**再发送。反过来，手机正在执行时，VS Code 只读查看。此版不抢占已有桌面连接，也不从手机批准或停止桌面持有的任务。

要让**桌面发起的 Pi 任务**也发送流式进度和完成通知，在 VS Code 用户设置中启用：

```json
{
  "piAcp.sharedHistory": true,
  "piAcp.persistHistory": true,
  "piAcp.telegram.desktopNotifications": true
}
```

此功能默认关闭。扩展只向本机待发送目录写入 Pi 回复，独立服务负责转发到相应话题；Token 无需交给 VS Code。配置必须允许该项目目录。关闭历史持久化或关闭通知会停止当前桌面输出的后续发布，不能撤回已发到 Telegram 的内容。桌面窗口本身关闭会终止由该窗口持有的任务；希望脱离桌面继续执行的任务应从手机发起。

## 存储与恢复边界

- `~/.pi/pi-acp-workbench/telegram/` 保存话题绑定、处理游标和完成通知记录，不保存 Bot token。新目录/文件权限为 0700/0600。
- `telegram/events/` 是磁盘待发送队列，可能含完整回复；成功发送后删除，启动中的服务清理超过 7 天的遗留记录。服务未运行时文件保留，重新启动后处理。
- 同一服务器上的同一 Bot 只有一个服务能持有轮询锁；Telegram 返回其他轮询器冲突时停止服务并报告。
- 任务游标在执行前落盘，优先避免重复运行工具。进程若恰好在落盘后、执行前崩溃，该条任务不会自动重放，请检查历史后手动重发。
- 完成通知在发送前落盘，网络恢复后重试。发送已成功但确认落盘前崩溃时可能重复通知，不会重跑 Pi 任务。
- 强制杀进程不会自动继续中断的模型请求；原生历史和本地记录保留。需要继续时在原话题发新消息。

`--data-dir` 可改用隔离数据目录，主要用于测试；改动后不会自动读取扩展默认目录。不要用真实 Bot/凭据运行自动测试。
