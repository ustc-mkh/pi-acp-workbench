# Telegram 使用

Telegram adapter 运行在 `pi-acp-workbenchd` 内，与 VS Code 共用会话、历史和模型设置。

## 配置

在 `workbench.json` 中添加 `telegram` 对象，Bot token 从指定环境变量读取：

```json
{
  "bot_token_env": "WORKBENCH_BOT_TOKEN",
  "workspace": "/absolute/allowed/workspace-root",
  "allowed_chat_ids": [-1001234567890],
  "allowed_user_ids": [123456789],
  "inbox_capacity": 128
}
```

- `workspace` 必须存在，所有会话操作限制在其规范化子目录内。
- `allowed_chat_ids` 不能为空。`allowed_user_ids` 留空允许这些 chat 的所有非 Bot 用户；需要限定成员时填写明确 ID。
- 默认 API 为 `https://api.telegram.org/`，不跟随重定向。Bot 凭据不会传给 ACP 子进程。
- 使用话题功能时需要 forum 群及 Bot 创建、管理话题的权限。

桌面的 **Telegram setup** 可选择工作区并生成新配置，只收集 token 环境变量名和允许的 user/chat ID，不保存 token、不覆盖旧文件或重启服务。检查配置、设置服务环境变量后按[部署指南](workbench-release.md)启动。

## 常用命令

| 命令                                               | 作用                                                |
| -------------------------------------------------- | --------------------------------------------------- |
| `/new [pi\|codex\|claude\|antigravity] [绝对路径]` | 新建会话；在 forum 中创建独立新话题，保留原话题绑定 |
| `/open SESSION_ID`、`/attach SESSION_ID`           | 打开授权范围内的会话；已有绑定时返回原话题          |
| `/sessions`、`/status`                             | 查看会话列表或当前状态、模型与待办                  |
| `/menu [directories\|sessions\|models\|modes]`     | 打开交互菜单，选择目录、会话、模型或模式            |
| `/discover`                                        | 明确启动 provider 获取可用设置，不发送业务输入      |
| `/model ID`、`/mode ID`、`/setting ID VALUE`       | 使用实际 provider catalogue 中的选项                |
| `/answer INTERACTION_ID TEXT_OR_TYPED_JSON`        | 回答指定交互                                        |
| `/prompt TEXT`、`//TEXT`                           | 明确发送新输入                                      |
| `/queue`                                           | 查看排队输入                                        |
| `/stop`、`/cancel`                                 | 停止当前任务及其屏障覆盖的较早排队输入              |
| `/interrupt TEXT`                                  | 停止旧任务并接受替换输入                            |
| `/remove`                                          | 删除当前绑定会话                                    |
| `/history`、`/history all`                         | 导出近期历史或继续完整历史导出                      |
| `/sync`                                            | 分页同步可访问会话和近期历史                        |
| `/notifications [on\|off]`                         | 查询或设置自动通知                                  |
| `/silent [on\|off]`                                | 查询或设置静默发送                                  |
| `/help`、`/start`                                  | 查看帮助                                            |

只有一个待回答交互时，普通文本被识别为该交互的回答；多个交互时要求明确指定。拒绝、过期或重复的回答不会改作新输入。权限、单选和布尔字段提供按钮；多字段表单可提交类型化 JSON：

```text
/answer INTERACTION_ID {"Form":{"fields":{"name":{"Text":"Ada"},"count":{"Integer":2},"choices":{"Selected":["a","b"]}}}}
```

菜单只展示已配置 Agent 和已确认的模型选项。目录浏览只读目录名，不创建目录，省略隐藏项和符号链接；目录、会话和模型列表均分页。按钮绑定话题与原操作，菜单按钮 10 分钟过期且只能使用一次，执行前重新检查权限。

## 话题、队列与后台任务

一个会话最多绑定一个 Telegram 话题。唯一已授权 forum 可为桌面新会话自动镜像话题，标题使用 `#编号 · 会话名称`，改名后同步。多个 forum 或目标不明确时不自动选择；已绑定会话不会被抢占到其他话题。

忙碌时普通输入进入持久队列，`/queue` 可查询。队列达到 `inbox_capacity` 后，新普通输入会收到拒收提示，可在队列腾出空间后重发。系统额外预留 4 个位置给回答、停止和打断。回答、停止和打断具有控制容量，但不越过中间的配置、新建或历史导出操作。重启恢复原操作身份，不重复执行已接受或结果未知的模型任务。

Pi 自主后台轮次使用相同的授权、历史与完成投递。停止先请求取消，正常结束后保留 worker，5 秒未结束则终止；worker 驻留与释放规则见 [VS Code 会话说明](workbench-vscode.md)。自主轮次不提供完整工作区 Diff。

## 消息与历史

运行时预览合并编辑，完成后由归档正文补齐最终回答并发送简短完成、停止或失败提示。支持常见 Markdown，表格转为逐行键值文本；不把内部思考和原始工具输出作为对话正文。

历史导出按消息身份拼接相邻片段，分批读取文本和图片。`/history` 是近期窗口，`/history all` 持久保存进度，可重复调用继续。导出和自动投递共享同话题的已确认发送记录，避免重复发送已经完整确认的内容；部分发送或确认丢失仍可能重复。显式历史正文静默发送。

`/sync` 在 forum 分页处理可访问会话，复用已有绑定，为未绑定会话创建话题；私聊只导出绑定会话。它不运行 Agent，也不自动转移其他 chat 的绑定。话题创建结果不确定时保留原回执，不盲目重建。

归档图片经校验后上传本地字节，保持文本/图片顺序，不读取消息中的远程 URL。当前不支持将 Telegram 入站照片作为提示附件。

## 通知与可靠投递

通知偏好属于 `(bot, chat, thread)`，更换绑定会话后仍保留。`notifications off` 关闭自动成功正文/图片投递，不取消任务或删除历史；授权、错误和主动查询仍可发送。`silent on` 使用 Telegram 的静默标志。

接收 offset、输入分类和按钮消费同事务保存；发送使用持久 outbox。每个话题严格按序重试，最多 8 个话题并行，429 的等待时间跨重启保留。投递重试不重新调用 Agent。

Telegram 外部发送采用 **at-least-once**：发送成功后若确认尚未落库便崩溃，消息可能重复。点击回答按钮后尝试删除原交互卡片；删除失败不撤销已接受回答，文本或其他入口回答不会自动删除旧卡片。

实现位于 `telegram/` 与 `persistence/telegram_*.rs`；事务和恢复见[架构说明](workbench-architecture.md)。
