# 测试与发布

从仓库根目录执行。单元和模拟协议测试不调用付费模型。

## 日常命令

```bash
npm ci
npm run check
npm test
npm run build
npm run test:browser
npm run package
```

`npm run package` 会构建并由 VSCE 的 prepublish 钩子执行类型检查/构建，输出父目录 `pi-acp-workbench-<version>.vsix`。它不自动执行全部测试，因此发布前仍需 `npm test`。构建会生成适配器、渲染资源和第三方许可证声明。

## 分层测试

| 范围 | 测试 | 目的 |
| --- | --- | --- |
| Harness | harness / harness-agent / controller | profile 配置、ID 命名空间、发送/授权/取消、切换互斥、偏好隔离、缺失 loadSession 的只读回退 |
| 标准 ACP 传输 | agent.test.ts + mock-agent.mjs | 独立 NDJSON peer；分片 UTF-8、初始化、超时、取消、退出、权限 |
| 宿主状态机 | controller.test.ts | mock vscode + 真实子进程；创建/恢复、偏好、缓存、持久化、上下文编辑、图片 |
| 内置适配器 | bundled-adapter.test.ts | 实际构建增强适配器；协商私有扩展、统计、隔离与取消摘要 |
| 纯逻辑 | state / state-channel / context / checkpoints / telemetry / snapshots / session-cache | 合并、增量状态与同步、预算、检查点、存储和统计 |
| 适配器加固 | build-adapter / usage-cache | 补丁唯一匹配、日志分页缓存及追加/截断失效 |
| 共享历史 | shared-history / controller | 多实例写入、租约交接、只读查看、旧历史迁移、删除防复活和版本冲突 |
| 执行过程与输入区 | transcript / composer-resize | 分组边界、流式折叠状态、全局展开、输入区高度与键盘调整 |
| DOM / 渲染 | markdown / diagrams / selectors / tooltips / image-paste 等 | 数学、净化、模型控件、交互和附件 |
| 真实浏览器 | scripts/browser-smoke.mjs | 窄视口、深浅色、公式流式、欢迎页显式新建、发送、权限、取消、diff |
| Extension Host | test/host.cjs | 真正 VS Code 激活、命令、ACP 子进程、编辑器选区 |

只跑相关文件：

```bash
npx vitest run test/controller.test.ts test/selectors.test.ts
npx vitest run test/controller.test.ts -t 'inherits'
```

浏览器脚本默认使用 `/usr/bin/google-chrome`，其他路径：

```bash
CHROME_PATH=/absolute/path/to/chromium npm run test:browser
```

脚本启动本地临时 HTTP 服务和 headless 浏览器，在项目父目录输出 preview-dark.png / preview-light.png。运行环境需要允许本地端口和子进程。此测试不等价于 VS Code 的完整 Webview 宿主和 CSP 测试。

## Extension Host 测试

先构建，然后用独立用户目录及临时测试工作区启动 VS Code。下面命令适用于 Bash；将 code 替换为可用的 VS Code CLI。测试会改动独立 profile 设置并在临时工作区写 context.ts，不要对真实项目执行此测试。

```bash
npm run build
PI_TEST_ROOT="$(mktemp -d)"
mkdir -p "$PI_TEST_ROOT/workspace" "$PI_TEST_ROOT/profile" "$PI_TEST_ROOT/extensions"
PI_HOST_TEST_RESULT="$PI_TEST_ROOT/result.json" code \
  --user-data-dir "$PI_TEST_ROOT/profile" \
  --extensions-dir "$PI_TEST_ROOT/extensions" \
  --extensionDevelopmentPath="$PWD" \
  --extensionTestsPath="$PWD/test/host.cjs" \
  --disable-workspace-trust --skip-welcome \
  "$PI_TEST_ROOT/workspace"
cat "$PI_TEST_ROOT/result.json"
```

需要桌面显示环境（Linux CI 通常使用虚拟显示器）。此测试故意设置工作区信任，以便启动 mock Agent。结果文件中的 passed=true 才表示执行完成；VS Code 启动成功不代表测试通过。

## 会话变更的回归清单

- 空工作区首次打开不发送 session/new；重复 ready 不重试。
- 左上角切换 harness 不自动创建/发送，不把草稿或附件转给其他 profile；繁忙时拒绝切换。
- 同一原生 Session ID 在 Pi / Codex / Claude 的历史和租约中互不覆盖；标准 RPC 出站使用原生 ID，通知与权限入站使用本地 ID。
- 切换回历史使用原 harness，模型偏好和活动指针隔离；不支持 load 时只读，非 Pi 不调用 Pi 私有扩展。
- 真实适配器初始化握手不等同于真实模型验证。当前开发验证过 codex-acp 2.1.1 / claude-agent-acp 0.85.1（@agentclientprotocol scope），完整认证/模型调用需单独验证。
- 显式新建恰好创建一个会话，继承上次 model 和 thinking；模型切换后重新读取选项。
- config thinking 与旧版 modes 同时提供时只保留一个有效控制。
- 选择后不发送消息，重启仍可继承；关闭历史保存后偏好仍保留。
- 冷启动恢复最后活动 ID；暖缓存恢复不调用 initialize/load/new。
- 连接失败、不支持 load、取消后重连都不能自动变成空白对话。
- 删除当前历史后自动保存不重新加入；重启不自动打开另一条历史。
- 设置持久化失败不能使完成的回复卡在 busy；预览等待保存时禁止发送和新建。
- 删除/关闭历史会清除统计标题但保留计费记录；并发写入不能在清空后复活。
- 流式增量不重复传输旧图片；丢失更新后请求完整同步；重复 Diff 预览不无限累积缓存。
- 两个共享历史实例并发追加不丢会话；超过 20 条不裁剪；只读客户端释放后可接管，删除记录不能被旧窗口或迁移复活。
- 浏览器中执行过程默认折叠、最终回答可见；拖动分界线改变输入高度，滚动条不显示箭头。
- 注入 VS Code 默认的 html scrollbar-color 后，仍使用透明轨道、6px 滚动条；同时检查标准属性和实际 gutter 宽度，不能只检查伪元素样式。
- 同名分支编号不同；旧历史自动补号，跨客户端、排序和删除消息重建后编号保持稳定，清空后不复用。
- 分支保留原对话；删除消息保持逻辑统计归属；待同步和压缩检查点恢复仍正确。
- 真实 Pi 验证 model/thinking（至少一个非 OpenAI 提供商），检查重启后的原生历史确实恢复。需要账户的验证须明确记录环境，不能把 mock 测试描述为真实模型兼容性结论。

## 可选真实 Harness 恢复测试

安装 ACP 适配器并准备凭据后运行 `npm run test:harness`。默认从 PATH 启动 `codex-acp` 和 `claude-agent-acp`；可通过 `CODEX_ACP_COMMAND` / `CLAUDE_ACP_COMMAND` 指定绝对命令路径，通过 `CODEX_ACP_ARGS` / `CLAUDE_ACP_ARGS` 传入 JSON 参数数组（例如 Node 路径加适配器入口）。

此测试会使用当前用户的配置与凭据，在临时工作目录新建空会话，关闭进程，再恢复并验证命令通知；不会调用 session/prompt。适配器可能在原生索引中留下空会话元数据。它不是付费模型回复或真实 VS Code GUI 联调测试，不纳入默认 npm test。

回归覆盖：本地/共享存储下的空会话重复恢复、编号/设置保留、旧记录清理、已有内容和不完整记录不重建、普通内部错误不重建；浏览器覆盖菜单实际命中测试、20 条命令、异步通知、滚动与 Enter 不误发送。

## 发布

1. 完成类型检查、完整测试、构建及相关 UI / Extension Host 验证。
2. 更新 package.json.version、package-lock.json 中根版本、src/agent.ts 的 clientInfo.version、package 脚本的 VSIX 文件名；同步 README 安装示例和 CHANGELOG。
3. `npm run package`，检查 VSIX 内容包含 dist/pi-adapter.mjs、Webview/KaTeX 字体、许可证及 README；不包含密钥、测试历史和 node_modules。
4. 在干净测试 profile 通过 Install from VSIX 安装，检查欢迎/恢复、模型继承、数学、Mermaid、图片与统计基本行为。记录未覆盖的平台。
5. 提交源码，创建与 package 一致的 vX.Y.Z 标签，推送仓库；创建同名 GitHub Release，附上 VSIX、变更说明及 SHA-256。源码由标签关联。
6. 从 Release 下载 VSIX 并核对摘要，确认发布附件可用。不要用 Marketplace 发布命令代替 GitHub Release 附件上传。

示例摘要命令：`sha256sum ../pi-acp-workbench-0.4.1.vsix`。发布需要相应 GitHub 权限；普通贡献者提交 PR 即可，无须发布权限。
