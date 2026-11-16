# 存储与离线维护

数据目录由 `storage.root` 指定，当前使用 format 3 SQLite。会话、不可变消息与正文、操作回执、模型设置、用量和 Telegram 收发状态存于同一数据库。数据可能包含源代码和敏感对话，应限制目录访问。

## 兼容性与锁

宿主和维护命令共用 `.workbench.lock` 的独占锁。锁文件持续存在是正常现象，不要删除它绕过占用。离线维护前停止服务及自动重启入口；异常退出残留的 socket 需先确认没有持有者。

格式标记和必需 schema 都会校验；相同 format 数字不保证任意开发版目录兼容。当前没有旧格式导入命令，不兼容或损坏的非空目录会拒绝打开。升级步骤见[安装与部署](workbench-release.md)。

所有维护操作使用同一个 `pi-acp-workbenchd`，不启动 provider、Telegram 或 IPC，不读取账户配置。root 必须是规范化的绝对路径；拒绝源目录中的符号链接、socket 和其他特殊文件。写操作需要 `--confirm`，GC 预览使用 `--dry-run`。

## 备份

```sh
./pi-acp-workbenchd storage export --root /absolute/canonical/data \
  --destination /absolute/existing-parent/new-backup --confirm
```

目标父目录必须存在，备份目标必须是新路径且与源分离。export 复制原始字节并生成 `EXPORT-MANIFEST.json`，包含文件清单、大小和 SHA-256；不覆盖现有目录，失败的部分输出保留供检查。

这是数据备份，不是格式转换。备份包含停机时的数据库/WAL 等文件，不包含 root 外的 provider 原生文件、Pi profile 或工作区。恢复时使用匹配版本；Pi context 需同时恢复 profile 的 `models.json` 和 checkpoint，见[模型设置](workbench-management.md)。

## 垃圾回收

```sh
./pi-acp-workbenchd storage gc --root /absolute/canonical/data --dry-run
./pi-acp-workbenchd storage gc --root /absolute/canonical/data --confirm
```

预览只报告候选数量与字节数，仍需独占锁。执行在一个 SQLite 事务内：

- 清理已完成的 Telegram inbox，保留 update offset。
- 清理过期且不被待处理 inbox 引用的 callback；未过期和无期限的 callback 保留。
- 删除最多 500 个无 `entries` 引用、也无 `archive_roots` pin 的正文对象。

可重复运行至 `removed_contents` 为 0；候选数是执行前估计，并不表示本批全部删除。GC 不删除操作回执、投递去重记录、用量、历史游标或 provider 原生文件。已有 archive pin 仍会保留内容，因此它不是按年龄清空历史或通用磁盘回收策略。

## 重置空目录标记

```sh
./pi-acp-workbenchd storage reset --root /absolute/canonical/marker-only-data --confirm
```

仅允许目录中存在 `storage-format.json` 和锁文件，移除格式标记但保留目录和锁 inode。有数据库、历史或未知文件的目录会被拒绝；reset 不能用于清空用户数据。

源码使用可先运行 `npm run build:workbenchd`，再通过 `npm run workbench:storage -- ...` 调用相同命令；`WORKBENCH_STORAGE_BINARY` 可指定其他 binary。存储事务实现见[架构说明](workbench-architecture.md)。
