# 文档索引

首次使用请从[项目说明与安装](../README.md)开始。以下按使用、维护和开发组织；当前行为以配套版本的源码、配置示例和协议为准。

## 使用与维护

| 文档                                      | 内容                                       |
| ----------------------------------------- | ------------------------------------------ |
| [VS Code](workbench-vscode.md)            | 连接、编辑器上下文、交互、模型与设置       |
| [Telegram](workbench-telegram.md)         | Bot 配置、授权、命令、话题、历史与可靠投递 |
| [界面与会话行为](workbench-classic-ui.md) | 布局、草稿、worker 留存、释放与话题镜像    |
| [Diff 与撤回](turn-diff.md)               | 变更查看、撤回条件、冲突及部分结果         |
| [用量与模型管理](workbench-management.md) | token、价格、context、命名与配置向导       |
| [构建与部署](workbench-release.md)        | GNU/musl 制品、校验、配置与 systemd        |
| [升级与回退](workbench-cutover.md)        | 备份、兼容性与整组切换                     |
| [旧数据迁移](workbench-data-migration.md) | 历史数据保留和离线转换边界                 |
| [离线存储维护](workbench-storage.md)      | export、reset、GC 与独占锁                 |

## 开发与协议

| 文档                                                | 内容                                   |
| --------------------------------------------------- | -------------------------------------- |
| [贡献指南](../CONTRIBUTING.md)                      | 模块入口、测试命令与变更约束           |
| [IPC v3](workbench-ipc.md)                          | 命令、事件、operation、容量与错误      |
| [持久化与恢复](persistence-recovery.md)             | 事务、receipt、恢复与生命周期          |
| [架构与重构范围](workbench-next-rewrite-plan.md)    | 设计约束、阶段结果与后续维护范围       |
| [P6 历史验收](workbench-p6-validation.md)           | 2026-10-23 候选的最终矩阵和能力边界    |
| [测试 fixtures](../test/fixtures/rewrite/README.md) | synthetic provider 和离线 SDK 测试范围 |
| [更新历史](../CHANGELOG.md)                         | 各版本变更                             |

使用/协议文档维护当前行为，CHANGELOG 记录版本变化，原始运行日志放 `.test-results/`。避免新增重复计划或将旧候选验收结果写成当前版本保证。
