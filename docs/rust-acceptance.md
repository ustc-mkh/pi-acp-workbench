# Rust 服务验收记录

记录日期：2026-10-08（Asia/Hong_Kong）。生产范围为 Linux x86_64 的会话 daemon 与 Telegram relay；扩展、Webview、客户端及 Pi 增强适配器仍使用 TS/JS，Pi worker 仍需要 Node.js。

本记录分别列出当前代码回归和此前产物验收。已完成的迁移计划不再作为验收依据；行为、接口和发布约束以当前架构、Wire / 磁盘规范及服务发布说明为准。命令范围与退出结果必须对应实际执行，不从旧报告推导新产物已经通过。

## 当前代码回归

工作区基线提交 `4c4acd4`，包含未提交的稳定性、类型、CI 和测试改动。本轮风险修复后 `npm run verify` 成功退出，包含 clippy、完整非浏览器验收、JS 构建与浏览器冒烟。格式检查及 git diff --check 通过。

| 验证                      | 已观察结果                                   | 证据                                                           |
| ------------------------- | -------------------------------------------- | -------------------------------------------------------------- |
| 类型与协议漂移            | 通过                                         | `.test-results/run-3pVs5M/typecheck.log`、`protocol-types.log` |
| TS 回归                   | 39 个文件、210 项通过                        | 同目录 `typescript.log`                                        |
| Rust 单测                 | core 12、session 57、relay 29 项通过         | 同目录 `rust-unit.log`                                         |
| 会话协议契约              | 21 项通过                                    | 同目录 `service-contract.log`                                  |
| Telegram 协议契约         | 26 项通过                                    | 同目录 `telegram-contract.log`                                 |
| 双 Rust 服务集成          | 5 项通过                                     | 同目录 `rust-integration.log`                                  |
| RSS / FD / worker         | 1024 份收据、1200 次复用、150 次连接检查通过 | 同目录 `rust-memory.log`                                       |
| runner / 日志保留         | 4 项通过                                     | 同目录 `runner-unit.log`                                       |
| clippy / JS 构建 / 浏览器 | verify 成功退出，浏览器无运行时错误          | 本次执行的命令结果；截图在 `test-results/browser/`             |

新增覆盖验证 EMFILE / ENFILE 的 100 ms 退避与关闭中断、满额连接的关联 busy 响应、全局连接锁中毒后继续接入、持锁 panic 后恢复，以及等待历史期间的并发门控、失败释放与取消。最初的 socket 测试受沙箱权限阻挡，允许本地 Unix socket 后全部通过；不将该权限失败归为 daemon 缺陷。

Fedora 系统 Rust 缺少 rustfmt / clippy 时，本次使用 `/tmp/pi-acp-rust-tools/usr/bin` 中与系统编译器匹配的工具检查，未安装到系统。日常环境需安装相应组件，见贡献指南。

当前文档维护和移除归档只改变文档及服务打包的文档复制清单，不修改 daemon 行为。生产 GNU / musl 包、真实 Pi smoke、历史回滚、2 小时浸泡和远端 CI 未在此次稳定性回归中重新执行。

此次文档维护另以已有 GNU service-dist 验证打包：归档生成成功，外部 SHA-256 和包内 28 项校验和通过；包内发布说明及验收记录与仓库一致，不含已删除的归档文档。该检查只验证打包与文档，未重建或重新验收 daemon 二进制。14 份现行文档的本地链接、标题锚点与 npm 命令引用检查通过。

`.test-results/run-*` 默认仅保留最近 5 次，上述路径可能在后续运行时被清理；需要长期签收应保存日志附件。数量仅对应这次记录，长期测试指南按覆盖场景维护。

## 后续类型与磁盘维护

同日补齐 socket 帧、状态事件 / 增量、已知方法返回值和 RemoteAgent 请求类型，扩展结果默认 unknown。TypeScript AST 扫描 src、webview、test、scripts 中 96 份 TS 文件，显式 any 类型为 0；字符串 `step='any'`、Vitest expect.any 和自然语言中的 any 不属于类型声明。

`npm run test:all -- --maxWorkers=4` 通过全部 39 个文件、210 项测试，日志为 `.test-results/any-cleanup-2026-10-08/typescript-bounded.log`。首次未限制 worker 的运行有一项 5 秒超时、209 项通过，原日志保留为 typescript.log；有界重跑没有放宽超时或跳过用例。类型检查、协议漂移、最后调整的状态增量 3 项回归、format:check 和 git diff --check 通过，重新构建后的浏览器冒烟通过，日志为同目录 browser.log。此轮未修改 Rust 行为，没有重复 Rust 单测或生产产物验收。

完成 Cargo 缓存清理，rust/target（含 debug、release、contract、portable、flycheck0）占用归零；旧 service-artifacts 和本次临时打包目录也已清理，按清理前 du 记录合计释放约 13.1 GB（12.2 GiB），明细为同目录 disk-cleanup.json。保留 node_modules、dist、service-dist 和现有验收证据，run 日志保留最近 5 次。下次 Rust 构建需重新编译；单独校验协议前先执行 `npm run build:service:test`。

## 早先的生产产物验收

2026-10-08 13:42（香港时间）保存的 `.test-results/non-soak-acceptance-2026-10-08/state.json` 记录本地非浸泡验收通过。该组记录对应当时的代码和候选产物，不覆盖后续稳定性、依赖、CI 或文档改动。

| 已保存的检查                                                                    | 证据目录内文件                                              |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 完整回归、格式、clippy、浏览器                                                  | `full.log`、`format-final.log`、`clippy.log`、`browser.log` |
| 真实 Pi 原生裁剪、图片 / 压缩前缀、源文件不变、fork/load 和继承计费；模型请求 0 | `native.log`                                                |
| 历史 v0.9.4 → Rust → 恢复备份 → 旧版本                                          | `rollback.log`、`rollback/`                                 |
| GNU / musl 的 ABI、真实 worker、收据重启与不可信 CA 拒绝                        | `artifact-gnu.json`、`artifact-musl.json` 及对应日志        |
| 两种产物的服务契约                                                              | `contract-gnu.log`、`contract-musl.log`                     |
| 包内外 SHA-256、额外配置排除、解包后 smoke                                      | `packages.json`、`extracted-x86_64-unknown-linux-*.json`    |
| 不支持的目标与非产物目录保护                                                    | `guards.json`                                               |
| VSIX 运行资产、许可证、README 链接与排除规则                                    | `vsix-check.json`                                           |
| 当时生产 npm 依赖审计                                                           | `npm-audit.json`                                            |

历史回滚基线为 `v0.9.4` / `360dc002a67c2c65c883eabea71b5a86a8b8fa96`，验证历史、编号 / 墓碑、偏好、完成收据、Telegram 绑定 / 游标 / 开关和 outbox，备份恢复保持字节一致。生产 TLS fixture 使用主机名正确但 CA 不可信的 server-leaf，实际包拒绝连接；没有联系真实 Telegram。

这些历史候选不能直接作为当前工作区的发布包。源码、依赖或包内文档改变后，发布前重新执行对应构建、产物检查、打包与摘要核对，具体步骤见 [服务发布说明](service-release.md)。

## 2 小时持续负载

**手动终止，未完成验收。** 用户于 2026-10-08 确认已手动关闭测试。重启恢复组从香港时间 11:16 左右开始，`soak/result.json` 记录 `passed: false`、实际 6840.529 秒（约 114 分钟），最后错误为 `contract timeout: create`；不能仅凭该错误断定服务缺陷，也不能忽略失败记录。不中断进程的连续组从香港时间 11:28 左右开始，保存的最后样本约 100 分钟，没有最终 `result.json`。原执行会话已无法恢复，因此不宣称退出码为 0 或完整退出检查通过。

两组原始日志保留，不自动重启用户已关闭的测试。长时间验收仍需一次完整 7200 秒的运行、成功结果以及结束后的 worker 清理证明；若同时采用恢复组与连续组，应分别签收。其他通过项目不需要仅因本次终止而重复执行。

每轮实际并发持有/运行 2 个 worker，再取消、重复请求和关闭临时连接；空闲时必须回收 worker。每 20 轮授权并替换 scratch 会话，每 100 轮替换手机会话，以控制历史工作集。relay 每 15 分钟重启，停止期间产生桌面 outbox，再验证单次补投递、活跃绑定与游标保持；session 每 45 分钟冷重启，核对条目不丢失。读取 `/proc` 所有运行时线程的 children，避免漏计 Tokio 从其他线程创建的 worker。

首轮脚本误选已删除的桌面话题，约 8 分钟后中止；随后预检发现重启会按规范清理已删除绑定，修正了不恰当的全量绑定相等断言。两者均为测试驱动问题，证据保留在 `soak-harness-failed/` 和 `soak-rotation-check*/`，不计入正式 2 小时。修正后的快速预检覆盖两次 session 重启、六次 relay 重启与会话轮换。正式运行重新完整计时。

验收阈值：实际 worker ≤2、relay 不启动 worker；RSS/FD 每轮硬上限 192 MiB/40；预热后空闲 RSS 末值相对四分之一处 ≤32 MiB 增长、空闲 FD ≤基线 +3。结束后检查观察到的 worker PID 全部退出。阈值通过不等价于所有供应商 SDK 或数周生产负载已验证。

## 尚未完成的验收范围

- 完整 7200 秒负载、成功结果和结束后的 worker 清理证明；此前手动终止样本不能替代。
- 当前工作区对应的 GNU / musl 生产产物重新构建、smoke / 契约 / 包摘要签收。
- 更新后的远端 GitHub Actions 实际运行、正式版本 / 标签及外部 Release 附件发布。
- 真实付费模型、真实群组、实际掉电以及所有供应商 / 平台行为。

## 复现入口

```bash
npm run verify
npm run format:check
npm run test:native-fork
npm run build:services
npm run test:service:rollback
npm run test:contract:telegram
PI_SOAK_SECONDS=7200 npm run test:service:soak
npm run test:service:artifact -- --dir service-dist
npm run package:services
```

以上按需入口不表示已全部执行。长时间验收须另行安排，不由文档维护自动启动。生产目录与启用 mock 的 contract-test 目录必须分开；双服务集成可用 PI_INTEGRATION_SESSION_DAEMON / PI_INTEGRATION_RELAY_DAEMON 指定本机产物。
