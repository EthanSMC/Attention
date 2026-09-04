# Attention 摘要自动重试体验设计

日期：2026-09-04
状态：方案方向已批准，待文档审阅

## 1. 结果

当本地 Agent 已成功收藏内容、但本轮未能补全摘要时，Attention 微信桥必须明确说明本次结果，而不能把数据库的 `pending` 状态描述成仍有任务正在后台执行。Bridge 随后在本地持久化一个最小重试任务，按 2 分钟、10 分钟、30 分钟的退避节奏自动重试；中间失败保持静默，成功沿用现有摘要完成通知，三次均失败后主动说明已暂停且可手动重试。

收藏和补全结果不再统一替换成固定句式。Agent 可以根据本轮真实工具结果自然组织状态说明，但 Bridge 仍执行严格的输出安全检查；不安全、空白或无法验证的文本才降级为不含内容信息的安全兜底文案。

本设计只增强本地 Bridge。它不引入 Hosted Agent，不增加服务端任务队列，不改变 Content/Collection 所有权模型，也不把微信文章的上游公开读取限制伪装成本地故障。

## 2. 已确认的产品行为

1. `summary_status=pending` 只表示共享 Content 尚无摘要，不表示后台任务正在运行。
2. 首版 Hosted AI 仍不是依赖；服务端不会因为摘要 pending 自动创建 Hosted AI 任务。
3. 初次补全失败后，自动重试间隔依次为 2 分钟、10 分钟、30 分钟，共三次。
4. 首次失败立即回复，说明本次没有补全成功以及已安排下一次重试。
5. 前两次自动重试失败不发微信消息；第三次仍失败时通知已暂停。
6. 自动重试成功时，通过现有摘要完成通知通道发送一次通知，不再由重试调度器重复发送第二条成功消息。
7. 用户在等待期间主动要求补摘要时，立即执行一次人工触发的尝试，不必等待计时器。
8. 人工触发失败不消耗自动重试次数，也不推迟已经安排的下一次自动重试；成功则取消任务。
9. 一个已暂停任务被用户再次主动触发后，若仍符合 `generate_summary`，开启一轮新的三次自动重试周期。
10. MCP OAuth、MCP 不可达、Codex/Claude Runtime 重启或升级不消耗摘要重试次数；依赖恢复后继续。
11. 微信/iLink 登录、收发消息或手机网络异常仍作为独立上游问题报告。

## 3. 方案选择

### 3.1 Bridge 持久化重试队列——采用

Bridge 已拥有 0600 权限的本地状态、串行消息管线、常驻宿主 Runtime 和摘要完成通知轮询。把重试任务放入同一状态机，可以跨 Bridge 重启和 CLI 自动升级恢复，同时避免新增服务端调度基础设施。

### 3.2 让单次 Agent turn 等待——不采用

长时间占用一次 turn 会浪费 Runtime 资源，且进程重启、会话恢复或 CLI 更新会丢失定时器。它也无法可靠区分依赖故障与摘要来源失败。

### 3.3 服务端任务队列或 Hosted Agent——本次不采用

该方案需要任务租约、设备选择、并发控制和 Hosted Agent 权限设计，明显超出本次体验修复范围。未来接入 Hosted Agent 时，可以消费同一服务端 `enrichment_action`，但不能与本地任务重复提交或重复通知。

## 4. 本地状态模型

在 `ChannelState` 中新增 `summaryRetries`，每项只保存：

```ts
interface SummaryRetryJob {
  collectionId: string;
  cycleStartedAt: string;
  nextAttemptAt: string | null;
  automaticAttempts: 0 | 1 | 2 | 3;
  status: "scheduled" | "running" | "paused";
  lastFailureClass: "enrichment_incomplete" | null;
}
```

- `collectionId` 是 owner-scoped 的不透明 UUID，也是队列去重键。
- 不持久化 `public_read_url`、原始分享文本、标题、正文、摘要、标签、Cookie、OAuth 数据或宿主会话输出。
- `nextAttemptAt` 使用 ISO 时间；`running` 在进程重启后规范化回可重试的 `scheduled`，避免永久卡死。
- 队列最多保留 32 个活动或暂停任务。超限时仅移除最早的 `paused` 项；没有可安全移除的项时，新任务不入队，并由当前回复说明无法安排自动重试。
- 旧状态缺少 `summaryRetries` 时迁移为空数组；无效、重复、未知字段或非法时间的任务在加载时丢弃，不影响微信登录态和普通消息。

## 5. 结构化结果与 AI 回复

### 5.1 Bridge 控制信号

现有 `CollectionReplyControl` 继续从 Attention MCP 结果提取不含正文的权威控制信号，但为 `generate_summary` 增加临时的 `collectionId`。它仍不保留 URL、标题、摘要或标签。

Bridge 区分以下结果：

- `completed`：补全提交返回 `enriched` 或 `already_enriched`；取消同一 Collection 的重试任务。
- `retryable_incomplete`：服务端仍要求 `generate_summary`，本轮 turn 正常结束但没有成功提交；创建或保留重试任务。
- `ready`：服务端返回 `reuse_summary/ready`；取消任务。
- `terminal`：隐藏、不可用、不安全、已删除或不再属于当前账号；取消任务，不再重试。
- `dependency_failure`：Attention MCP 或宿主 Runtime 不健康；保留任务且不增加自动尝试次数。

### 5.2 自然语言回复

Agent 的最终文本不再因为存在 Collection 控制信号而无条件替换。系统提示要求 Agent：

- 只说明收藏是否成功、摘要本轮是否完成、失败类别、是否已安排重试及大致等待时间；
- 明确 `pending` 不等于后台正在生成；
- 不回显原始 URL、标题、正文、摘要、标签、Content/Collection ID、工具名、工具参数或认证信息；
- 自动重试的中间失败不生成用户回复；
- 第三次失败说明自动重试已暂停，用户可以再次要求重试。

Bridge 对候选回复做本地安全检查。以下任一情况触发安全兜底：

- 空文本或超过微信回复上限；
- 出现 HTTP(S) URL、邮箱、UUID、代码块、JSON/工具调用形态或 `mcp__`/Attention 工具名；
- 出现明显的正文转录、标签列表或“标题/正文/摘要内容如下”式内容载荷；
- 回复与本轮 MCP 结果中的敏感字符串片段直接重合。

安全检查只在内存中比较本轮结果，比较材料不会写入日志或 `ChannelState`。兜底文本按权威状态生成，但只在 AI 文本不安全或不可用时使用。日志只记录稳定原因码，例如 `reply_contains_url`，不记录被拒绝的文本。

## 6. 调度与数据流

### 6.1 初次收藏或人工补全

```text
用户消息
  → Agent 调用 collect/status
  → 服务端返回 generate_summary + public_read_url
  → Agent 尝试公开读取并提交 enrichment
  → 成功：取消任务，返回安全的 AI 回复
  → 未成功：创建/保留 collectionId 重试任务，返回安全的 AI 回复
```

第一次未成功时，任务写入状态后才确认本轮消息完成，保证崩溃后不会出现“已安排”但任务不存在。首个 `nextAttemptAt` 为当前时间加 2 分钟。

### 6.2 自动重试

Bridge 主循环在以下条件全部满足时取一个到期任务：

- 没有待处理入站消息和待发送回执；
- Attention MCP 与宿主 Runtime 健康；
- 微信登录态存在；
- 没有另一个摘要任务正在执行。

自动 turn 只收到 `collectionId`、稳定 retry reference、当前自动尝试序号和安全策略。Agent 必须先调用 `attention_get_collection_status(collection_id)`，只能使用该次结果返回的 `public_read_url`，然后按既有流程读取和提交。

每次自动尝试开始前原子写入 `running`；完成后：

- 成功或已经 ready：移除任务；成功通知交给现有摘要通知游标处理。
- 可重试未完成：增加 `automaticAttempts`，下一次分别安排在本次结束后 10 分钟或 30 分钟。
- 第三次未完成：改为 `paused`、清空 `nextAttemptAt`，将一条安全的最终失败说明加入现有 `pendingOutbound`，确保发送失败可重试。
- 依赖故障：恢复为 `scheduled`，保留次数，并按现有 Runtime/MCP 恢复时间重新唤醒，避免紧密循环。

入站消息优先于自动任务。一次只运行一个 Agent turn，避免与用户消息、CLI 升级重启或另一补全任务争用同一 resident session。

### 6.3 人工重试与竞态

- 活动任务存在时，用户主动要求补全会立即运行；失败不改变自动任务的次数和时间，成功移除任务。
- 人工尝试和自动任务不会并发；先获得 Bridge 串行执行权的一方运行，另一方在开始前重新检查任务和服务端状态。
- 暂停任务经人工触发后，若服务端仍返回 `generate_summary` 且人工尝试未成功，则重置为 `automaticAttempts=0`，从 2 分钟开始新周期。
- `already_enriched` 与 `ready` 都视为成功，防止多个设备或未来 Hosted Agent 并发时重复写入。

## 7. 错误处理与诚实状态

- 公开页面无法读取、证据不足，或 Agent 正常结束但没有成功提交：统一归类为 `enrichment_incomplete`，进入有限重试；Bridge 不根据缺失的工具事件猜测更具体的原因。
- Agent 可在当轮自然回复中说明它实际观察到的失败原因，但持久化状态和日志只写稳定原因码，不保存页面内容或模型文本。
- MCP 授权/网络/协议故障：交给现有 MCP Recovery Supervisor，摘要任务不计次。
- Runtime 崩溃、turn 超时或升级重启：交给现有 Runtime 恢复，摘要任务不计次。
- Collection 已删除、隐藏、不安全、终态不可用或失去所有权：取消任务并给出 AI 组织的简短终态说明。
- iLink 发送失败：回复进入现有 `pendingOutbound`，不重复运行摘要任务。
- Bridge 停机期间错过时间：下次启动并恢复健康后立即处理已到期任务，不并行追赶多个任务。

## 8. 通知策略

1. 首次失败：当前对话立即收到 AI 组织的说明，包含本次未成功和约 2 分钟后自动重试。
2. 第一次、第二次自动失败：静默，仅更新本地任务状态。
3. 自动或人工成功：沿用 `channel:notifications:read` 的摘要完成通知作为唯一主动成功消息，避免双发。
4. 第三次自动失败：通过 `pendingOutbound` 主动通知“本轮自动重试已暂停，可再次要求重试”，具体文本由无内容上下文的安全 AI 回复生成；生成失败则使用兜底。
5. 用户询问“在做了吗”：Agent 必须根据本地任务状态回答是等待、正在执行、已暂停还是已完成，不再仅复述 `summary_status=pending`。

## 9. 版本与兼容性

- 这是 CLI/Bridge 行为和本地状态结构变更，发布时将 CLI 版本提升到下一个 patch（当前基线 0.3.14，即 0.3.15）。
- 不改变现有 MCP 输入输出协议、OAuth scope 或权限摘要；自动 turn 仍只使用已允许的 Attention MCP 和最小公开网页读取能力。
- 同步版本化 CLI 安装产物摘要、manifest、公共 Skill/安装说明中与重试体验有关的文字。
- 0.3.14 状态可被 0.3.15 直接加载。若用户回退到旧版本，新增字段被旧加载器忽略；微信登录态、队列和会话信息不受影响。
- 实施与验证不自动授权推送、发布或部署；这些操作需要单独确认。

## 10. 测试与验收

### 10.1 单元与状态测试

- `ChannelState` 缺字段升级、非法任务丢弃、`running` 崩溃恢复、队列上限和暂停项淘汰。
- 2/10/30 分钟调度、自动次数、依赖故障不计次、人工失败不改计划、人工成功取消、暂停后新周期。
- Collection 控制信号只保留 `collectionId` 和状态，不持久化 URL/标题/正文/摘要/标签。
- AI 回复安全检查接受自然状态文本，拒绝 URL、UUID、工具调用、内容载荷和本轮敏感片段；每个拒绝原因都有稳定代码和安全兜底。

### 10.2 Pipeline 与宿主对等

- Codex 与 Claude Code 均覆盖首次失败入队、自动 status → read → submit、`already_enriched`、终态取消和第三次暂停。
- 自动 turn 不进入用户聊天历史，不伪造成用户消息，不改变 owner pinning。
- 普通对话和非摘要收藏回复继续由 Agent 自然生成；已有 reset/retry/status 控制命令不回归。
- 恶意模型文本不能泄露 URL、正文、标题、摘要、标签、ID 或工具参数。

### 10.3 通知与恢复

- 成功只发送一次现有摘要完成通知。
- 最终暂停通知写入 `pendingOutbound`，发送失败后可恢复且不会重跑摘要。
- Bridge、Codex Runtime、MCP OAuth 和 CLI 自动升级分别在任务 scheduled/running 时中断，重启后任务不丢失、不重复计次。
- 多任务到期时串行处理且入站消息优先。

### 10.4 发布前验证

- 运行所有 CLI channel focused tests、类型检查、lint、构建、CLI artifact/installation/capability 一致性检查。
- 运行完整测试集，并保留任何环境性失败的独立复现证据。
- 在本地真实 Bridge 上用一个公开可读页面和一个微信不可公开读取页面验收：前者成功且只通知一次；后者按 2/10/30 分钟重试、不中途骚扰、最终诚实暂停。
- 检查服务日志和本地状态，确认没有 URL、页面正文、摘要、标签、OAuth token 或宿主会话内容被新增到日志或重试任务。

## 11. 非目标

- 不实现 Hosted Agent、服务端设备派发、任务租约或跨设备任务转移。
- 不承诺微信、iLink 或内容平台上游页面一定可公开读取。
- 不把摘要 `pending` 自动改成终态 `unavailable`。
- 不允许无限重试、批量补全或多个 Agent turn 并发。
- 不新增用户侧设置页、重试次数配置或管理员控制项。
