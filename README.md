# Pi ACP Workbench

在 VS Code 和 Telegram 中使用同一个 AI 编码工作台，接入 Pi、Codex、Claude 等 ACP Agent。会话、历史、模型设置和用量由本机服务统一管理；关闭编辑器后，已接受的任务仍可继续运行。

## 当前功能

- **编辑器对话**：流式 Markdown、代码高亮、LaTeX 和 Mermaid；思考过程、工具调用与待办分区展示，支持授权和表单交互。
- **上下文与附件**：将编辑器选区、文本文件、粘贴或选择的图片加入输入；草稿按会话保留。
- **会话与历史**：新建、搜索、重命名、删除和释放会话；按完整回合加载历史，复制消息、复用输入、导出完整 Markdown。支持 provider 提供的原生会话恢复与分支。
- **模型与用量**：选择模型、thinking/mode 等实际可用设置；按模型、日期和会话统计 token 与估算费用，管理自定义价格、倍率、模型可见性和 Pi context。
- **工作区变更**：自动展示逐轮 Diff，在编辑器查看文件差异；确认后按整轮或选定文件撤回，检查冲突并逐文件报告结果。
- **Telegram**：通过话题使用共享会话，提供新建/打开、目录选择、模型设置、授权回答、停止与队列控制、历史导出和通知设置。
- **持久化与恢复**：任务回执、历史和待发送消息保存在本机 SQLite；断线后恢复会话观察，Telegram 消息支持排队和失败重试。

## 使用方式

安装配套的 VS Code 扩展和 `pi-acp-workbenchd`，单独安装并登录所需 ACP Agent，再将扩展连接到本机服务。Telegram 是可选入口，与桌面共享数据。

支持 Linux x86_64、VS Code 1.96+，包括 Remote SSH/WSL；扩展宿主、服务和 Agent 在同一机器、同一账户下运行。

[安装与部署](docs/workbench-release.md) · [VS Code 使用](docs/workbench-vscode.md) · [Telegram 使用](docs/workbench-telegram.md) · [完整文档](docs/README.md)

## 功能边界

Agent 的模型、设置与原生分支能力取决于其 ACP adapter。Pi 自主后台轮次需要本仓库配套的增强 adapter；worker 释放或服务重启后，扩展定时唤醒不会自动恢复。当前不支持 Telegram 入站图片提示、终端输出流和 Pi stable Fast；Codex/Claude 原生分支不属于已支持能力。

停止任务不会撤销已发生的文件修改或费用。Diff 是工作区一轮前后的净变化，可能包含同时发生的手工修改；多文件撤回可能部分成功。Telegram 投递采用 at-least-once，发送成功但确认丢失时可能重复。

[贡献指南](CONTRIBUTING.md) · [更新历史](CHANGELOG.md) · [MIT 许可证](LICENSE)
