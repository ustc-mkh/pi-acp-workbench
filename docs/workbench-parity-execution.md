## S4 主干集成收尾（自动化部分）

本轮锁定 S4 收尾表的第 1–5 项；不延伸目录/菜单等已交付模块。

- 首任务前模型：手机 `/discover` 明确启动一次受控 provider adapter readiness（10 秒预算），不发送业务 prompt；菜单冷查询仍不启动 worker。按实际 provider catalogue 显示模型/模式，并由原设置命令执行。synthetic Bot 合同验证先发现、选择模型再开始任务。真实 Pi/Codex/Claude 发现体验仍待验。
- 队列/控制：durable inbox 承担排队；queue notice 与 `/queue` 暴露输入 ID。scheduler 允许 answer/stop/interrupt 穿过等待中的 prompts，但遇到同 topic 配置/new/history mutation 保留因果顺序。stop barrier 原子取消之前同 topic/session prompts 并冻结被取消 IDs；interrupt 再按独立 operation 接受替代 prompt。未知 operation 不换 ID 重发；已接受 queued work 重启恢复。新增 writer trigger 故障回滚/重启测试 `telegram/workflow_tests.rs`，覆盖 barrier receipt 失败时 inbox 不半取消、相同 barrier 重放一致、后续 prompt 不被误取消。
- 输入/输出同步：host 接收每个 committed Turn 的 User input delivery immutable reference；Telegram 来源输入不 echo 回源 topic，desktop/其他 origin 在适用 topic 投递。沿现有 outbox/manifest/history delivery identity 去重，不复制正文副本或重跑 Agent。notifications/silent 继续适用。
- `/sync`：forum 以稳定 activity sequence watermark 按最近 committed activity 分页最多10个 sessions，前5个最多10条、其余最多2条、每 session 扫描最多200 committed records；冻结 session/cwd/watermark/limits；复用 topic effect 与 History outbox/cursor、每源 durable receipt。history 按相邻同 role 的 provider message ID 重组；无 ID/不连续片段独立输出。private sync 仅导出当前绑定 session。重放恢复原 plan/receipt，不重跑 Agent；topic creation uncertain 不自动换 effect ID。
- preview：有界内存最多8会话、每 session 尾部最多3000 UTF-16 units；每轮最多2 candidate，每3秒一次，既有 sender lanes/topic reservation 内 send/edit，1秒 HTTP timeout；lag/restart 可丢弃，失败关闭该 turn preview。始终 silent，最终/授权/错误仍走可靠 outbox。新增 unicode 边界、调度预算/节流单测和 real daemon/local Bot gated streaming 合同，验证一条 preview 被 edit 合并、最终图片/文字仍可靠且没有 delta outbox。
- 修复集成发现：scheduler 曾可能让授权 answer 被已排队 prompt 阻挡；Bot fixture forum thread 分配与并行历史 fixture 冲突；turn input outbox 引入后旧 app 测试错误地断言无待投递。均按真实因果/消息行为修正，原失败日志保留在 `.test-results/parity-s4/`。
- 自动化证据：`cargo test -p pi-acp-workbenchd workflow_tests` 2 passed；Telegram 定向 73 passed（新增 preview 后需以最终 gate 为准）；实际 daemon + local HTTP Bot synthetic contract 28 项通过，最后一项串起 create→discover/model→A/B queue→authorization→stop/interrupt→restart queued input→input/output/history→preview→sync，检查 Agent 不重放和跨会话 page 回执。
- 600 秒 soak 与前次 `test:rewrite` 均在后续 grouping/activity 改动之前通过，只作为该源码快照的历史证据，不代表最终候选构建。最终门禁将对最终修改重跑。

S4 主流程在本次本地自动化范围内已贯通，先前提出的“session sync 排序/entry 分组”差异现已消除：新增 `activity_seq`（会话创建/每次 committed revision 原子递增）及稳定 activity cursor；history/sync 同角色、相邻记录且 provider message ID 相同时合并为单一 message/export intent，无 ID 保守分开。activity watermark 与首次页固定，后续更新不会让分页重复/漏掉既有 watermark 内会话。其余限制是200 raw records bounded scan 和 Telegram partial/unknown send at-least-once，不是相对 main 的承诺缺口。

## S4 最终自动化验收

- 最终源码快照的 `npm run test:rewrite` exit 0：`.test-results/parity-s4/rewrite-last.log`、`rewrite-last.exit`；包含 check、audit、format、clippy、完整 Rust/TS 与 IPC/浏览器/Telegram/process-loss 契约、GNU release/package/artifact smoke。Telegram 本地 Bot 合同 28 checks 通过，末项为完整 create→discover/model→queue→answer/stop/interrupt→restart→input/output/history→preview→cross-session sync 链路，无 Agent 重放。
- 最终源码快照 `npm run test:workbench:soak -- --duration-seconds 600` 通过：`.test-results/parity-s4/soak-last.log`、`soak-last.exit`，135 joined rounds / 601.3s。该 soak 是进程丢失/恢复循环，不等同于计划中的两小时 mixed soak 或 admission latency SLO。
- 最终补丁上 `cargo test ... telegram::runtime_tests::history_tests` 16 passed；`npm run check`、`npm run audit:workbench`、`npm run format:check` 和 `git diff --check` 通过。`rewrite-last.log` 为这些 grouping/activity/schema 变化的最终完整门禁证据；之前的 pre-schema hardening gate 有实际 Bot contract failed（history fragment与自动输出去重），失败日志保留在 `rewrite-verified2.log`，最终增加 per-fragment history-export receipt 后完成复验。
- 自动化功能出口已覆盖 S4 五项并完成。仍未做真实手机/在线 Bot、Pi/Codex/Claude live provider、Extension Host、musl Telegram binary contract、2小时 mixed soak、正式 admission-to-fence SLO；不把这些写成已验。其余协议安全/at-least-once 语义保持不变。
