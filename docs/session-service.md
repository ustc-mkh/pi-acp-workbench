# Pi 会话服务

Pi 由独立的 `pi-sessions.service` 启动和管理。VS Code 与 Telegram 都连接本地 Unix socket，不再各自启动 Pi，也不互相接管。Codex / Claude 仍由插件直接运行。

## 安装

需要 Linux、Node 22+、可用的 Pi 和用户级 systemd。服务与 VS Code Remote 扩展运行在同一服务器账户。此版本不支持 Windows 的本地管道。

```bash
npm ci
npm run build
mkdir -p ~/.config/pi-acp-workbench ~/.config/systemd/user
chmod 700 ~/.config/pi-acp-workbench
cp examples/sessions.json ~/.config/pi-acp-workbench/sessions.json
cp examples/pi-sessions.service ~/.config/systemd/user/pi-sessions.service
```

编辑 `sessions.json` 的工作区绝对路径、Pi 可执行文件路径；编辑 unit 中 Node、仓库绝对路径。凭据继续由 Pi 管理。代理变量、`PI_ACP_PI_COMMAND`、模型环境变量放在 `sessions.json` 的 `env` 中，并给配置设置 0600 权限；不要提交真实配置。

默认使用内置 `pi-adapter.mjs`。只有明确需要自定义 ACP 适配器时才设置 `command` 和 `args`；它必须支持原生会话加载和 Workbench 原生分支扩展。插件中的旧 Pi command/args/env 设置不再决定服务的运行环境。

```bash
systemctl --user daemon-reload
systemctl --user enable --now pi-sessions
systemctl --user status pi-sessions
journalctl --user -u pi-sessions -f
```

退出 SSH 后仍运行，需要账户启用 linger：`loginctl enable-linger "$USER"`。服务未启动时插件会报连接错误，不会回退到直接启动 Pi。自定义数据目录用 daemon 的 `--data-dir`；插件设置 `piAcp.serviceSocket` 指向该目录下 `service/sessions.sock`，Telegram 使用相同 `--data-dir`。

## 进程生命周期

- 默认最多 3 个工作进程（`maxWorkers`，1–8）；没有容量时排队，优先回收空闲进程。
- 查看已有历史不启动 Pi；发送消息、修改设置或请求原生分支时按需加载。新建会话会短暂启动 Pi 取得原生 ID。
- 完成任务后闲置 15 分钟自动关闭进程（`idleMs`，默认 900000）。回收后下一次请求重新加载原生历史，不重放旧提示词。
- 插件关闭、客户端断线、Telegram 重启均不终止已提交的任务。授权可以在任一端处理，5 分钟无人处理则取消授权。
- 停止 Pi 服务会中断任务；正常退出先清理工作进程。systemd 的 `KillMode=control-group` 在异常退出或超时时兜底清理整个服务控制组。
- 工作进程的普通子进程一并清理。显式启动到其他 systemd unit 的后台服务不属于这个控制组。

`systemctl --user stop pi-sessions` 停止执行服务；`systemctl --user restart pi-telegram` 只重启 Telegram 接入。不要在活动任务中升级并重启 Pi 服务。

## 一致性与恢复

Pi 的历史、锁和任务收据由服务统一管理。两端同时提交按会话串行执行，不同会话受全局进程上限限制。取消会使当时已排队的请求失效；后续提交可以继续执行。

任务在调用 Pi 前保存请求 ID 收据和用户消息，执行中定期保存界面历史，完成后保存结果及 Telegram 待发送事件。客户端不会因超时或断线自动重发任务。服务重启把未完成收据标记为中断；用原请求 ID 重试不会重跑工具。异常掉电可能丢失最后一次周期保存后的显示内容，应同时检查 Pi 原生记录和工作区文件。

收据位于 `~/.pi/pi-acp-workbench/service/requests/`，历史位于 `history/`；目录/文件使用 0700/0600。Socket 限制为同账户使用，不监听公网端口。备份时保留历史、原生 Pi 会话和任务收据。不要在运行期间手工删除收据或抢锁。

升级旧版本时，先结束任务、关闭旧插件连接并停止旧 Telegram 服务，再启动新会话服务和新客户端。旧客户端仍占用锁时，新服务拒绝接管，避免同时写原生会话。已有当前格式的共享历史可直接继续；仅存在于旧插件本地存储的记录不自动迁移。

## 长期运行的资源边界

任务收据永久留在磁盘用于防重放，按请求读取；启动时逐文件扫描，不把历年收据全部载入内存。最近一次任务状态保存在独立的会话状态文件。只读历史不占用版本缓存，释放租约同时释放版本记录。任务队列清空时删除取消状态。

慢磁盘下，周期快照不会不断追加保存任务；Telegram 进度只保留正在写入和最新待写入两个版本，最后的完成事件仍等待落盘。Telegram outbox 逐文件处理，不将离线期间积压的所有完整回复一次读入内存。

本地 socket 最多 32 个连接、128 个处理中的请求；请求正文、未完成帧和发送缓冲分别受总量限制（32 MiB），单帧上限 16 MiB。未发完的帧超过 10 秒关闭连接；长任务本身没有这个超时。连接或缓冲超限会拒绝请求/断开慢客户端，已提交任务不会因断线重放。

Telegram 发送队列最多 64 个请求，最多 32 个活动预览，5 分钟没有更新的预览会释放；每个预览仅保留约 3800 字符且独立复制，避免短子串间接保留整篇长回复。授权票据最多 128 个并定期过期；Pi 每个会话最多保留 32 个待授权请求，单个授权请求超过 256 KiB 时取消该授权。

这些限制不能把整个系统内存固定为某个数值：当前长对话全文、历史/话题索引和历史同步记录仍随数据量增长；Pi 及其工具子进程也有自己的内存消耗。不要把 Node 的 RSS 暂未回落直接判定为泄漏，要结合 GC 后堆大小、活动任务和整个 systemd 控制组观察。

模板启用内存/任务统计，可查看整个服务（包括子进程）：

```bash
systemctl --user show pi-sessions.service -p MemoryCurrent -p TasksCurrent
```

暂未设置自动杀进程的内存硬上限，避免大任务因达到阈值突然中断。任务收据和原生历史的磁盘空间需要正常备份和容量规划；不能随意删除收据后假定仍能防重放。
