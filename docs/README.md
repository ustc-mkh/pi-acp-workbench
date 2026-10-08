# 文档索引

当前生产服务采用 Rust 单一实现：会话 daemon 管理 Pi / Codex / Claude worker，Telegram relay 与 VS Code 客户端通过 Unix socket 连接。扩展宿主、Webview 和增强 Pi 适配器使用 TS/JS。

## 使用与部署

| 文档                           | 内容                                     |
| ------------------------------ | ---------------------------------------- |
| [项目 README](../README.md)    | 功能、首次安装、桌面与 Telegram 入门     |
| [会话服务](session-service.md) | worker 配置、生命周期、恢复和资源限制    |
| [Telegram](telegram.md)        | Bot / 群组配置、目录限制、命令与消息恢复 |
| [每轮 Diff](turn-diff.md)      | 采集基线、展示与省略限制                 |
| [服务发布](service-release.md) | GNU / musl 构建、包校验、升级与回滚      |

## 开发与维护

| 文档                                   | 内容                                          |
| -------------------------------------- | --------------------------------------------- |
| [贡献指南](../CONTRIBUTING.md)         | 开发环境、修改入口、适配器升级、缓存清理      |
| [架构](architecture.md)                | 模块职责、会话状态、持久化与异常隔离          |
| [测试](testing.md)                     | 日常 / 完整验收、CI、外部集成和发布检查       |
| [Wire 协议](service-protocol.md)       | v3 方法、帧、订阅、限制与错误语义             |
| [磁盘格式](data-formats.md)            | 历史、收据、偏好、Telegram 状态及原生分支哈希 |
| [Fixtures](../test/fixtures/README.md) | 冻结样例、生成入口及兼容性验证                |
| [验收记录](rust-acceptance.md)         | 有证据的当前回归、历史产物检查及未完成范围    |
| [更新记录](../CHANGELOG.md)            | 未发布变更与已发布版本历史                    |

## 文档维护约定

行为、配置、持久化或协议变化时同步修改对应专题；命令以根目录 package.json 和 scripts 为准，字段与边界以当前 Rust / TS 实现为准。维护规范及使用说明，避免另建重复的迁移进度文档；旧计划可通过 Git 历史查看。

验收记录必须说明执行范围、代码基线和证据。历史包通过检查不能证明当前工作区包已验证；本地通过也不能代表远端 CI 或外部发布已完成。`.test-results/run-*` 默认仅保留最近 5 次，长期需要的证据应另存或作为 CI / Release 附件保留。

文档修改后检查 Markdown 格式、本地链接与标题锚点，清除失效路径和不存在的 npm 命令。测试数量放在带日期的验收记录中；长期指南以覆盖场景和可复现命令描述。
