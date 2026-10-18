# Fixtures：当前架构与历史拒绝样例

当前完整重构 fixtures、synthetic / 真实离线 SDK 的证据边界与执行入口见
[rewrite/README.md](rewrite/README.md)。当前接口与磁盘约束见
[Workbench IPC](../../docs/workbench-ipc.md) 和
[Workbench storage](../../docs/workbench-storage.md)。

## `native-branch/`：Pi adapter 的冻结原生文件算法样例

七份 `kind: "points"` 样例保存原生历史节点及冻结的 `forkPoints` / `prefixHash`，
或必须拒绝的错误。`test/native-fixtures.test.ts` 校验 `src/native-branch.ts` 的
原生路径、工具配对、compaction、label 重连与逐节点 SHA-256 行为。

这些是 provider/native-file 边界算法，不是 UI/domain reducer：`entryId` 是原生节点，
`timestamp` 只是原生 metadata。旧的 UI display-row / timestamp 绑定算法及其三份
`kind: "bind"` 样例、旧 generator / `npm run fixtures` 已删除；不再把时间戳当 native
identity，也不将 image-bearing display row 当安全 cut。
当前切点绑定与保守拒绝在 Rust domain/fork 集成测试中验证，真实 Pi SDK/native-file
行为另由 `npm run test:native-fork:offline` 验证。

只有有意修改原生算法时才审查并更新冻结期望；不能因为一次实现回归就批量重生成
期望来使测试通过。执行：

```sh
npx vitest run test/native-branch.test.ts test/native-fixtures.test.ts
```

## `formats/`：历史格式的拒绝样例，不是当前可读格式

六份历史 JSON 样例仅作为 **negative fixtures** 保留。当前 daemon 和同 binary
维护工具不能读取、转换或隐式清理它们。Rust
`frozen_legacy_format_samples_are_refused_byte_for_byte_without_migration` 将每份样例
放入隔离的 unversioned storage root，验证 host 与 maintenance lease gate 均拒绝、
没有创建新 marker，且原始 bytes 不变。

当前 format2 的有效/无效格式、checksum、identity、revision、journal、outbox、inbox
与 archive 由相应 Rust persistence tests 和 actual-host contract 验证；这些历史样例
不是 format2 的规范，也不代表存在旧 reader。真实旧数据需由 operator 先备份并显式
处理，不能依靠启动时 migration、reset 或文件名扫描删除。
