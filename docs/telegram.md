# Telegram 接入

Telegram relay 是独立的 Rust 常驻进程，关闭 VS Code 后仍可对话和执行任务。生产入口为 `service-dist/pi-acp-telegram-daemon`，通过 `npm run build:services` 构建；不再发布 Node relay。接受 `--config` / `--data-dir` / `--discover` 参数与 Token 环境变量，继续读写 `~/.pi/pi-acp-workbench/telegram/` 的既有格式。契约验证为 `npm run test:contract:telegram`，真实 Rust 会话服务与 relay 集成为 `npm run test:integration:rust`。一个私人群组 Topic 对应一个服务会话（Pi、Codex 或 Claude）；话题绑定、共享历史和待发送的完成通知都保存在服务器上。默认最多同时执行 3 个不同会话，同一会话一次执行一个任务。

本版支持文字输入、Pi slash 命令、节流流式回复、工具授权按钮、停止任务及完成/失败通知。暂不处理 Telegram 图片、语音或文件上传。回复将 Markdown 转成 Telegram 原生 entities；流式不完整片段按安全文本处理，长代码与中文 / emoji 分块保留格式。

## 配置与部署

### 1. 建立 Bot 和私人 Topics 群组

1. 在 Telegram 的官方 **@BotFather** 用 `/newbot` 创建专用 Bot，保存 token。
2. 建立私人群组，启用 **Topics / 话题**，将 Bot 加入并设为管理员，允许管理话题。管理员 Bot 可接收群组普通消息。
3. 将群组限定为自己或可信成员；群内所有成员都能看到回复，但只有配置的用户 ID 能控制 Pi。

服务使用 `getUpdates` 长轮询，只需服务器能够访问 `https://api.telegram.org`，不开放入站端口。该 Bot 不应同时用于另一个轮询器或 webhook 服务；已有 webhook 时服务会拒绝启动，不会擅自删除它。

协议依据：[Topics](https://core.telegram.org/bots/api#createforumtopic)、[长轮询](https://core.telegram.org/bots/api#getupdates)、[消息编辑](https://core.telegram.org/bots/api#editmessagetext)、[速率限制](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this)。

先完成 [Pi 会话服务部署](session-service.md)，Telegram 只负责消息接入。两者使用同一个服务器账户，以便访问私有 Unix socket。默认使用相同数据目录；relay 可配置绝对路径 `serviceSocket` 连接会话服务，并用独立 `--data-dir` 保存自己的状态。

### 2. 配置服务器

仅支持 Linux x86_64，要求 Node.js 22+、已配置凭据的 Pi、当前仓库的 Rust 服务构建产物；从源码构建需要 Rust/Cargo。以实际执行 Pi 的服务器账户操作：

```bash
npm ci
npm run build:services
mkdir -p ~/.config/pi-acp-workbench
chmod 700 ~/.config/pi-acp-workbench
cp examples/telegram.json ~/.config/pi-acp-workbench/telegram.json
```

编辑配置，填入真实的群组 ID、自己的 Telegram 用户数字 ID 和工作区别名对应的项目绝对路径：

```json
{
  "chatId": -1001234567890,
  "allowedUserIds": [123456789],
  "workspaces": {
    "workbench": "/absolute/path/to/pi-acp-workbench",
    "another": "/absolute/path/to/another-project"
  },
  "restrictToWorkspaces": true
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

Pi 的 `command` / `args` / `env`、代理和 `maxWorkers` 全部放在 `sessions.json`。旧 Telegram 配置中的这些字段必须移走；`maxConcurrent` 改为服务端的 `maxWorkers`。Telegram 配置包含群组、用户、可选工作区别名、`serviceSocket` 及 `restrictToWorkspaces`。目录限制开关缺省为 `false`。未设置限制时，`workspaces` 只是 `/new` 的快捷入口，也可直接使用 `/new /absolute/path`。仓库生产示例默认 `restrictToWorkspaces:true`，仅允许列出的工作目录。可配置 `"restrictToWorkspaces": true`，使 `/new` 只接受 `workspaces` 中声明的目录根（不包含子目录）；绝对路径会解析真实路径后匹配，拒绝符号链接越界。`/sessions` 和 `/open` 同样只显示或连接这些目录中的会话；已有话题中的状态、历史、任务、停止和授权请求也会重新检查工作区范围。无法解析的目录会被拒绝。此配置不是 Pi 命令的文件系统沙箱，仍应只允许可信用户，必要时用独立系统账户或容器隔离。Token 不进入 Pi 服务或 Pi 子进程。

### 3. 作为用户服务常驻

```bash
mkdir -p ~/.config/systemd/user
cp examples/pi-telegram.service ~/.config/systemd/user/pi-telegram.service
```

编辑服务中的 `WorkingDirectory` 和 `ExecStart`，替换所有 `/absolute/path/...`，指向 `service-dist/pi-acp-telegram-daemon`。会话服务的 Node 工作进程另需正确的 PATH 或显式 `command`；systemd 不会自动加载交互式 shell 的 Node 版本管理器配置。随后运行：

```bash
systemctl --user daemon-reload
systemctl --user enable --now pi-telegram
journalctl --user -u pi-telegram -f
```

如果需要退出 SSH 后用户服务仍常驻，服务器还需为此账户启用 linger：`loginctl enable-linger "$USER"`（是否需要管理员权限取决于服务器配置）。关闭 VS Code 不影响这个独立服务；关闭服务器会停止任务。

升级代码前先等任务结束并停止两个服务，重新执行 `npm run build:services`，然后依次启动会话服务与 Telegram。只重启 Telegram 不会停止已提交到 Pi 服务的任务；durable 入队但尚未开始的消息会在重启后继续；已开始而没有完成记录的消息不会自动重放。升级 Pi 服务前先等待任务完成。停止服务用 `systemctl --user stop pi-telegram`。

### 4. 桌面与手机共享会话

安装新插件并重载窗口。VS Code 和 Telegram 均连接 `pi-sessions.service`，不再通过桌面控制端点或抢占会话锁。关闭 VS Code 后任务继续，手机在对应话题直接发送消息即可。通知由执行服务保存到 outbox，Telegram `/notifications` 控制是否推送，无需桌面单独启用通知设置。

旧版本升级时先等待任务结束，退出旧插件连接并停止旧 Telegram，再按新配置启动会话服务与 Telegram。不要混用仍直接启动 Pi 的旧客户端。

## 存储与恢复边界

- `~/.pi/pi-acp-workbench/telegram/` 保存话题绑定、处理游标和完成通知记录，不保存 Bot token。新目录/文件权限为 0700/0600。
- outbox 由会话服务持久化，relay 通过 `events.next` 逐项读取、在保存投递记录后通过 `events.ack` 确认。队列可能含完整回复；服务删除确认过的对应版本，并清理超过 7 天的记录。relay 不访问队列目录，离线后重新连接可继续投递。
- 同一服务器上的同一 Bot 只有一个服务能持有轮询锁；Telegram 返回其他轮询器冲突时停止服务并报告。
- 接收 update 与游标同一事务落盘；pending 消息可在重启后继续，执行前标记 started。重启发现 started 时标记 interrupted 并提示结果未确认，不自动重复运行工具，请先检查历史和工作区。
- 完成通知在发送前落盘，网络恢复后重试。发送已成功但确认落盘前崩溃时可能重复通知，不会重跑 Pi 任务。
- 强制杀进程不会自动继续中断的模型请求；原生历史和本地记录保留。需要继续时在原话题发新消息。

`--data-dir` 可改用隔离数据目录，主要用于测试；改动后不会自动读取默认目录；连接其他数据目录中的会话服务须显式设置 `serviceSocket`。不要用真实 Bot/凭据运行自动测试。生产实现忽略 `PI_TELEGRAM_API_BASE` 与 `PI_TELEGRAM_PACE_MS`，固定使用 Telegram 官方端点和 3100 ms 发送间隔。Rust 契约及集成测试单独构建 `contract-test` feature 到 `rust/target/contract/`。测试二进制支持这两个环境变量，禁止部署到生产。

## 维护与升级范围

共享历史要求快照含明确 harness 和原生会话 ID。旧版待重建快照、跨存储自动迁移和缺失元数据推断已移除；已有文件不会被自动删除。升级前可备份 `~/.pi/pi-acp-workbench/` 和 Pi 原生会话目录。维护源码后，应先验证、打包，再在任务空闲时更新插件与常驻服务。配置文件中的 token 和代理凭据始终留在用户配置目录，不进入仓库。

## 日常使用

以下命令在配置的私人 Topics 群组中使用，只有白名单中的用户能够控制 Pi。

发送 `/help` 或 `/commands` 可查看全部服务命令及简要说明；`/start` 也显示同一份帮助。Pi 自身的命令取决于已安装的扩展，其他斜杠命令会转交 Pi。

### 创建和继续会话

发送 `/new /absolute/path/to/project` 可按绝对路径创建会话；开启 restrictToWorkspaces 时必须匹配配置目录根，未开启时可使用当前账户能够访问的有效目录。也可发送 `/new workbench` 创建会话及独立话题；仅配置一个工作区时可以省略名称。在话题中直接发文字即可与对应 Pi session 对话，`/compact` 等未被服务占用的命令转交 Pi。当前仅支持文字输入，回复支持 Markdown entities。

`/sessions` 列出最近 50 个各 harness 的会话（开启工作区限制时仅显示允许目录），`/open 12` 为已有编号会话创建或打开话题。也可以使用完整 Session ID。

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

- 提示忙碌或连接已满：同会话任务会串行执行；检查正在运行的任务、客户端连接和 Pi 会话服务日志。当前版本允许多个客户端附着同一会话，没有客户端独占租约。
- 已关闭推送，Agent 等待授权：发送 `/status`，在卡片中选择授权或取消；也可 `/stop`。
- 模型请求失败或重试耗尽：按错误提示检查 Pi 凭据和服务代理配置。systemd 不继承交互式终端环境，参见配置文档。
- `/stop` 对工具的取消能力取决于 Pi；取消不撤销工具已经完成的文件修改。

持久化写入失败时，通知、话题绑定及推送开关都不会在内存中假定成功。通知发送成功但确认未保存时可能重复；话题创建成功但绑定保存失败时可能留下未绑定的话题。先恢复服务器磁盘权限或空间，再重试操作。

输出支持粗体、斜体、删除线、代码块、链接与列表；使用原生 entities 而不是把模型输出作为未转义的 MarkdownV2，中文/emoji 分块仍保留格式。工具授权和非文本附件提示由 relay 根据通用事件字段生成。

### 接收队列与异常恢复

消息和接收游标一起持久化后才开始处理。未开始的消息可在重启后继续；已开始但没有完成记录的消息会提示“结果未确认”，不会自动重放，请先用 `/status` 检查。普通处理槽为 64，停止/中断及按钮回调另有 8 个槽；持久化接收队列最多 128 条，控制消息额外预留 8 条。队列满时先发送明确的拒绝通知，再推进游标；通知失败则停止接收并保留原游标。

同话题的提示词按接收顺序执行，状态查询和控制操作不等待当前任务结束。`/stop` 同时取消尚未执行的旧提示词；`/interrupt` 完成取消后把替代提示词放回普通队列，避免长任务占用控制槽。通知总开关不隐藏队列拒绝和重启结果未确认的提示。

部署包、TLS / 代理和升级回滚见 [服务发布](service-release.md)；测试入口与已经执行的范围见 [测试](testing.md) 和 [验收记录](rust-acceptance.md)。
