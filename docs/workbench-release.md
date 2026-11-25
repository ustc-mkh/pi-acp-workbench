# 安装与部署

支持 Linux x86_64 的 GNU/musl 目标。VS Code 需要 1.96+；Remote SSH/WSL 中，扩展、服务和 Agent 在同一扩展宿主机器、同一账户运行。

## 安装与启动

1. 从 [Releases](https://github.com/ustc-mkh/pi-acp-workbench/releases) 下载同版本 VSIX 和适合系统的服务包，核对发布校验和后解压。
2. 单独安装所需 ACP Agent，并按各 CLI 的方式完成 provider 登录。
3. 复制服务包中的 `examples/workbench.json`，修改绝对 `storage.root` 和 `workers` 的 `command`、`args`、`env`；禁用的 worker 设为 `null`。首次安装使用空数据目录。
4. 启动服务：

```sh
./pi-acp-workbenchd --config /absolute/path/workbench.json
```

5. 在 VS Code 执行 **Install from VSIX…**，安装扩展并信任工作区。设置 `piAcp.workbenchSocket` 为 `<storage.root>/workbench.sock`；留空默认使用 `~/.pi/pi-acp-workbench/workbench.sock`。修改后执行 **Developer: Reload Window**。

扩展连接已有服务，不自动启动 daemon。默认配置使用 PATH 中的 `pi-acp`；需要本仓库 Pi 增强功能时，将 command 设为 Node 的绝对路径，args 指向配套构建的 `dist/pi-adapter.mjs`。Node adapter 需要 Node.js 22+。详见 [VS Code](workbench-vscode.md) 与 [Telegram](workbench-telegram.md)。

长期运行可编辑包内 `examples/pi-acp-workbenchd.service`，替换 `ExecStart` 的程序和配置绝对路径，安装为 systemd 用户服务。服务账户需要访问工作区、存储和 Agent 程序；Telegram token 通过环境变量注入。

### 启用 Antigravity

在服务所在机器上用同一账户运行 `agy acp --help` 确认 CLI 支持 ACP，再运行 `agy acp --login` 完成登录。将下面的字段加入 `workbench.json` 的 `workers` 对象。如果服务的 PATH 找不到 `agy`，请填写其绝对路径。[Google Antigravity ACP 文档](https://antigravity.google/docs/cli/acp/)

```json
"antigravity": { "command": "agy", "args": ["acp"], "env": {} }
```

重启宿主，在 VS Code 的 Harness 选择器中选择 **Antigravity** 并新建会话，或在 Telegram 发送 `/new antigravity`。省略该字段或设为 `null` 会禁用此 worker。

登录后可在源码目录运行 `npm run test:harness -- antigravity`，用空会话检查原生重连。该检查只创建和恢复会话。

## 从源码构建

需要 Node.js 22+ 和 Rust/Cargo：

```sh
npm ci
npm run build
npm run build:services
npm run package:services
npm run package
```

| 输出                 | 内容                                  |
| -------------------- | ------------------------------------- |
| `dist/`              | VS Code 扩展、浏览器资源和 Pi adapter |
| `service-dist/`      | 服务 binary、manifest                 |
| `service-artifacts/` | 服务归档及校验和                      |
| 仓库根目录的 `.vsix` | VS Code 安装包                        |

`build:services` 支持 `--target x86_64-unknown-linux-gnu` 或 `--target x86_64-unknown-linux-musl`，跨编译需要对应 target 和 linker。服务包只包含程序、manifest、许可证、公开文档和配置示例，不包含业务数据或凭据。manifest 记录目标平台、文件哈希、源码来源及协议/存储版本。

发布候选验证入口是 `npm run test:rewrite`；GNU 与 musl 需验证各自制品。默认测试使用模拟 ACP/Bot，真实 provider 和 VS Code Extension Host 需在相应环境验证。

## 升级与回退

1. 停止接收新任务，处理或明确停止未完成任务，关闭宿主并等待进程退出。
2. 用匹配旧数据的 binary 做[离线备份](workbench-storage.md)，另行备份 Pi profile、provider 原生会话和工作区。
3. 配套更新 VSIX、宿主、Pi adapter 和配置，先在隔离副本验证，再使用原数据目录启动兼容版本。
4. 保留旧程序、配置和数据的匹配备份；回退时停止新宿主，保存新数据后恢复整套旧组合。

当前 IPC/storage 合同均为 3，但相同版本数字不保证任意早期开发 schema 兼容。已验证的兼容 2.0.x 数据可保留历史并新增所需设置字段。首次打开旧会话表时，宿主在事务内扩展 harness 约束并校验外键；不兼容、损坏或未版本化的非空目录会拒绝启动。当前没有旧格式导入器：不兼容数据需保留旧环境，新版本使用独立空目录，旧历史不会自动出现。

不要修改版本标记、删除锁文件或清空数据来绕过检查。新数据目录也不继承旧 Telegram offset、待发送队列和话题绑定，不能默认无缝接续同一 Bot。回退不会撤销已经发生的文件修改、费用或 Telegram 发送。
