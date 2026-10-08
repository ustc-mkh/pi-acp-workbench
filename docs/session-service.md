# Pi 会话服务

Pi 由独立的 `pi-sessions.service` 启动和管理。VS Code 与 Telegram 都连接本地 Unix socket，不再各自启动 Pi，也不互相接管。Pi、Codex、Claude Code 均由同一个 daemon 管理。

## 安装

生产会话服务仅使用 Rust daemon。仅支持 Linux x86_64，需要 Node 22+、可用的 Pi 和用户级 systemd；从源码构建需要 Rust/Cargo。服务与 VS Code Remote 扩展运行在同一服务器账户。此版本不支持 Windows 的本地管道。

```bash
npm ci
npm run build:services
mkdir -p ~/.config/pi-acp-workbench ~/.config/systemd/user
chmod 700 ~/.config/pi-acp-workbench
cp examples/sessions.json ~/.config/pi-acp-workbench/sessions.json
cp examples/pi-sessions.service ~/.config/systemd/user/pi-sessions.service
```

Pi 可以在当前账户有权限访问的任意目录运行，无需配置目录白名单。编辑 `sessions.json` 的 Pi 可执行文件路径；编辑 unit 中仓库绝对路径，指向 `service-dist/pi-acp-session-daemon`。凭据继续由 Pi 管理。代理变量、`PI_ACP_PI_COMMAND`、模型环境变量放在 `sessions.json` 的 `env` 中，并给配置设置 0600 权限；不要提交真实配置。

`npm run build:services` 生成独立的 `service-dist/`：两个 Rust 二进制、`pi-adapter.mjs`、`pi-native-fork.mjs` 和平台/架构/文件 SHA-256 清单。生产构建不开启 `contract-test` feature，VSIX 不包含原生服务。默认使用二进制旁的内置 `pi-adapter.mjs`，Node 22+ 必须位于服务 PATH；非标准 Node 安装请显式配置 `command` / `args`。只有明确需要自定义 ACP 适配器时才设置 `command` 和 `args`；标准 ACP 适配器即可；原生会话加载、图片、选择器与 Pi 分支按实际能力启用。插件中的旧 Pi command/args/env 设置不再决定服务的运行环境。

### Codex / Claude 配置

安装上游标准 ACP 适配器后，在同一 `sessions.json` 添加：

```json
{
  "maxWorkers": 3,
  "idleMs": 900000,
  "harnesses": {
    "codex": { "command": "codex-acp", "args": [], "env": {} },
    "claude": { "command": "claude-agent-acp", "args": [], "env": {} }
  }
}
```

服务 PATH 必须能找到适配器；也可填写绝对路径。`harnesses.pi` 可覆盖顶层 Pi 启动配置。Codex/Claude 无配置时使用上述默认命令，环境覆盖彼此隔离。旧 `piAcp.codex.command/args/env`、`piAcp.claude.command/args/env` 与 sharedHistory 设置已经移除；请把 worker 配置移到这个文件。插件登录终端使用独立 loginCommand 设置。重启服务应用配置，关闭 VS Code 不影响任务。

```bash
systemctl --user daemon-reload
systemctl --user enable --now pi-sessions
systemctl --user status pi-sessions
journalctl --user -u pi-sessions -f
```

### 实现维护策略

Rust 是生产服务的唯一实现。终态 outbox 写失败会使请求失败并标记 interrupted 收据，不重新执行已运行的模型任务。TS daemon 入口、会话服务、队列、收据和 socket 服务端已删除；会话与偏好回归直接连接 Rust 进程。旧 TS Telegram 内部模块也已按覆盖映射删除，不再维护第二套服务实现。契约、真实双服务集成及迁移进度见 [Rust 收敛进度](archive/rust-migration.md)。

桌面端「清空历史」会删除整个服务器账户的共享历史，并停止服务上的全部会话任务（包括 Telegram）；界面会进行二次确认。只想停止一个任务时请使用取消，而不是清空历史。

### 从旧 Node 服务切换

先等任务结束，停止 Telegram，再停止会话服务并备份数据目录；确认 Pi 子进程退出后执行 `npm run build:services`，更新两个 unit 的 `ExecStart` 并依次启动会话服务、Telegram。已有当前格式数据继续使用，不自动转换或删除。不要在服务运行时覆盖 `service-dist/`。回滚使用切换前的发布版本和备份，禁止新旧 daemon 共用同一 `--data-dir` 并行运行。

退出 SSH 后仍运行，需要账户启用 linger：`loginctl enable-linger "$USER"`。服务未启动时插件会报连接错误，不会回退到直接启动 Pi。自定义数据目录用 daemon 的 `--data-dir`；插件设置 `piAcp.serviceSocket` 指向该目录下 `service/sessions.sock`，Telegram 可在配置中设置绝对路径 `serviceSocket` 连接此 socket，并使用自己的 `--data-dir` 保存话题和投递状态；省略时连接其数据目录下 `service/sessions.sock`。

## 进程生命周期

- 默认最多 3 个工作进程（`maxWorkers`，1–8）；没有容量时排队，优先回收空闲进程。
- 查看已有历史不启动 Pi；发送消息、修改设置或请求原生分支时按需加载。新建会话会短暂启动 Pi 取得原生 ID，并读取数据目录下 `preferences/{harness}.json` 的最近模型/thinking 组合。桌面与 Telegram 共用此记录；恢复旧会话不应用全局偏好，也不因浏览而覆盖它。成功修改设置或实际发送会更新记录，关闭历史显示不影响偏好。
- 完成任务后闲置 15 分钟自动关闭进程（`idleMs`，默认 900000）。回收后下一次请求重新加载原生历史，不重放旧提示词。
- 插件关闭、客户端断线、Telegram 重启均不终止已提交的任务。授权可以在任一端处理，5 分钟无人处理则取消授权。
- 所有 harness 每轮结束后由服务采集并保存[本轮总 Diff](turn-diff.md)，正常完成、取消及 Agent 崩溃均尽量保存已发生的工作区净变化。
- 停止 Pi 服务会中断任务；正常退出先清理工作进程。systemd 的 `KillMode=control-group` 在异常退出或超时时兜底清理整个服务控制组。
- 工作进程的普通子进程一并清理。显式启动到其他 systemd unit 的后台服务不属于这个控制组。

`systemctl --user stop pi-sessions` 停止执行服务；`systemctl --user restart pi-telegram` 只重启 Telegram 接入。不要在活动任务中升级并重启 Pi 服务。

## 一致性与恢复

所有 harness 的历史和任务收据由服务统一管理。两端同时提交按会话串行执行，不同会话受全局进程上限限制。取消会使当时已排队的请求失效；后续提交可以继续执行。

发送消息、新建、原生分支及模型/模式设置都在执行前保存请求 ID 收据。收据包含方法与参数的稳定 SHA-256 指纹；同 ID、同内容返回原结果，不同会话/方法/正文复用 ID 会被拒绝。fingerprint 是必填字段；收据格式不符时启动/读取直接报错，不迁移、不推断操作身份，也不自动删除文件。收据写入和操作执行共用会话队列，避免后续任务覆盖最近状态。

关键收据、Telegram 游标/绑定及最终 outbox 使用临时文件写入、文件 fsync、原子 rename、父目录 fsync；任一步失败均报告错误，初始收据未写成功不会调用 Pi。该持久性依赖 Linux 文件系统和存储设备正确实现同步，不是工具执行与收据之间的分布式事务，也不能保证恰好一次完成。

发送消息前另存用户消息，执行中定期保存界面历史。客户端不会因超时或断线自动重发任务。服务重启把未完成收据标记为中断；用原请求 ID 重试不会重跑工具。异常掉电可能丢失最后一次周期保存后的显示内容，应同时检查 Pi 原生记录和工作区文件。

收据位于 `~/.pi/pi-acp-workbench/service/requests/`，历史位于 `history/`；目录/文件使用 0700/0600。Socket 限制为同账户使用，不监听公网端口。备份时保留历史、原生 Pi 会话和任务收据。不要在运行期间手工删除收据或抢锁。

升级旧版本时，先结束任务、关闭旧插件连接并停止旧 Telegram 服务，再启动新会话服务和新客户端。本次 Socket 增加会话订阅和分块响应，插件、会话服务与 Telegram 必须一起更新并重启，不能混用新旧客户端。插件要求 v3 服务，不支持委托写入或直接文件写降级；启动新 daemon 前必须关闭旧版本插件，避免旧客户端写历史。已有当前格式的共享历史可直接继续；缺失必需元数据、完整快照标识或请求指纹的数据不受支持。仅存在于旧插件本地存储的记录不迁移。升级前备份数据；不兼容数据如需归档或改用新数据目录，应由操作者明确处理，不能删除收据后假定仍具备防重放保证。

## 长期运行的资源边界

已完成和中断的任务收据保留 30 天用于防重放与审计，到期由启动清理删除；进行中的收据永不过期。收据按请求读取，启动时逐文件扫描，不全部载入内存。最近一次任务状态保存在独立的会话状态文件。只读历史不占用版本缓存，回收运行时同时释放版本记录。任务队列清空时删除取消状态。

慢磁盘下，周期快照不会不断追加保存任务；Telegram 进度只保留正在写入和最新待写入两个版本，最后的完成事件仍等待落盘。Telegram outbox 逐文件处理，不将离线期间积压的所有完整回复一次读入内存。

本地 socket 最多 32 个连接、128 个处理中的请求；请求正文和未完成帧各受 32 MiB 总量限制，请求单帧上限 16 MiB。大历史响应按小帧顺序传输并等待背压，单个完整响应/单连接发送队列上限 64 MiB，全部连接发送队列上限 128 MiB。客户端按会话显式订阅，每连接最多 32 个会话；其他会话不会收到完整历史广播。

超大响应返回明确错误，超大广播仅向相关订阅者报告错误，不再断开所有客户端。未完成帧、分块停顿或写入背压超过 10 秒时关闭对应连接；长任务本身没有这个超时。连接或队列超限会拒绝请求/断开对应慢客户端，已提交任务不会因断线重放。分块传输仍需在客户端拼装完整历史，超过 64 MiB 的会话需要新建会话或离线检查原生记录，尚未实现 UI 历史分页。

Telegram 发送队列最多 64 个请求，最多 32 个活动预览，5 分钟没有更新的预览会释放；每个预览仅保留约 3800 字符且独立复制，避免短子串间接保留整篇长回复。授权票据最多 128 个并定期过期；Pi 每个会话最多保留 32 个待授权请求，单个授权请求超过 256 KiB 时取消该授权。

这些限制不能把整个系统内存固定为某个数值：当前长对话全文、历史/话题索引和历史同步记录仍随数据量增长；Pi 及其工具子进程也有自己的内存消耗。不要把常驻服务或 Node 工作进程的 RSS 暂未回落直接判定为泄漏，要结合 GC 后堆大小、活动任务和整个 systemd 控制组观察。

模板启用内存/任务统计，可查看整个服务（包括子进程）：

```bash
systemctl --user show pi-sessions.service -p MemoryCurrent -p TasksCurrent
```

暂未设置自动杀进程的内存硬上限，避免大任务因达到阈值突然中断。任务收据和原生历史的磁盘空间需要正常备份和容量规划；不能随意删除收据后假定仍能防重放。

## Codex / Claude 用量与上下文

升级并重启会话 daemon 后，桌面的用量统计页可以读取 Codex / Claude ACP 返回的 token 明细，按模型、日期、会话汇总并沿用费用估算。需要上游适配器实际返回 `PromptResponse.usage` 或 `_meta.quota`。服务使用独立的 `usageInspection` 能力协商，旧 daemon 不会被误认为支持。

统计从启用后的新轮次开始，服务重启或 worker 回收后仍可查询；不回填此前的原生历史。模型明细优先，避免与汇总重复计数。缺失数据、未知模型会明确提示；费用估算不是订阅额度或最终账单。

上下文条使用适配器上报的当前占用与窗口大小，不用累计消耗推算。此支持不包含逐项列出隐藏提示词、工具定义、文件的 token 占比，也不包含原生会话分支。

字段语义依据上游实现：[Codex TokenCount](https://github.com/agentclientprotocol/codex-acp/blob/main/src/TokenCount.ts)、[Claude ACP 用量处理](https://github.com/agentclientprotocol/claude-agent-acp/blob/main/src/acp-agent.ts)。
