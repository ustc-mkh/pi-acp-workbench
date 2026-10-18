# 当前源码文档

| 文档                                                | 内容                                                              |
| --------------------------------------------------- | ----------------------------------------------------------------- |
| [单宿主发布](workbench-release.md)                  | GNU/musl 构建范围、产物校验、配置/systemd、备份与替换边界         |
| [项目 README](../README.md)                         | 单宿主架构、从源码运行、功能与限制                                |
| [VS Code](workbench-vscode.md)                      | direct IPC v2 client/view、workspace trust、CSP、界面范围         |
| [IPC v2](workbench-ipc.md)                          | domain commands/events、operation replay、容量及错误语义          |
| [Telegram](workbench-telegram.md)                   | merged config、授权、命令、admission/inbox/outbox、图片投递       |
| [显式离线存储维护](workbench-storage.md)            | 同一 binary/lease 下 export、marker-only reset、typed Telegram GC |
| [重构计划](full-rewrite-plan.md)                    | 原始基线、阶段 0–8 与最终十项条件；基线结构不是现有实现           |
| [验收 ledger](rewrite-verification.md)              | 当前证据、历史中间门禁、明确剩余工作                              |
| [重构 fixtures](../test/fixtures/rewrite/README.md) | synthetic provider fixtures、实际离线 SDK/native-file 的范围      |
| [贡献指南](../CONTRIBUTING.md)                      | 当前模块、测试与安全边界                                          |
| [CHANGELOG](../CHANGELOG.md)                        | 历史版本变更，不是当前功能承诺                                    |

旧双 daemon 的 usage、wire、setup 和 release 指南已删除，不应通过历史命令启动当前源码。以 `package.json`、Rust typed boundary 和当前示例配置为准；不把旧已发布 VSIX/归档视为当前架构的验收。
