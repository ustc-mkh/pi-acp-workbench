# 单宿主候选版本：发布、切换与回退清单

> 这是当前源码的候选发布清单，不是上线授权或完整体验对齐声明。S7 的代码清理不补做 S3 功能，也不能消除真实环境验收缺项。严禁把下述“待验”当作通过。

## 本次提供的能力

- 单个 `pi-acp-workbenchd` 持有 storage lease、会话/worker、IPC v3 和可选 Telegram；VSIX 仅为客户端，不启动第二 daemon。
- 持久接受与 operation ID/指纹去重、未知结果查询、不自动重发；revision/epoch fence、物理 worker join、固定两 readers/一 writer、有限队列及正文/图片预算。
- 桌面会话/原生恢复与安全 fork、文本附件、流式消息/思考/工具/Plan、全历史导出和安全 Mermaid。
- Telegram 菜单/目录/历史/sync/推送设置、topic 排队/停止/替代输入及可靠完成投递。
- [每轮工作区 Diff/确认撤回](turn-diff.md)：保存的只读单/多文件快照、取消/失败后审阅、完整快照和冲突检查；多文件不是原子事务。
- [用量/模型管理](workbench-management.md)：SQL 聚合、cache/missing/unpriced/覆盖价，显式 Pi context/模型刷新、独立命名与费用、配置薄向导/显示偏好。

完整事实与证据为 [事实表](feature-parity.md) 和 [执行记录](workbench-parity-execution.md)，不能只用按钮或测试数量推断全部功能完成。

## 仍然存在的行为差异与发布阻塞

| 项目            | 当前事实 / 未通过条件                                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 桌面 P0（S3）   | typed context/image prompt、thinking/Fast/config options、Pi autonomous 生命周期仍未完整接通；不能宣称已全量恢复 main                          |
| Diff/undo（S5） | symlink 为 partial/拒绝，不提供链接正文 Diff；单次 undo 最多 256 文件/64 KiB 路径；外部 editor/残留进程不受宿主 gate 保护。保守差异尚待确认    |
| 用量            | 缺失事实不会猜 0；默认价是最近明确刷新结果；费用估算不是供应商账单。native load/fork 不回填继承用量                                            |
| 配置向导        | 仅创建新 JSON；手动明确 user/chat IDs，不 first-sender pairing，不安装、启动或升级服务                                                         |
| 间歇契约失败    | S7 一次 full-suite 在图片 revision batch 超时（15 秒）；随后同生产源码 full suite 通过，未证明根因。失败证据保留，不能据重跑通过宣称问题已修复 |
| 真实环境        | Extension Host 单/多 Diff、脏 buffer/信任/modal、系统剪贴板/对话框，在线 Pi/Codex/Claude 和真实 Bot 均需实际证据                               |
| 性能/平台       | GNU 本地结果不能替代 musl；600 秒多进程循环不能替代两小时单进程混合 RSS/WAL；storage-only mixed 不是 admission SLO/空载 A/B 证据               |

以上既有功能缺口或保守差异没有被本轮清理默认为延期/已获确认。因此严格 S7/整体发布出口仍未满足。

## 破坏性边界与制品核验

1. 使用同一次源码构建的 binary、VSIX、配置和 root。开发 IPC/存储标签仍为 3，**相同数字不代表较早开发 schema 兼容**：当前 required tables/columns 校验严格拒绝旧 shape。
2. `manifest.json.contracts` 必须与 smoke report 相同：`ipc:3`、`storage:3`、`rootPolicy:"new-root-no-migration"`。生产构建校验 Rust/TS 常量，prepare-release 拒绝缺失/不匹配的契约；这不是迁移 reader。
3. 检查 manifest 目标 GNU/musl、ELF/ABI、binary SHA-256、Rust source hash、commit/dirty provenance、`production:true` 和空 features。dirty 候选允许本地验证，正式发布必须干净源码与匹配 tag/commit。
4. 对实际目标运行 artifact smoke/IPC/Telegram 契约。每个平台独立取证；不要用当前机器另一制品或 mock API 抵充。
5. 服务包只包含固定公开文档 allowlist、唯一 binary、manifest、notices 与两个例子。文档相对链接必须在包内闭合；不会递归收集工作目录、配置、凭据或业务 root。

## 人工切换前（需独立授权）

- [ ] 核对上表阻塞和保守差异已解决/获得明确确认，真实环境及性能报告完整。
- [ ] 停接新任务，查询所有未决 operation ID，等待完成或明确停止并物理 join；Started/uncertain 不当作已回滚。
- [ ] 关闭旧宿主，确认 lease 已释放；不删除 lock 或猜测 socket stale，不并发启动两个持有者。
- [ ] 使用旧 binary 的离线 `storage export` 到新的私有目标，验证 manifest/hash/可读性；另行备份所需 provider native 文件与其适配器版本（root export 不包含这些外部文件）。
- [ ] 保留旧 binary/VSIX/配置和完整旧 root/备份的匹配组合；备份验读必须使用隔离副本，不直接打开业务 root。
- [ ] 在新的空 root 验证新组合，人工核对工作目录、worker executable/args、allowlist 与 token **环境变量名**。不导入/迁移/清空旧 root。
- [ ] 经授权整组切换 binary、VSIX、配置、root 与 socket；先做明确的小任务验读。完成前保留旧组合，不自动续跑旧未完成任务。

## 回退

停止新组合并 join，保留其完整 root 及 uncertain operation 证据。将旧 binary、旧 VSIX、旧配置、旧 root 作为一组恢复，禁止旧 binary 打开新 schema，禁止拼接两个 root 的 journal/outbox/usage 数据。

回退不会撤销已发生的工具、文件系统、模型费用或 Telegram 发送；原 operation ID 不得以新 ID 重放来“补回”。默认不提供自动迁移/导入器，如需转换须单独批准离线方案。禁止 reset/VACUUM/递归删 native history 充当回退。

## 本地验收入口（不部署）

```sh
npm run test:rewrite
npm run test:workbench:startup
npm run test:workbench:scale
npm run test:workbench:mixed
npm run test:workbench:soak -- --duration-seconds 600
# 真实已安装 VS Code + 隔离图形环境；不下载 VS Code，不读取默认 profile/root
xvfb-run -a npm run test:extension-host
```

Extension Host runner 不具备显示环境时以 **exit 2 / BLOCKED** 结束，不回退到 Chromium/mock。当前 smoke 只证明真实 contributed-command 激活、临时受信任目录、IPC 新建会话与未知快照 URI 拒绝，**不等于**完整 Diff/modal/信任/剪贴板矩阵。在线 provider/Bot 验收必须由操作者提供专用测试凭据、目标 chat/workspace 与费用授权；不要读取用户日常凭据来冒充测试环境。

本仓库命令不执行部署、push、systemctl 或真实 root reset。具体备份/lease 语义见 [发布](workbench-release.md) 与 [存储维护](workbench-storage.md)。
