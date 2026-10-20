# 当前源码文档

| 文档                                                                  | 内容                                                              |
| --------------------------------------------------------------------- | ----------------------------------------------------------------- |
| [单宿主发布](workbench-release.md)                                    | GNU/musl 构建范围、产物校验、配置/systemd、备份与替换边界         |
| [项目 README](../README.md)                                           | 单宿主架构、从源码运行、功能与限制                                |
| [VS Code](workbench-vscode.md)                                        | direct IPC v3 client/view、workspace trust、CSP、界面范围         |
| [IPC v3](workbench-ipc.md)                                            | domain commands/events、operation replay、容量及错误语义          |
| [Telegram](workbench-telegram.md)                                     | merged config、授权、命令、admission/inbox/outbox、图片投递       |
| [候选发布与切换](workbench-cutover.md)                                | 功能/差异、破坏性边界、备份/整组回退及未测环境                    |
| [每轮 Diff/撤回](turn-diff.md)                                        | 快照预算、原生编辑器、撤回门控及部分结果                          |
| [用量与模型管理](workbench-management.md)                             | 统计/价格、Pi context、命名、导出及配置向导                       |
| [显式离线存储维护](workbench-storage.md)                              | 同一 binary/lease 下 export、marker-only reset、typed Telegram GC |
| [功能对齐与架构减负计划](workbench-parity-and-simplification-plan.md) | 当前后续计划：main 体验对齐、事务职责收敛、SQLite 读写隔离与验收  |
| [上一轮收尾记录](workbench-follow-up-plan.md)                         | R01–R08 历史修复与证据；其架构固定约束不再约束后续阶段            |
| [重构计划](full-rewrite-plan.md)                                      | 原始基线、阶段 0–8 与最终十项条件；基线结构不是现有实现           |
| [验收 ledger](rewrite-verification.md)                                | 当前证据、历史中间门禁、明确剩余工作                              |
| [重构 fixtures](../test/fixtures/rewrite/README.md)                   | synthetic provider fixtures、实际离线 SDK/native-file 的范围      |
| [贡献指南](../CONTRIBUTING.md)                                        | 当前模块、测试与安全边界                                          |
| [CHANGELOG](../CHANGELOG.md)                                          | 历史版本变更，不是当前功能承诺                                    |

旧双 daemon 的 usage、wire、setup 和 release 指南已删除，不应通过历史命令启动当前源码。以 `package.json`、Rust typed boundary 和当前示例配置为准；不把旧已发布 VSIX/归档视为当前架构的验收。
