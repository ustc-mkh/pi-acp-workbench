# 测试与发布

从仓库根目录执行。日常只需一个命令；所有自动单元、模拟协议与浏览器测试都不调用付费模型。

## 两个主要入口

| 场景 | 命令 | 执行内容 |
| --- | --- | --- |
| 日常修改 | `npm test` | 类型检查 + 受未提交改动影响的测试 |
| 提交 / 发布前 | `npm run verify` | 类型检查 + 全部自动测试 + 构建 + 真实浏览器冒烟 |

`npm test` 包含已暂存、未暂存及未跟踪文件，通过 Vitest 的依赖图选择测试。工作区没有相关改动时仅类型检查，不代表执行过完整回归。包配置、锁文件、构建脚本、模拟进程和原生适配器代码变更会自动触发全部测试，因为子进程加载不在普通导入图中。CSS / 布局变更应执行 `verify`。

只需要完整单元和模拟协议测试（不需要浏览器）时，用 `npm run test:all`。已有提交、干净检出或 CI 应使用 `test:all` / `verify`，不要依赖默认的改动筛选。

调试单个问题仍可直接指定：

```bash
npx vitest run test/controller.test.ts -t 'native branch'
```

## 浏览器与打包

`verify` 已包含构建和浏览器验证，无需再依次手动执行 check、test、build、test:browser。单独验证 UI 可运行 `npm run test:browser`。

浏览器依次使用 `CHROME_PATH`、系统 `/usr/bin/google-chrome`、Playwright 安装的 Chromium。未安装时执行一次 `npx playwright install chromium`，或指定已有浏览器：

```bash
CHROME_PATH=/absolute/path/to/chromium npm run test:browser
```

截图统一放在已忽略的 `test-results/browser/`。测试需要允许本地端口和子进程；它不等价于真实 VS Code Webview 的 CSP / 宿主集成验证。

验证后用 `npm run package` 打包。VSCE 的 prepublish 钩子执行一次类型检查与构建，输出父目录 `pi-acp-workbench-<version>.vsix`，不再重复构建。打包本身不运行完整测试。构建同时生成增强适配器、渲染资源与第三方许可证声明。

## 保留的关键自动覆盖

- 会话生命周期：显式新建、恢复、Harness 隔离、偏好继承、暖缓存与失败回退。
- 数据完整性：共享租约、版本冲突、删除防复活、关闭本机保存时保护共享记录。
- 原生分支：节点与工具边界、历史设置、继承用量排除、取消和断连恢复。
- 协议与渲染：ACP 流式/权限/取消、图片限制、Markdown / 数学 / SVG 净化。
- 状态同步：消息对象替换、旧图片与统计不重复序列化、增量更新和丢包重同步。
- Telegram：群组 / 用户 / 话题隔离、游标防重放、增量消息与完成通知、远程授权、共享租约及并发停止；使用模拟 API 和 ACP，不需要 Bot token，也不向真实群组发消息。内置适配器索引覆盖多个真实子进程同时写入。

这些行为已由自动测试覆盖，不要求每次修改再手动遍历一份重复清单。新测试优先补现有文件中缺失的行为；不为同一行为重复增加单元、宿主与浏览器断言。浏览器只验证真实布局、交互及 DOM 环境无法代替的链路。

## 按需运行的外部集成验证

以下不放入日常或 `verify`，只在对应集成发生变化时运行：

- `npm run test:native-fork`：要求安装支持 `ctx.fork(...,{position:'at'})` 的 Pi，可用 `PI_ACP_PI_COMMAND` 指定路径。在临时目录验证原生图片/压缩前缀、历史设置、源文件不变、ACP fork/load 和继承用量，不提交模型请求；会读取已有 Pi 配置。
- `npm run test:harness`：要求安装 Codex / Claude ACP 适配器并准备凭据。通过 `CODEX_ACP_COMMAND` / `CLAUDE_ACP_COMMAND` 指定命令，`CODEX_ACP_ARGS` / `CLAUDE_ACP_ARGS` 传 JSON 参数数组。新建并恢复临时空会话，不调用 `session/prompt`，可能留下原生空会话元数据。
- 下方 Extension Host 测试：仅在 VS Code API、编辑器上下文或激活逻辑变化时需要。

上述验证都不代表真实付费模型、所有供应商或 Windows / Remote SSH 已验证。

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

## 发布

1. 执行 `npm run verify`；涉及 VS Code API 时再执行 Extension Host 验证。
2. 更新 package.json.version、package-lock.json 中根版本、src/agent.ts 的 clientInfo.version、package 脚本的 VSIX 文件名；同步 README 安装示例和 CHANGELOG。
3. `npm run package`，检查 VSIX 内容包含 dist/pi-adapter.mjs、Webview/KaTeX 字体、许可证及 README；不包含密钥、测试历史和 node_modules。
4. 在干净测试 profile 通过 Install from VSIX 安装，检查欢迎/恢复、模型继承、数学、Mermaid、图片与统计基本行为。记录未覆盖的平台。
5. 提交源码，创建与 package 一致的 vX.Y.Z 标签，推送仓库；创建同名 GitHub Release，附上 VSIX、变更说明及 SHA-256。源码由标签关联。
6. 从 Release 下载 VSIX 并核对摘要，确认发布附件可用。不要用 Marketplace 发布命令代替 GitHub Release 附件上传。

示例摘要命令：`sha256sum ../pi-acp-workbench-0.7.0.vsix`。发布需要相应 GitHub 权限；普通贡献者提交 PR 即可，无须发布权限。
