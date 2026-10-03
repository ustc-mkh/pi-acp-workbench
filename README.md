# Pi ACP Workbench

一个通过 **Agent Client Protocol（ACP v1）** 接入 Pi Agent 的 VS Code 插件。提供侧栏对话、流式回答、代码上下文、工具执行卡片和 diff 预览，重点增强 Markdown 与数学公式体验。

本项目是独立实现，并非 Pi、OpenAI 或 Anthropic 的官方插件。面向常见编码助手工作流；不宣称与 Codex / Claude Code 的所有功能等价。

## 安装与使用

### 1. 准备 Pi 与适配器

在运行 VS Code 扩展宿主的机器上安装 Node.js 22+，按 [Pi ACP 适配器说明](https://github.com/svkozak/pi-acp) 安装 Pi 并配置模型供应商：

```bash
npm install -g @earendil-works/pi-coding-agent
npm install -g pi-acp@0.0.34
pi
```

在 Pi 的交互界面完成登录或 API key 配置。插件复用 Pi 的凭据，不单独收集模型密钥。如果所用 Pi 版本仍使用旧 npm 包名，请遵循对应 Pi 版本的安装文档；适配器必须与本机 Pi 版本兼容。

### 2. 安装 VSIX

在 VS Code 的扩展面板菜单选择 **Install from VSIX…**，选择 `pi-acp-workbench-0.1.3.vsix`，或执行：

```bash
code --install-extension pi-acp-workbench-0.1.3.vsix
```

打开并信任项目文件夹 → 点击活动栏的 **π**，插件会自动连接本地 Agent。连接失败或意外断开时才显示 **重新连接** 按钮。连接成功后输入任务，Enter 发送，Shift+Enter 换行。生成过程中可点击 **停止**。

上下文圆环在悬停或键盘聚焦时立即显示主题样式的用量提示。上滑阅读历史时，可点击消息区底部居中的圆形箭头回到最新消息。错误提示右侧的 **×** 可关闭当前错误，后续错误仍会正常显示。

**不配置模型也可以体验渲染**：命令面板执行 `Pi: Preview Markdown & Math`。

### 3. 配置 ACP 启动命令

默认调用全局 `pi-acp`，参数直接传给进程，不经过 shell。若从图形界面启动的 VS Code 找不到命令，请在用户设置中填入绝对路径：

```json
{
  "piAcp.command": "/absolute/path/to/pi-acp",
  "piAcp.args": [],
  "piAcp.env": {},
  "piAcp.showThoughts": true,
  "piAcp.persistHistory": true,
  "piAcp.maxContextChars": 60000
}
```

Windows 推荐绕过 `.cmd` 启动器，直接使用 Node 和适配器的 JS 入口；可用 `npm root -g` 找到全局模块目录：

```json
{
  "piAcp.command": "C:\\Program Files\\nodejs\\node.exe",
  "piAcp.args": ["C:\\Users\\YOUR_NAME\\AppData\\Roaming\\npm\\node_modules\\pi-acp\\dist\\index.js"]
}
```

同样支持其他 **ACP v1 stdio agent**：修改 command / args 即可。命令面板中的 `Pi: Open Login Terminal` 针对 `pi-acp --terminal-login`；其他 Agent 应在其自己的终端工具中完成认证。ACP v2 草案不在本版支持范围内。

## 使用体验

- **流式聊天**：支持 assistant、thought、tool、plan、usage 更新；用户向上滚动后不强制跳回底部。
- **模型和思考模式**：根据 Agent 返回的 `configOptions` / `modes` 动态显示，不硬编码模型名。适配器不提供时不显示。
- **上下文**：编辑器右键 `Pi: Add Selection to Chat` 或 Ctrl+Alt+P / Cmd+Alt+P；无选区时附加当前文件。发送前可移除。读取当前编辑器内容，包含未保存修改。最多 8 个附件，单个默认上限 60,000 字符，超过会提示缩小选区。
- **Slash 命令**：输入 `/` 展示 Agent 声明的命令；点击插入。也可以直接发送 `/compact` 等文本命令。
- **工具调用**：增量更新状态、位置、输出；结构化 `diff` 支持在 VS Code 中左右对比。这是已执行/报告修改的预览，不是延迟应用或回滚机制。
- **授权卡片**：完整展示 `session/request_permission` 工具信息和 Agent 的选项，原样返回所选 optionId；取消会返回 cancelled。
- **会话恢复**：保存最近 20 个本地会话索引及文本快照，点击历史记录后调用 `session/load`。不支持 load 的 Agent 会明确报错；不会把本地快照伪装成已恢复远端上下文。新会话使用新进程，旧会话是否可恢复取决于适配器持久化能力。
- **导出**：导出对话正文的原始 Markdown 和工具摘要。
- **多根工作区**：创建会话时选择一个工作目录，历史会话绑定其原始目录。
- **远程开发**：扩展运行于 workspace 宿主。在 Remote SSH / WSL / Dev Container 中，需要在远端安装 Pi、适配器和 Node，并在那里配置凭据。

## Markdown 与数学支持

所有渲染依赖和 KaTeX 字体随 VSIX 打包；渲染本身无需 CDN 或网络。

| 内容 | 支持 |
| --- | --- |
| 标题、列表、引用、链接、分隔线 | 支持 |
| 表格、任务列表、删除线、脚注 | 支持 |
| 围栏代码、多语言高亮、复制代码 | 支持 |
| `$a^2+b^2=c^2$` | 行内公式 |
| `\(e^{i\pi}+1=0\)` | 行内公式 |
| `$$…$$`、`\[…\]` | 独立公式与横向滚动 |
| `align`、`aligned`、`gather`、`equation`、`cases`、矩阵等 | 常见 KaTeX 环境；见其支持列表 |
| 分数、积分、求和、上下标、向量、黑板粗体 | 支持 |
| `\ce{2H2 + O2 -> 2H2O}` | mhchem 化学式 |
| 辅助技术 | 同时输出 HTML 与 MathML |

公式通过 Markdown token 规则解析，不对全文做正则替换，因此代码围栏与行内代码中的 `$`、反斜杠保持原样。流式未闭合公式暂按普通文本显示；闭合后重新渲染。不支持的 LaTeX 命令显示公式源码，不会中断整个回答。宏在每个公式内部独立，不会污染后续消息。

KaTeX 不是完整 TeX 引擎：**TikZ、任意 LaTeX 宏包、Mermaid 图和原始 HTML 不在本版范围内**。模型输出的 Markdown 图片显示占位文字，不自动请求远程图片。价格 `$5 和 $10` 按普通文本处理；单美元公式遵循不以空白开始/结束等常见约定。

## 权限与数据边界

插件只在受信任的文件工作区启动本地进程。Webview 关闭脚本注入、远程网络请求与原始 HTML，渲染结果经过 DOMPurify 净化，KaTeX 使用 `trust: false`。外部链接仅允许 http / https / mailto；工作区文件链接经真实路径检查，不能借符号链接打开目录之外的文件。启动命令设置为机器级，避免仓库设置悄悄替换可执行程序。

**ACP 授权卡片不等于 Pi 工具沙箱。** `pi-acp` 底层 Pi 可以直接读写文件、运行命令，并不保证针对所有操作发出授权请求。只有 Agent 发来 `session/request_permission` 时插件才能展示审批。若需要强制逐次审批或严格隔离，应在 Pi/适配器或容器层实现；不要把 UI 中的授权按钮当成强制安全边界。本版不声明 `fs/*` 或 `terminal/*` 委托能力。

本地快照保存在 VS Code 的 workspaceState（最多 20 条，每条快照超过 2 MB 时只保留索引及提示），可能包含代码和对话。`piAcp.persistHistory: false` 会清除插件保存的历史。清除本地历史不删除 Pi 自己的会话文件。stderr 保留在 `Pi Agent` 输出面板以便诊断，插件不记录环境变量或 stdout 协议原文、不包含遥测。

## 开发

```bash
npm ci
npm run check
npm test
npm run build
npm run test:browser  # 默认 /usr/bin/google-chrome，可用 CHROME_PATH 覆盖
npm run package
```

在 VS Code 打开本项目，F5 启动 Extension Development Host。打包会在项目父目录生成 VSIX。

目录：

```text
src/agent.ts       ACP SDK / stdio / 进程生命周期
src/extension.ts   VS Code 侧栏、会话、授权、上下文和 diff
src/state.ts       流式更新归并
src/shared.ts      Webview 通信类型
webview/           UI、Markdown / KaTeX token 解析与净化
scripts/           构建和真实浏览器检查
test/              协议模拟服务、渲染/状态测试、扩展宿主测试
```

协议模拟测试无需模型 key，覆盖初始化、能力协商、历史重放、分片 UTF-8、权限选择、取消、超时和进程退出。渲染测试覆盖流式公式、代码隔离、无效 LaTeX 和内容净化。`test/host.cjs` 可通过 VS Code 的 `--extensionTestsPath` 在独立测试 profile 下运行，需要 `PI_HOST_TEST_RESULT` 指定结果文件。

实际 Pi 模型推理需要用户自己的供应商账户。本交付的自动化测试不调用付费模型，不代表已验证所有供应商、Windows 或 Remote SSH 环境。

## 常见问题

- **ENOENT / 启动失败**：检查 `piAcp.command`、Node 版本和 VS Code 的 PATH，优先使用绝对路径。
- **认证失败**：运行 `Pi: Open Login Terminal` 或在终端执行 `pi`，完成认证后重新连接。
- **停止超时**：先发送 ACP cancel；5 秒仍未返回则终止连接和进程树，之后尝试从历史恢复。
- **会话无法恢复**：确认打开的是原工作目录，Pi 的持久化文件仍存在，且 Agent 支持 `session/load`。
- **日志**：执行 `Pi: Show Agent Logs`，检查适配器 stderr。

## 参考

- [ACP v1 初始化规范](https://agentclientprotocol.com/protocol/v1/initialization)
- [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)
- [Pi ACP 适配器](https://github.com/svkozak/pi-acp)
- [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview)
- [KaTeX 支持的函数](https://katex.org/docs/supported.html)
