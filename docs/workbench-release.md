# Linux 服务构建与部署

服务包包含一个控制程序 `pi-acp-workbenchd`；ACP workers 需单独安装。支持 Linux x86_64 的 GNU/musl 目标。扩展、宿主、Pi adapter 使用配套版本，更新前阅读[升级与回退](workbench-cutover.md)。

## 从源码构建

需要 Node.js 22+、Rust/Cargo 和 Linux x86_64 工具链：

```sh
npm ci
npm run build
npm run build:services
npm run package:services
npm run package
```

- `service-dist/`：binary 和 `manifest.json`。
- `service-artifacts/`：`pi-acp-services-VERSION-TARGET.tar.gz`、`.sha256`。
- 仓库根目录：`pi-acp-workbench-VERSION.vsix`。

`build:services` 可传 `--target x86_64-unknown-linux-musl` 或 `--target x86_64-unknown-linux-gnu`；跨编译需安装对应 Rust target 和 linker。GNU 验证不能替代 musl 验证。manifest 记录 ELF/ABI、SHA-256、Rust 源码 hash、Git 来源、dirty 状态及 IPC/storage 合同。

归档仅收集固定清单中的 binary、manifest、许可证、公开文档和两个 `examples/` 配置示例，不包含业务数据或凭据。Rustls 使用 bundled roots；Node 仅在使用 Node-based adapter 时需要。

## 校验与安装

从可信发布来源取得匹配版本的服务包和校验和，核对 `.sha256`，查看归档内容后解压到新的私有目录。校验和用于检查字节一致性，来源可信性需单独确认。在解压目录执行：

```sh
sha256sum -c SHA256SUMS
./pi-acp-workbenchd --version
./pi-acp-workbenchd --help
```

将 `examples/workbench.json` 复制到自己的配置目录，修改绝对 `storage.root`、各 worker 的 executable/args/env。首次启动使用空 root；兼容的已验证 2.0.x root 支持有限的新增设置字段升级，旧格式转换边界见[数据迁移](workbench-data-migration.md)。备份停止后的完整 root 及关联 Pi profile（包含 context checkpoint）。

默认示例使用 PATH 中的 `pi-acp`。需要本仓库增强功能时，将 worker command 设为 Node 的绝对路径，args 指向配套构建的 `dist/pi-adapter.mjs`。provider 登录由各 CLI 管理；禁用的 worker 配置为 `null`。

```sh
./pi-acp-workbenchd --config /absolute/path/workbench.json
```

VS Code 安装配套 VSIX，将 `piAcp.workbenchSocket` 指向 `<storage.root>/workbench.sock`；扩展不会启动 daemon。连接和 workspace trust 规则见 [VS Code](workbench-vscode.md)。

Telegram 为可选项：设置 workspace、chat/user allowlist，以及 `bot_token_env` 环境变量名，token 不写入 JSON。配置方法见 [Telegram](workbench-telegram.md)。

### systemd 用户服务

编辑包内 `examples/pi-acp-workbenchd.service`，将 `ExecStart` 的 binary/config 替换为实际绝对路径，再安装到用户 unit 目录并启动。服务账户需能访问 workspace、storage 和 worker；单独注入 Bot token 环境变量。仓库构建脚本只生成制品，不执行安装或 `systemctl`。

## 验证

源码统一门禁：

```sh
npm run test:rewrite
```

该门禁涵盖类型检查、构建、格式、Clippy、Rust/TS、IPC/Telegram contracts、Chromium 和生产制品 smoke。默认使用 synthetic ACP peers 与本地 mock Bot；真实 provider、Telegram 和 Extension Host 需要各自验证。

性能与生命周期专项按变更选择运行：

```sh
npm run test:workbench:startup
npm run test:workbench:scale
npm run test:workbench:mixed
npm run test:workbench:diff-benchmark
npm run test:workbench:host-mixed -- --binary "$PWD/service-dist/pi-acp-workbenchd" --dataset full
npm run test:workbench:soak -- --duration-seconds 600
npm run test:extension-host:full
```

`host-mixed` 的 full 工作集包含 10k 会话、100k history entries、4 MiB 图片、模拟 Telegram 多 lane 和 Chromium workload。默认五轮报告位于 `.test-results/`；两小时同宿主测试使用 `--runs 1 --duration-seconds 7200`。保留两小时 delivery backlog 使用 `--backlog-seconds 7200`。small 结果不能替代 full，短测不能替代长测。Extension Host 需要图形环境；安装候选 VSIX 可使用 `WORKBENCH_TEST_BINARY=/absolute/path/to/pi-acp-workbenchd node scripts/workbench-extension-host.mjs --full --vsix /absolute/path/to/candidate.vsix`。

历史有限验收范围见 [P6 矩阵](workbench-p6-validation.md)，后续版本需验证自己的实际制品。

## 更新、备份与回退

按[切换清单](workbench-cutover.md)停止接受新任务、查明未决 operation，等待物理 join 后备份。离线维护由同一 binary 提供，并与宿主争用同一独占锁：

```sh
./pi-acp-workbenchd storage export --root /canonical/absolute/data \
  --destination /absolute/existing-parent/new-backup --confirm
```

export 不转换格式，也不包含 root 外的 native 文件、Pi profile 或 workspace。不要删除 `.workbench.lock` 绕过占用；reset/GC 的适用条件见[存储维护](workbench-storage.md)。不兼容、损坏或未版本化非空 root 拒绝启动。回退必须恢复匹配的 binary、VSIX、配置与数据组合，不会撤销已发生的文件修改、费用或 Telegram 发送。
