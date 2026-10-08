# Rust 迁移验收记录

验收依据：[归档迁移文档](archive/rust-migration.md)。日期：2026-10-08。工作区基线提交 `ad61236`，包含当前未提交迁移改动。本报告验收生产 Rust 会话服务和 Telegram relay；扩展宿主、Webview、客户端及 Pi 适配器保留 TS/JS，Node.js 仍是 worker 依赖。

服务仅支持 Linux x86_64，验收、构建、CI 与发布均限定于该平台。

## 本轮非浸泡验收

按用户最新要求，本轮重新执行全部本地非浸泡验收。完整回归、真实 Pi 适配器、浏览器、旧→新→旧回滚、格式、Clippy、生产依赖审计、GNU / musl 生产构建及实际产物检查均通过。两种生产会话产物各通过 22 项契约；生产依赖审计发现 0 项漏洞。VSIX 实际打包并检查运行资产、许可证、README 链接转换及服务二进制/测试文件排除。原始证据统一保存在 `.test-results/non-soak-acceptance-2026-10-08/`；完整回归明细在 `.test-results/run-nTWhCh/`。

浸泡测试依用户指示排除，本轮没有启动，不计入本轮通过结论。外部 Release 发布也不属于本地验收。

## 执行约束与计划

- 使用独立 `/tmp` 数据目录、端口和工作区；不操作实际服务数据、token 或群组，不提交付费模型请求。
- 先完成完整回归与真实 Pi 原生树 smoke，再执行历史发布 `v0.9.4` → 当前 Rust → 恢复备份 → 旧发布的实际启动检查。
- 本轮明确排除持续浸泡；只执行归档要求的短 RSS/FD 检查。下方保留此前手动终止的 2 小时运行记录。
- 生成 x86_64 静态 musl 生产包，对实际产物验证哈希、ABI、真实 worker、重启收据、TLS 证书拒绝及完整服务契约。
- 检查格式、Clippy 与构建；保存原始证据后更新本报告。只有运行完成且退出码为 0 才记录通过。
- 不用 4 秒内存 smoke 替代 2 小时运行，不把 CI 配置当作远端 CI 已执行，不把本地候选包当作已发布的 GitHub Release。

## 环境

Fedora 44 x86_64，Linux `7.2.8-200.fc44.x86_64`，Node.js `22.23.1`，Rust `1.98.1`，Pi `1.0.4`。本轮静态 x86_64 构建使用官方 Rust 1.98.1 与本机 musl-gcc；官方组件按 SHA-256 校验。Rustfmt / Clippy 使用与系统编译器匹配的 Fedora 1.98.1 包，并核对 RPM 签名/摘要；新增工具仅安装或解压到 `/tmp`。

## 已完成的验证

| 归档要求                  | 本次执行与结果                                                                                   | 原始证据                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| 类型检查、TS 与 Rust 回归 | `npm run test:full` 全部通过：40 个 TS 文件 / 241 项、Rust 6 + 30 + 19 项；包含类型/协议漂移校验 | `.test-results/run-nTWhCh/`                                                           |
| 两种协议契约              | 会话 22 项、Telegram 25 项通过                                                                   | 同目录 `service-contract.log` / `telegram-contract.log`                               |
| 双服务集成                | 5 项通过：共用任务、桌面订阅、权限、取消、离线 outbox 重启去重                                   | 同目录 `rust-integration.log`                                                         |
| RSS/FD 短检查             | 1024 份收据、1200 次复用、150 次连接的真实 Rust 检查通过                                         | 同目录 `rust-memory.log`                                                              |
| 原生适配器 smoke          | 3 个原生裁剪边界、源文件不变、图片/压缩前缀、ACP fork/load 与继承计费排除通过；模型请求 0        | `.test-results/non-soak-acceptance-2026-10-08/native.log`                             |
| 隔离旧→新→旧              | 6 组检查通过；旧基线 `v0.9.4` / `360dc002a67c2c65c883eabea71b5a86a8b8fa96`                       | `.test-results/non-soak-acceptance-2026-10-08/rollback/`                              |
| x86_64 静态生产包         | 生产 smoke 与 22 项契约通过                                                                      | `.test-results/non-soak-acceptance-2026-10-08/artifact-musl.log`、`contract-musl.log` |

平台清理后再次执行完整套件，全部通过（`.test-results/x86-only-full.log`）。构建、打包与启动入口拒绝不支持的目标或宿主，打包另核对真实 ELF 架构（`.test-results/x86-only-target-guard.log`）；x86_64 生产构建和静态产物 smoke 均再次通过。

默认 GNU 生产包也通过相同生产 smoke。最终完整套件再次全部通过；格式、全目标/全 feature Clippy（`-D warnings`）、浏览器 smoke 与默认 `build:services` 均通过。

回滚检查覆盖历史条目、编号/墓碑、模型/思考偏好、已完成收据防重放、Telegram 绑定/游标、history 确认、静音/通知开关和旧版离线 outbox。14 份备份资产恢复前后逐字节一致；升级后的数据另存副本，旧读者另能读取本次新产生的历史、收据和 Telegram 状态。适配器持有的合成 native 文件/registry 在替换服务时摘要不变，真实 native 行为另由 Pi smoke 验证。

生产包 smoke 启动实际 ACP worker，检查历史及收据重启复用；生产 relay 通过本机 CONNECT/TLS fixture 拒绝 SAN 正确但 CA 不可信的 server-leaf 证书（`CA:FALSE`，实际 `unknown CA` 告警），错误不泄露 token，且忽略 `PI_TELEGRAM_API_BASE`。未联系真实 Telegram。ABI 与 TLS 具体部署约束见 [服务发布说明](service-release.md)。

## 2 小时持续负载

**手动终止，未完成验收。** 用户于 2026-10-08 确认已手动关闭测试。重启恢复组从香港时间 11:16 左右开始，`soak/result.json` 记录 `passed: false`、实际 6840.529 秒（约 114 分钟），最后错误为 `contract timeout: create`；不能仅凭该错误断定服务缺陷，也不能忽略失败记录。不中断进程的连续组从香港时间 11:28 左右开始，保存的最后样本约 100 分钟，没有最终 `result.json`。原执行会话已无法恢复，因此不宣称退出码为 0 或完整退出检查通过。

两组原始日志保留，不自动重启用户已关闭的测试。长时间验收仍需一次完整 7200 秒的运行、成功结果以及结束后的 worker 清理证明；若同时采用恢复组与连续组，应分别签收。其他通过项目不需要仅因本次终止而重复执行。

每轮实际并发持有/运行 2 个 worker，再取消、重复请求和关闭临时连接；空闲时必须回收 worker。每 20 轮授权并替换 scratch 会话，每 100 轮替换手机会话，以控制历史工作集。relay 每 15 分钟重启，停止期间产生桌面 outbox，再验证单次补投递、活跃绑定与游标保持；session 每 45 分钟冷重启，核对条目不丢失。读取 `/proc` 所有运行时线程的 children，避免漏计 Tokio 从其他线程创建的 worker。

首轮脚本误选已删除的桌面话题，约 8 分钟后中止；随后预检发现重启会按规范清理已删除绑定，修正了不恰当的全量绑定相等断言。两者均为测试驱动问题，证据保留在 `soak-harness-failed/` 和 `soak-rotation-check*/`，不计入正式 2 小时。修正后的快速预检覆盖两次 session 重启、六次 relay 重启与会话轮换。正式运行重新完整计时。

验收阈值：实际 worker ≤2、relay 不启动 worker；RSS/FD 每轮硬上限 192 MiB/40；预热后空闲 RSS 末值相对四分之一处 ≤32 MiB 增长、空闲 FD ≤基线 +3。结束后检查观察到的 worker PID 全部退出。阈值通过不等价于所有供应商 SDK 或数周生产负载已验证。

## 本轮范围外的事项

- 如后续恢复长时间验收，需完成完整 2 小时负载，核对最终 RSS/FD、worker 回收、重复请求及重启恢复，保存通过结果与退出状态。当前手动终止样本不能替代。
- 完成后将本报告及归档文档的浸泡状态改为通过，重新打包 x86_64 候选并核对归档内外摘要；最终包必须携带最终报告。
- 实际发布时确认正式版本、标签及 x86_64 Release 附件。本地候选已通过，但未完成外部发布。

## 发布候选与未覆盖边界

本次推荐发布候选为 `service-artifacts/pi-acp-services-0.9.4-x86_64-unknown-linux-musl.tar.gz`；默认 GNU 打包也已验收，另生成同版本 `x86_64-unknown-linux-gnu` 候选，含归档 `.sha256` 与内部 `SHA256SUMS`。打包实际检查归档内外 SHA-256、执行权限，并用合成配置哨兵验证额外 `telegram.env` 不入包；构建脚本拒绝覆盖非产物目录。本轮验证记录为 `.test-results/non-soak-acceptance-2026-10-08/packages.json` 与 `guards.json`。

`x86_64` musl 包中的两个 daemon 均静态链接，无 `DT_NEEDED`、无 `GLIBC_*` 依赖；使用 rustls / bundled webpki-roots，无 OpenSSL 动态依赖。版本号来自当前 package.json；该未提交工作区候选不等于历史 `v0.9.4` release。

CI 配置为 x86_64 原生 runner 的 musl 构建、生产 smoke、完整服务契约及附件归档。本次没有推送、触发远端 CI、创建标签或发布外部 Release；真实群组、真实模型以及真实掉电均未验证。归档要求的本地验收与发布候选准备，与实际外部发布分别记录。

## 复现

```bash
npm run test:full
npm run test:native-fork
npm run build:services
npm run test:service:rollback
PI_SOAK_SECONDS=7200 npm run test:service:soak
npm run test:service:artifact -- --dir service-dist
npm run package:services
npm run format:check
```

双服务集成支持 `PI_INTEGRATION_SESSION_DAEMON` / `PI_INTEGRATION_RELAY_DAEMON` 指定本机服务产物。生产目录和启用 mock feature 的测试目录必须分开。
