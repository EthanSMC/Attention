# 微信对话升级 Bridge：实施计划

日期：2026-09-10。设计已收敛，代码任务均未开始。

依据：`docs/superpowers/specs/2026-09-10-bridge-wechat-update-consent-design.md`。
用户选择：通过微信对话升级，不新增网页审批，不把具体方案决策反复交回用户。
本计划不等于实际设备新增权限确认，不包含发布/部署/当前服务重启。

## 交付行为

1. 兼容更新沿用启动及每小时自动检查，空闲安全切换，正常成功不刷屏。
2. 需确认的更新由 Bridge 主动微信通知一次；用户也可发“检查更新”。
3. 回复包含版本、可解释的权限变化、一行可复制确认命令、过期时间。
4. 精确确认只授权展示过的候选；不将普通“好的”、引用、模型输出当授权。
5. 升级/失败/回滚结果回到同一 owner 的微信；OAuth 故障不阻断升级控制命令。
6. 最终验收分别证明实际运行版本、新业务会话、MCP 工具及真实摘要回写，互不冒充。

## 执行约束

- 每项先写失败用例、记录 RED，再实现和记录 GREEN，使用临时 home 和依赖注入。
- 先核验 Git HEAD/status；保留所有现有 `.codex/` 与 ` 2.*` 未跟踪文件，不批量 stage。
- 新建分支如有需要使用 `codex/` 前缀；提交按文件显式列举，不推送或发布。
- 测试不得读真实 token、调用真实模型/微信或启用 live-email；live 测试独立执行。
- 检查本地 Node/pnpm 和已锁定依赖，禁止为了测试自动重装依赖或读入 `.env.local`。
- 不修改原 manifest v2 或原 probe 输出形状；新增权限侧车保持向后兼容。
- 不引入 skip-consent、Shell 工具、自动放行未知权限或改写安全 fingerprint 的捷径。

## U1：可信权限说明和候选 offer

文件：新增 `apps/cli/src/channel/bridge-update-offer.ts` 与同名 `.test.ts`；
修改 `apps/cli/src/release-client.ts`、其测试、`scripts/sync-attention-cli-artifact.ts` 及现有产物校验测试。

- [ ] 定义严格权限侧车格式及有界解析；以实际编译常量生成侧车，固定顺序序列化后验证原有 SHA。
- [ ] 建立本地工具名 → 权限说明字典；未知/无法完整解释差异只给不可确认的原因，不运行候选。
- [ ] 定义 offer 身份：origin + 完整 manifest + 当前版本/权限 + owner 指纹。
- [ ] RED：同版本换包、权限 SHA 不符、侧车缺失/重定向/过大、未知字段/工具、Node 不兼容均拒绝。
- [ ] GREEN：兼容候选判定不变，已知受限工具变更可签发 offer；旧 manifest/probe fixture 仍能解析。

## U2：微信命令与授权日志

文件：新增 `bridge-update-control.ts`、`bridge-update-journal.ts` 及对应测试；
最小修改 `messages.ts`、`pipeline.ts`、`state.ts` 及测试。

- [ ] 定义无模型参与的完整命令匹配；确认只能来自 pin 后 owner 的一个顶层纯文本 item。
- [ ] 实现 6 位随机确认码、10 分钟 offer、3 次失败限制，以及取消、过期、重复消息消费。
- [ ] 日志独立版本、0700/0600、原子写；默认只保留最近 8 个已完成事件，不删除未投递结果。
- [ ] RED：非 owner、未 pin、引用/转发/语音、普通同意、旧口令、变更候选、重复投递均不授权。
- [ ] GREEN：同一操作最多批准一次；失败落盘不改变批准状态，不打印 owner、消息、确认码或 token。

## U3：独立控制路径和可靠通知

文件：修改 `channel-command.ts`、`queue.ts`、`limits.ts` 和相应测试；
可新增 `bridge-update-controller.ts` 封装调度，避免扩大主文件职责。

- [ ] 业务调用前处理升级命令；OAuth 不可用也可检查/确认/取消/看状态。
- [ ] 有界扫描整条持久化 inbox 的控制命令，保留业务 FIFO；覆盖控制命令位于第 6 条及之后。
- [ ] 检查更新单次并发，主动检查每 60 秒至多一次；`升级状态` 永不联网。
- [ ] 发现新 offer 产生稳定通知事件 ID，经既有 outbox 先落盘后发送；同一候选不按小时重发。
- [ ] 无有效 context token 等 owner 新消息；只有发送确认后才将通知标为已投递。
- [ ] RED/GREEN：发送中断、发送后落盘前崩溃、重新启动、重复检查、稍后与重新查询的区别。
- [ ] 扩充微信帮助和 CLI 状态输出，区分全局 CLI 与运行 Bridge；状态不泄漏内部会话或授权码。

## U4：下载、切换屏障与跨重启结果

文件：修改 `bridge-updater.ts`、`managed-bridge.ts`、`service.ts`、`channel-command.ts` 及测试。

- [ ] 发现与 stage 分离；确认后重新校验完整 manifest，实际 stage 仅接受绑定的批准能力。
- [ ] 保留 HTTPS/同源/禁止重定向/限长/Node/SHA/probe/原子选择；先确认再运行权限不同的候选。
- [ ] 引入 operation 所属的条件状态更新；旧失败处理不得覆盖另一操作的较新 current。
- [ ] 暂停业务执行；确认无活跃 turn/摘要恢复/发送、全部入站已持久化、outbox 已发送才切换。
- [ ] 已持久化且被 OAuth 阻塞的业务可留在队列中升级；新消息只排队，绝不伪装为已完成。
- [ ] 显式批准有效执行窗口 30 分钟；切换前取消/过期撤销，切换后不虚假承诺可取消。
- [ ] updater 状态与 journal 每个写入窗口设置 crash 注入；启动对账决定继续、失败或已切换。
- [ ] launcher/运行版/回滚版都支持结果协议和双向状态兼容时，投递成功或回滚回执。
- [ ] 新业务 session 身份实际建立后才说已重建；MCP OAuth 降级独立报告而不误判安装失败。
- [ ] RED/GREEN：校验拒绝、状态竞争、启动超时、回滚、失败版本隔离、保留 token/队列/历史/幂等记录。

## U5：候选打包及自动验证

文件：按实际变化同步 `apps/cli/package.json`、`apps/cli/src/version.ts`、公开 CLI/manifest/权限侧车；
更新 `docs/local-agent-wechat-device-acceptance.md`；增加隔离的端到端测试文件。

- [ ] 先核对可用 patch 号，不提前假定 0.3.17 必然未使用。
- [ ] 执行所有新增及受影响测试，然后执行 CLI 全量测试、CLI typecheck、范围 lint。
- [ ] 使用临时 home、受控发布响应、伪 iLink、真实 launcher 子进程完成升级/失败/回滚全链路。
- [ ] 受控测试不得连真实账号；候选损坏、篡改元数据、过期口令及旧版解析均有断言。
- [ ] 构建单文件产物并运行同步 check；版本、源码、manifest、权限 SHA 与安装字节一致。
- [ ] 跑 Web 的安装产物相关测试；若改 Web 运行代码，先读 `apps/web/AGENTS.md` 再增加相应验证。

命令参考（执行前检查依赖和测试配置，以下不是已经运行的结果）：

```sh
node node_modules/vitest/vitest.mjs run apps/cli/src --maxWorkers=2
pnpm --filter @attention/cli typecheck
pnpm cli-artifact:sync
pnpm cli-artifact:check
pnpm agent-installations:check
pnpm capabilities:check
```

pnpm 不可用时用已安装 Node/工具执行等价命令并记录实际调用，不自动下载另一套环境。

## U6：真机验收及交付边界

- [ ] 单独获准交付候选、首次安装和对应新增权限后，才修改当前 Mac 后台服务。
- [ ] 0.3.15 需一次公开安装路径引导并刷新 launcher；不能以旧版不会发的新协议消息验收失败回滚。
- [ ] 在支持闭环的基线设备上接收真实更新提示，发送确认，收到真实升级结果。
- [ ] 验证实际进程产物 SHA、运行版本、第一条业务消息的新 session、真实 MCP 工具结果。
- [ ] 验证普通问题不触发升级、旧确认码失效、断网恢复后消息仍在、OAuth 降级仍可对话控制。
- [ ] 对既有公众号源安全拒绝如实停止；小红书可读样本须完成真实 enrichment，复查 Core 和 Web。
- [ ] 无法操控微信 UI 时请用户代发单条准确测试消息，继续观察真实桥接日志；不得注入伪队列冒充真机。
- [ ] 仅在上述结果都有证据后宣布功能验收；未发布或未装入真实设备时明确标注状态。

## 完成标准

代码 GREEN、候选兼容、受控生命周期通过是“本地实现完成”。
真实微信通知/确认/升级/回滚及业务会话验证是“设备闭环验收完成”。
摘要写入是另外的业务验收，不以任一前序成功替代。三种结果分别汇报。
