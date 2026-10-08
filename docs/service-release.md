# Linux 服务发布包

会话服务与 Telegram relay 是独立 Rust 二进制；VSIX、扩展宿主和 Pi 适配器仍使用 TS/JS。发布包包含两个 daemon、两个 JS 适配器、许可证说明、`manifest.json` 和 `SHA256SUMS`。Node.js ≥22 与 Pi 命令需在目标服务器另行安装；服务包不包含它们，也不包含配置、token 或用户历史。

## 架构与 ABI

服务仅支持 Linux `x86_64`，推荐发布目标为 `x86_64-unknown-linux-musl`。实际发布的 musl 产物必须通过构建脚本的 ELF 架构检查，并且没有 `DT_NEEDED` 动态库或 `GLIBC_*` 符号要求；musl 静态链接在二进制内，不依赖目标系统的 glibc、动态加载器或 OpenSSL。

默认 `npm run build:services` 仍按本机 Rust host 构建 GNU 产物，输出 `service-dist/`。GNU 产物的实际动态库与最低 glibc 符号版本写入 `manifest.abi`；最低版本由构建环境决定，不能把 Fedora 上的构建当作旧版 Ubuntu 可用包。本次 Fedora 原生构建要求 glibc ≥2.39；通用发行包使用 musl 避免这项限制。

`manifest` 同时记录 target、arch、libc、Rust 编译器、基线提交/工作区状态、Rust 源码指纹、生产 feature 集合、TLS 实现和四个可执行资产的 SHA-256。构建使用 Cargo.lock 的 `--locked`，不启用 `contract-test`。模拟传输只属于测试构建。

在同架构 Linux 上构建 musl 包：

```bash
rustup target add x86_64-unknown-linux-musl
# Debian/Ubuntu: 安装 musl-tools 和 binutils。
CC=musl-gcc CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=musl-gcc \
  npm run build:services -- --target x86_64-unknown-linux-musl
npm run test:service:artifact -- --dir service-dist
npm run package:services
```

脚本只替换含有服务 manifest 的生成目录，不覆盖源码/数据目录。需要 `cargo`、`rustc`、`readelf`；打包额外需要 `tar`。CI 使用 [GitHub 官方 Linux runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)，在 x86_64 原生 runner 构建 musl 生产包，运行真实 worker/重启/TLS smoke 和 22 项服务契约，再上传包及校验值。配置 CI 不等于已运行远端 CI，也不等于已发布 GitHub Release。

## TLS 与代理

Telegram 使用 reqwest 的 `default-features=false, rustls-tls`：TLS 实现为 rustls，CA 根证书由 `webpki-roots` 随二进制打包；没有 OpenSSL 动态依赖。证书链和主机名验证均保持开启，生产 endpoint 固定为 `https://api.telegram.org/bot<TOKEN>`。

`SSL_CERT_FILE` 不用于扩展当前 bundled roots。使用企业 TLS 拦截代理时，其私有 CA 不会因此自动受信任；应使用不替换 Telegram 证书的 HTTP CONNECT 代理，或另行提供经过审核的自定义 CA 配置。

reqwest 会使用标准 HTTP(S) 代理环境变量；本次生产包 smoke 通过本机 HTTP CONNECT 代理验证 `HTTPS_PROXY`。错误信息不包含 token 或凭据 URL。`PI_TELEGRAM_API_BASE` / `PI_TELEGRAM_PACE_MS` 在生产构建中无效。

TLS smoke 只使用本地生成的、SAN 为 `api.telegram.org`、`CA:FALSE` 的自签名 server-leaf 证书，并核对实际 `unknown CA` 告警。本次 x86_64 发布产物必须拒绝它，并且不向 mock HTTP endpoint 发送请求。该检查验证未知 CA 拒绝与生产入口隔离，不代表已连接真实 Telegram 或测试所有公网 CA。

## 校验、安装与回滚

在下载目录检查归档摘要，解压后检查资产摘要：

```bash
sha256sum -c pi-acp-services-<version>-<target>.tar.gz.sha256
tar -xzf pi-acp-services-<version>-<target>.tar.gz
cd pi-acp-services-<version>-<target>
sha256sum -c SHA256SUMS
./pi-acp-session-daemon --help
./pi-acp-telegram-daemon --help
```

升级前结束在途任务，停止 relay，再停止 session service；确认两个服务及其 worker 已退出后，备份整个数据目录、配置、systemd unit 和旧产物。安装新包时同步调整 unit 的绝对路径，先启动 session service，再启动 relay。可参考仓库 `examples/pi-{sessions,telegram}.service`；升级过程中两个版本不得同时写同一数据目录。

回滚时按相同顺序停止新服务，另外保留升级后数据副本，再恢复升级前的版本化备份与旧产物/unit，按 session → relay 顺序启动。恢复备份会回到备份检查点，不包含升级后的新任务；备份中待投递 outbox 仍会按恢复后的确认状态投递。需要保留升级后工作时，先保存该副本，再单独评估数据合并，不自动重放请求。

旧实现只从历史 release/commit 获取，不恢复主分支 TS daemon。`npm run test:service:rollback` 在隔离目录从 `v0.9.4` 构建旧实现，实际执行旧→新→恢复备份→旧，验证历史、墓碑、偏好、收据、Telegram 状态和 outbox；另验证旧读者能读取本次新写入的样例。它不修改实际用户数据，也不证明任何未来格式都可逆。

## 验收入口

```bash
npm run test:full
npm run test:native-fork
npm run test:service:rollback
PI_SOAK_SECONDS=7200 npm run test:service:soak
npm run test:service:artifact -- --dir service-dist
npm run format:check
```

浸泡默认 2 小时，使用生产会话 daemon、测试 relay 和模拟 ACP/Bot；每轮检查实际 worker 上限，定期观察空闲 RSS/FD，覆盖取消、授权、重复请求、连接轮换、会话删除、relay 离线投递及双服务重启。环境变量 `PI_SOAK_SESSION_DAEMON` / `PI_SOAK_RELAY_DAEMON` 可指定产物；mock relay 需单独启用 `contract-test`。详细结果见 [Rust 验收报告](rust-acceptance.md)。
