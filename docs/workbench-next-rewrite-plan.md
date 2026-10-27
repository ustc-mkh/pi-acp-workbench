# 架构与重构范围

单宿主重构的 P0–P6 有限验收已在 2026-10-23 候选逐项记录；最终制品结论见 [P6 验收矩阵](workbench-p6-validation.md#最终有限验收矩阵2026-10-23)。本文保留长期设计约束和维护范围，旧问题清单及实施流水从 Git 历史查阅。后续版本仍需运行与变更相符的验证，不能沿用旧候选的通过结论。

## 架构

`pi-acp-workbenchd` 是唯一控制进程，VS Code 经 IPC v3 接入，Telegram adapter 在宿主内调用同一 app/domain。Pi、Codex、Claude ACP worker 是独立外部子进程。

- SessionCoordinator/actor 串行拥有领域热态、worker epoch、pending intent 和副作用生命周期。完成消息携带 session/epoch/turn，验证后才能提交。
- Registry 负责冷加载、路由、热会话预算与退场；WorkerSupervisor 负责进程预算、启动和物理 join。可否回收由会话 owner 判断。
- ACP adapter 拥有 native protocol/session details、RPC 相关性和内容转换，不成为第二个领域状态 owner。
- SQLite 使用一个 writer 和固定 reader 预算；状态、receipt 与必要 delivery intent 按事务合同提交。冷历史、统计、导出不启动 provider。
- Telegram 保留持久 inbox/outbox、同 topic FIFO 和最多八条独立投递 lane。重试投递不重新执行 Agent。

## 操作提交合同

| 操作类型                                               | 提交方式                                                                                | 崩溃/重开                                                                |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 纯本地 mutation，如 create、元数据、冷设置、成功 no-op | 去重检查 + 本地变化（可为空）+ terminal receipt 同事务；无变化不发 batch、不增 revision | 原 operation 查询/同参重放得到原终态                                     |
| prompt/answer                                          | 持久接受与输入/答案、receipt、必要 delivery intent 原子提交；随后 dispatch              | Accepted 不代表模型执行成功；dispatch 失败记任务状态，不把输入改称未接受 |
| configure、native fork、外部 context、topic effect     | 持久 prepare → 一次远端尝试 → 观察结果 → settle；可用的本地结果和 receipt 同事务        | prepared 只证明可能执行；unknown/uncertain 不自动重发，保留可查询身份    |
| cancel/remove/undo                                     | 显式 fence/准备 → 物理 join 或受控文件副作用 → 持久结果                                 | stop 不回滚费用/文件；undo 多文件逐项结果，丢回执查原 operation          |

## 生命周期与边界

- worker 数、热 owner 数、mailbox、在途操作和媒体分别有界。回收先 fence，再 stop/join，最后复用槽位；活跃任务、交互、配置、fork、标题操作受到保护。
- worker 留存按最后一次接受的用户消息计算；具体期限及手动释放见[界面与会话行为](workbench-classic-ui.md)。worker 释放保留历史与 native identity，自主后台唤醒仅在驻留期间可用。
- entry 不可变，显示消息按 turn/role/provider message ID 分组；分页和导出保留边界，不按时间戳猜测 native fork cut。
- 输入使用有序 text/context/image parts。文件读取检查 workspace trust 和 canonical containment；工具路径、URI、terminal metadata 不构成权限。
- 编码预算区分 raw/base64/JSON/UTF-8/UTF-16；媒体校验和 native cut 能力按实际实现与验收范围描述，不把 signature/hash 当作完整解码保证。
- 断线恢复观察，不重发 mutation；未知外部结果保留 uncertain。取消不撤销外部副作用，多文件 undo 可以部分成功。

## 已完成阶段

| 阶段 | 范围                       | 当前说明                                                           |
| ---- | -------------------------- | ------------------------------------------------------------------ |
| P0   | 操作回执、防重与边界合同   | [IPC v3](workbench-ipc.md)、[持久化](persistence-recovery.md)      |
| P1   | owner 生命周期、容量和回收 | [会话行为](workbench-classic-ui.md)                                |
| P2   | typed 输入与 provider 设置 | [VS Code](workbench-vscode.md)                                     |
| P3   | Pi 自主后台轮次            | [IPC v3](workbench-ipc.md)                                         |
| P4   | 消息投影与桌面交互         | [VS Code](workbench-vscode.md)、[Diff](turn-diff.md)               |
| P5   | 历史、手机、管理与留存     | [Telegram](workbench-telegram.md)、[管理](workbench-management.md) |
| P6   | 故障、性能、真实环境与制品 | [历史验收矩阵](workbench-p6-validation.md)                         |

## 后续维护

当前功能由各使用文档维护，变更记录进入 CHANGELOG。涉及协议、schema、生命周期或外部副作用时同步更新 contracts 与针对性故障测试；发布时验证实际候选的扩展、宿主、adapter 和归档。

保留既有单宿主、SQLite、typed IPC 与可靠投递底座；不恢复旧 daemon/client/readers，不新增通用 workflow 引擎。Claude 未纳入该历史在线验收，Telegram 入站照片、terminal stdout/stderr port、Pi stable Fast 等能力边界见 [P6](workbench-p6-validation.md)。升级与回退遵循[切换指南](workbench-cutover.md)，真实数据不通过隐式迁移或清空处理。
