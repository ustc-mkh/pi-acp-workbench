# 文档索引

只保留当前使用/协议说明和一份[下一版重构计划](workbench-next-rewrite-plan.md)。功能差异、待办与验收门槛统一在计划中维护；过程日志放 `.test-results/`，不再单独建立事实表、checkpoint 或验收流水。

| 文档                                                | 用途                                                     |
| --------------------------------------------------- | -------------------------------------------------------- |
| [下一版重构计划](workbench-next-rewrite-plan.md)    | 本版全部剩余功能差异、架构/安全任务、阶段出口和发布验收  |
| [项目说明](../README.md)                            | 当前架构、从源码运行、功能与限制                         |
| [VS Code](workbench-vscode.md)                      | 客户端、workspace trust、CSP、界面与操作边界             |
| [Telegram](workbench-telegram.md)                   | 配置、授权、命令、队列、历史同步与可靠投递               |
| [IPC v3](workbench-ipc.md)                          | typed commands/events、operation、防重、容量和错误语义   |
| [持久化与恢复](persistence-recovery.md)             | 提交/receipt、快照、恢复、资源预算和生命周期             |
| [Diff 与撤回](turn-diff.md)                         | 快照预算、原生编辑器、撤回门控及部分结果                 |
| [用量与模型管理](workbench-management.md)           | 统计/价格、context、命名、导出和配置向导                 |
| [离线存储维护](workbench-storage.md)                | 同一 binary/lease 下 export、marker-only reset、typed GC |
| [构建与发布](workbench-release.md)                  | GNU/musl 制品、校验、配置及手动部署边界                  |
| [切换与回退](workbench-cutover.md)                  | 备份、兼容性、整组切换/回退及发布前检查                  |
| [贡献指南](../CONTRIBUTING.md)                      | 当前模块、测试与安全约束                                 |
| [测试 fixtures](../test/fixtures/rewrite/README.md) | synthetic provider 与真实离线 SDK/native-file 测试范围   |
| [更新历史](../CHANGELOG.md)                         | 版本变更，不是当前功能或验收承诺                         |

以当前 `package.json`、Rust/TS typed boundary 和示例配置为准。旧实现及历史文档可从 Git 历史查阅，不在当前文档树保留重复计划，也不通过旧命令启动当前源码。

旧数据升级、历史保留与离线转换器边界见[旧数据迁移](workbench-data-migration.md)。
