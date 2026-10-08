# Fixtures：跨实现验证样例

本目录是 [docs/service-protocol.md](../../docs/service-protocol.md) 与
[docs/data-formats.md](../../docs/data-formats.md) 的可执行形态，原生分支样例由 `test/native-fixtures.test.ts` 对生产 TS 校验器运行冻结输出断言。Rust 不再保留另一套未调用的树校验/哈希算法，仅绑定已验证的切点；格式样例继续服务于磁盘契约测试。

## `native-branch/`（由 `scripts/export-fixtures.mjs` 生成，勿手改）

每个文件是一个独立用例：

- `kind: "points"`：输入 `entries`（原生历史节点，已按 leaf→root 排好），期望
  `expected.forkPoints`（`entryId`/`hash`/`role`/`key`/`timestamp`/`safe`）与
  `expected.prefixHash`（全链 `nativePrefixHash`）；`expected.error` 表示必须拒绝。
- `kind: "bind"`：额外含 `uiEntries`（界面条目）与可选 `previous`，期望
  `expected.bound`（`bindNativeForks` 输出映射）。

算法语义见 `src/native-branch.ts` 与 data-formats.md §8：canonicalEntries 剔除 label、
剥离 parentId、重映射 compaction 边界；前缀 hash 为逐节点 `JSON.stringify` 拼接后的
SHA-256。key 排序/字符串化必须与 JS `JSON.stringify` 一致（键按源码序、无空白）。

## `formats/`（手工维护的规范样例）

每份文件对应 data-formats.md 的一个磁盘格式；实现必须能读取这些样例，且写出的文件
在字段集合上不得比样例更少（未知字段可容忍，必需字段不可缺）。样例中的哈希为占位值，
不表示真实内容摘要。
