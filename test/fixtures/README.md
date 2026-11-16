# 测试数据

| 目录 | 用途 |
| --- | --- |
| `native-branch/` | 原生分支的冻结算法样例：工具配对、compaction、label、上下文编辑及无效切点 |
| `formats/` | 历史格式的拒绝样例，验证启动和维护不会修改不兼容数据 |
| `rewrite/` | 当前 ACP/IPC 合同数据与 Pi SDK 离线样例 |

原生分支样例由 `test/native-branch.test.ts` 和 `test/native-fixtures.test.ts` 验证。只有有意修改算法时才更新冻结期望，不通过批量重生成掩盖实现回归。历史格式仅作 negative fixtures，不提供导入能力。

合同测试、真实 SDK 离线检查及运行入口见[合同 fixtures](rewrite/README.md)，日常验证见[贡献指南](../../CONTRIBUTING.md)。

## 环境隔离

- 使用临时 HOME/storage 和公开假凭据，不继承真实账户或 Bot 配置。
- 独立 ACP helper 默认只继承 PATH/locale，创建私有 HOME；等待子进程实际退出后仅删除自己创建的目录。
- SDK/live smoke 必须显式提供环境。离线 SDK wrapper 使用隔离环境和 network guard，不将其环境继承方式复制到普通测试。
- 不输出敏感 token、provider 错误中的敏感描述或凭据 URL；跳过的用例不计为通过。
