# 发布切换与回退清单

本页只定义制品核验、人工切换与回退，不记录阶段进度。设计约束与维护范围见[架构与重构范围](workbench-next-rewrite-plan.md)；完成本地打包不代表这些要求已通过，也不构成部署授权。

## 制品与兼容性核验

1. binary、VSIX、配置与root必须匹配同一次源码/契约。开发IPC/存储标签仍为3，**相同数字不代表较早开发schema兼容**：required tables/columns不匹配时拒绝启动。
2. `manifest.json.contracts` 与smoke report一致：`ipc:3`、`storage:3`、`rootPolicy:"new-root-no-migration"`。构建/prepare-release校验Rust/TS及manifest，不包含迁移reader。
3. 核对GNU/musl目标、ELF/ABI、binary SHA-256、Rust source hash、commit/dirty provenance、`production:true`和空features。dirty候选仅供本地验证，正式发布使用干净源码与匹配tag/commit。
4. 对实际目标分别运行artifact smoke/IPC/Telegram契约；不能拿另一平台或mock API的结果抵充该制品验证。
5. 服务包仅包含固定公开文档allowlist、唯一binary、manifest、notices和两个例子。包内相对文档链接闭合；不递归收集工作目录、配置、凭据、原始日志或业务root。

旧数据的分类保留、现阶段切换步骤及完整转换器要求见[旧数据迁移](workbench-data-migration.md)。备份不等于格式转换。

## 人工切换前（需独立授权）

- [ ] 当前候选所需功能、故障、平台和真实环境验证已完成；验收范围和已知限制已记录。
- [ ] 停接新任务，查询所有未决operation，等待完成或明确停止并物理join；Started/uncertain不视为已回滚。
- [ ] 关闭旧宿主并确认lease释放；不删lock、不猜socket stale、不并发启动持有者。
- [ ] 用旧binary离线 `storage export` 到新的私有目标，验证manifest/hash/可读性；另行备份所需provider native文件与适配器版本，root export不包含外部native文件。
- [ ] 保留旧binary/VSIX/配置/root备份的匹配组合，备份验读使用隔离副本，不直接打开业务root。
- [ ] 在隔离副本或新空root验证新组合，人工核对workspace、worker executable/args、allowlist和token环境变量名；兼容升级保留历史；不兼容旧格式按数据迁移说明处理，不清空旧root。
- [ ] 授权后整组切换binary、VSIX、配置、root与socket；先用明确小任务验读。保留旧组合，不自动续跑旧未完成任务。

## 回退

停止新组合并物理join，保留其完整root和uncertain operation证据。恢复旧binary、VSIX、配置与旧root整组组合；禁止旧binary打开新schema，禁止拼接两个root的journal/outbox/usage。

回退不撤销已发生的工具、文件系统、模型费用或Telegram发送；不得换operation ID重放来“补回”。默认无自动迁移/导入器，确需转换另行批准离线方案。禁止reset/VACUUM/递归删native history充当回退。

## 验证与权限边界

验证命令见[构建与发布](workbench-release.md)，历史能力/SLO 范围见[P6 矩阵](workbench-p6-validation.md)。无display时Extension Host runner必须以exit 2/BLOCKED结束，不回退Chromium/mock；基础smoke不等于完整Diff/modal/trust/clipboard矩阵。

在线provider/Bot必须由操作者提供专用测试账户、workspace/chat及费用授权，不读取日常凭据。仓库脚本不执行部署、push、systemctl或真实root reset。配置/制品详见[构建与发布](workbench-release.md)，export/lease与GC详见[离线存储维护](workbench-storage.md)。
