# Telegram 配置与部署

Telegram relay 是独立的 Node.js 常驻进程，关闭 VS Code 后仍可对话和执行任务。一个私人群组 Topic 对应一个 Pi session；话题绑定、共享历史和待发送的完成通知都保存在服务器上。默认最多同时执行 3 个不同会话，同一会话一次执行一个任务。

日常命令、手机接管和推送开关见 [使用指南](telegram-usage.md)。

本版支持文字输入、Pi slash 命令、节流流式回复、工具授权按钮、停止任务及完成/失败通知。暂不处理 Telegram 图片、语音或文件上传。回复使用纯文本，避免不完整 Markdown 导致 Telegram 拒绝流式更新。

## 1. 建立 Bot 和私人 Topics 群组

1. 在 Telegram 的官方 **@BotFather** 用 `/newbot` 创建专用 Bot，保存 token。
2. 建立私人群组，启用 **Topics / 话题**，将 Bot 加入并设为管理员，允许管理话题。管理员 Bot 可接收群组普通消息。
3. 将群组限定为自己或可信成员；群内所有成员都能看到回复，但只有配置的用户 ID 能控制 Pi。

服务使用 `getUpdates` 长轮询，只需服务器能够访问 `https://api.telegram.org`，不开放入站端口。该 Bot 不应同时用于另一个轮询器或 webhook 服务；已有 webhook 时服务会拒绝启动，不会擅自删除它。

协议依据：[Topics](https://core.telegram.org/bots/api#createforumtopic)、[长轮询](https://core.telegram.org/bots/api#getupdates)、[消息编辑](https://core.telegram.org/bots/api#editmessagetext)、[速率限制](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this)。

先完成 [Pi 会话服务部署](session-service.md)，Telegram 只负责消息接入。两者使用同一个服务器账户和数据目录。

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

升级代码后重新构建并执行 `systemctl --user restart pi-telegram`。只重启 Telegram 不会停止已提交到 Pi 服务的任务；尚未提交的内存排队消息不会重放。升级 Pi 服务前先等待任务完成。停止服务用 `systemctl --user stop pi-telegram`。

## 4. 桌面手机共享会话

安装新插件并重载窗口。VS Code 和 Telegram 均连接 `pi-sessions.service`，不再通过桌面控制端点或抢占会话锁。关闭 VS Code 后任务继续，手机在对应话题直接发送消息即可。通知由执行服务保存到 outbox，Telegram `/notifications` 控制是否推送，无需桌面单独启用通知设置。

旧版本升级时先等待任务结束，退出旧插件连接并停止旧 Telegram，再按新配置启动会话服务与 Telegram。不要混用仍直接启动 Pi 的旧客户端。

## 存储与恢复边界

- `~/.pi/pi-acp-workbench/telegram/` 保存话题绑定、处理游标和完成通知记录，不保存 Bot token。新目录/文件权限为 0700/0600。
- `telegram/events/` 是磁盘待发送队列，可能含完整回复；成功发送后删除，启动中的服务清理超过 7 天的遗留记录。服务未运行时文件保留，重新启动后处理。
- 同一服务器上的同一 Bot 只有一个服务能持有轮询锁；Telegram 返回其他轮询器冲突时停止服务并报告。
- 任务游标在执行前落盘，优先避免重复运行工具。进程若恰好在落盘后、执行前崩溃，该条任务不会自动重放，请检查历史后手动重发。
- 完成通知在发送前落盘，网络恢复后重试。发送已成功但确认落盘前崩溃时可能重复通知，不会重跑 Pi 任务。
- 强制杀进程不会自动继续中断的模型请求；原生历史和本地记录保留。需要继续时在原话题发新消息。

`--data-dir` 可改用隔离数据目录，主要用于测试；改动后不会自动读取扩展默认目录。不要用真实 Bot/凭据运行自动测试。

## 维护与升级范围

共享历史要求快照含明确 harness 和原生会话 ID。旧版待重建快照、跨存储自动迁移和缺失元数据推断已移除；已有文件不会被自动删除。升级前可备份 `~/.pi/pi-acp-workbench/` 和 Pi 原生会话目录。维护源码后，应先验证、打包，再在任务空闲时更新插件与常驻服务。配置文件中的 token 和代理凭据始终留在用户配置目录，不进入仓库。
