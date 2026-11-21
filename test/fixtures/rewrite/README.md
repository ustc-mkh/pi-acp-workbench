# ACP / IPC 合同 fixtures

| 文件 | 用途 |
| --- | --- |
| `acp-contract.json` | 合成 ACP 1 消息，覆盖初始化、会话、输入、文本、工具、计划、用量、交互和取消 |
| `ipc-v3.json` | 本地 IPC v3 合同样例 |
| [ipc-command-policy.json](ipc-command-policy.json) | 每种 IPC 命令的有效请求、并发池、持久回执要求及桌面端预留名额分类 |
| `pi-sdk-1.3.0-native-offline.json` | 隔离环境下真实 Pi CLI 对合成本地历史的脱敏响应，无模型/网络请求 |

`test/contract-agent.mjs` 是独立 stdio 模拟 peer，支持流式消息、工具、图片、设置、交互及故障场景。`WORKBENCH_CONTRACT_NATIVE_STATE` 启用合成原生历史与分支，`WORKBENCH_CONTRACT_FORK_GATE` 在远端分支创建后阻塞响应，用于未知结果和取消测试。场景细节以 peer 实现和调用测试为准。

模拟 Pi/Codex/Claude profile 用于验证宿主协议行为，不代表真实模型兼容性。真实 Pi SDK 样例验证本地格式和 native 操作，也不代表在线模型流式输出。

## 运行入口

- `npm run test:contract:workbench`：真实宿主与模拟 ACP 的 IPC 合同。
- `npm run test:contract:workbench:telegram`：真实宿主与本地 mock Bot 的命令、投递与恢复。
- `npm run test:workbench:process-loss`：隔离宿主 SIGKILL 后的历史、回执和原生恢复。
- `npm run test:workbench:soak -- --duration-seconds 600`：持续本地模拟负载，报告写入 `.test-results/`。

真实 Pi SDK 离线分支检查需显式指定已安装 CLI：

```sh
PI_OFFLINE_PI_CLI=/absolute/path/to/pi/dist/cli.js npm run test:native-fork:offline
```

该入口使用隔离 HOME/profile、假凭据和 Node 网络拦截，执行依赖本地 SDK 的 ignored Rust 用例；缺少 SDK 或缓存会失败。普通测试不将这些跳过用例计为已执行。

Pi context 的离线集成检查在构建后运行：

```sh
PI_OFFLINE_PI_CLI=/absolute/path/to/pi/dist/cli.js node scripts/workbench-context-offline.mjs
```

环境隔离规则见[测试说明](../README.md)。
