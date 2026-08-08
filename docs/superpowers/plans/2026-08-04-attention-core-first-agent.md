# Attention Core-first Agent 实施计划

依据：`docs/superpowers/specs/2026-08-04-attention-core-first-agent-roadmap-design.md`

状态：已完成

> 当前第一版范围以 [`docs/first-release-scope.md`](../../first-release-scope.md) 为准。本计划已完成 Core/MCP/Skill 抽取；它不包含官方 Hosted Agent、Hosted Channel 或 Attention 托管 Browser。第一期的 Agent 指用户自己的 Agent，接入入口与五类宿主文档见 `/doc`。

## 目标

将现有 Hosted MCP 从 Route 内联工具重构为可供未来 Hosted Agent 复用的 Canonical Attention Tool Registry，补齐第一阶段 Filter/第三方 Agent 所需的状态查询和可见性修改，完善公开 Skill，并建立不保存原文的最小工具遥测。

本计划不实现 Hosted Agent、企业微信客服、Fetcher/Browser Agent Tool 或通用浏览器能力。

## 基线

- `pnpm test`：42 个测试文件通过、1 个跳过；235 项通过、50 项跳过。
- `pnpm typecheck`：全仓通过。
- 当前 MCP 有 5 个工具，定义内联在 `apps/web/src/app/mcp/route.ts`。
- 当前公开 Skill 仅覆盖收藏、列表和搜索。
- 数据库已存在 `event_ledger`，但 Web Runtime 尚无 INSERT 权限。

## Task 1：锁定并抽取 Canonical Tool Registry

新增：

- `apps/web/src/server/attention-tool-registry.ts`
- `apps/web/src/server/mcp-tool-adapter.ts`
- 对应单元测试

修改：

- `apps/web/src/app/mcp/route.ts`
- `apps/web/src/server/cloud-credentials.ts`

要求：

1. 等价迁移现有 5 个工具的名称、Schema、annotations、可见性、scope 和结果语义。
2. Registry 不依赖 MCP SDK、Next.js、OAuth Request、CORS 或全局 `getWebDatabase()`。
3. MCP Adapter 只负责 SDK 注册和协议结果编码。
4. Tool Context 的账号、权益和 scope 只能来自可信 Principal。
5. 保持请求体上限、401、WWW-Authenticate、CORS 与 Streamable HTTP 行为不变。
6. `attention_search_content` 继续只对实时 Member + `ai:search` 可发现。

验证：

- Registry 工具集合与现有行为一致。
- Strict Schema 拒绝客户端提交 `account_id`、角色、scope。
- MCP 成功结果继续同时返回 text JSON 与 structured content。
- 现有请求体限制测试不回归。

## Task 2：补齐 Core 状态与可见性用例

新增：

- `apps/web/src/server/collection-status-service.ts`
- 状态服务测试

新增工具：

- `attention_get_collection_status`
- `attention_update_collection`

要求：

1. Status 输入必须二选一：`attempt_id` 或 `collection_id`。
2. 所有查询显式绑定可信 `account_id`，跨账号统一返回 not found。
3. 返回 Attempt、Collection、Content 的正交状态，不把处理状态压成单一布尔值。
4. 返回 `next_action` 与有限 `retry_after_seconds`，供 Skill 决定等待、重试或候选选择。
5. Update 复用 `setCollectionVisibility`，实时重验 Filter，保持同值幂等与事件记录。
6. 返回 `/out/mine/:collection_id` 作为 citation route，不直接泄漏持久化 outbound URL。

稳定错误至少包括：

- `insufficient_scope`
- `attempt_not_found`
- `collection_not_found`
- `collection_deleted`
- `filter_required`
- `invalid_request`
- `internal_error`

## Task 3：修正现有工具合同

1. `attention_collect_content` 的 `idempotency_key` 改为必填；Skill 为一次工作流生成稳定 UUID，重试复用。
2. `attention_select_collection_candidate` 标记为非幂等，保持一次性 Token 语义。
3. Collection/Selection 的已知领域错误映射成稳定工具错误，不再全部折叠。
4. List/Search/Public 返回 citation route，并补充必要的处理状态字段；不在本轮重写搜索算法。
5. Fetcher 暂时不可用时，只对可由平台 Adapter 结构化确认身份的直接内容链接创建部分处理收藏；通用网页、短链、危险地址和无法确认目标的链接仍保持 pending/unsafe，不降低安全边界。

## Task 4：最小工具遥测

复用 `event_ledger` 记录 `agent.tool_call.v1`：

- Registry/Tool Contract 版本；
- 入口、credential kind、OAuth client ID 或 PAT credential ID；
- 客户端自报的固定 Skill ID/version 与 HMAC workflow fingerprint；
- 工具名、耗时、outcome、稳定 error code；
- 必要的 attempt/collection/result status 标识。

明确禁止记录：

- Token、Cookie、Authorization Header；
- Tool 原始参数与完整结果；
- 分享文本、query、URL、标题、摘要、HTML 或网页正文；
- selection token 与 idempotency key。

数据库新增 Web Runtime 对 `event_ledger` 的 INSERT 权限和账户级 RLS，只允许当前账户写固定事件 envelope；遥测通过响应后任务调度，缺少有效 HMAC secret 时不记录 workflow fingerprint，写入失败不得改变或延迟工具业务结果。

## Task 5：公开 Skill 与合同一致性

更新 `apps/web/public/skills/attention/SKILL.md`：

- 标注 Skill 与 Tool Contract 版本；
- 收藏使用稳定 idempotency key；
- ambiguous 后展示候选并调用 select；
- 通过 status 等待异步处理，最多自动重试 2 次；
- 通过 update 修改可见性；
- 第三方 Agent 使用自身 Browser/Search；
- 没有浏览器或网页读取失败时仍可收藏原始 URL；
- 不提交整页正文作为 Attention 的可信证据；
- 对 scope、Member、Filter、unsafe、invalid、pending 给出明确动作。

新增一致性测试：

- Skill 中出现的 `attention_*` 工具全部存在于 Registry；
- 必需工具全部被 Skill 提及；
- Skill 与 Tool Contract 版本一致；
- Skill 不包含 Token、Fetcher/Browser 私有工具或提交原文指令。

## Task 6：集成验证

必须执行：

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm --filter @attention/web build
```

如果本地提供 `TEST_DATABASE_URL`，同时执行数据库集成测试；没有数据库时明确报告未执行项，不伪装为通过。

重点回归：

- OAuth/PAT Principal 与实时权益；
- Free/Member/Filter 工具集合；
- 收藏幂等与多候选一次性选择；
- 状态查询的账号隔离；
- 可见性更新与 Filter 撤销；
- 请求体限制与错误编码；
- 遥测隐私 canary；
- Skill/Registry 一致性。

## 明确后移

- Hosted Agent Tool Loop；
- 企业微信客服；
- Runtime `web.read_public`；
- Browser Worker 与 Sufficiency；
- Hermes/其他开源 Runtime 选型；
- 遥测 Dashboard、分析仓库与自动 Skill 分发。

## 实施结果

- Canonical Registry 已包含 7 个 Tool Contract `1.0.0` 工具，MCP Adapter 只负责 list/call 协议投影；未来 Hosted Agent 可使用同一 Registry。
- `attention_get_collection_status` 与 `attention_update_collection` 已接入 owner scope、实时 Filter 检查和稳定错误。
- 收藏幂等键改为必填，候选选择标记为非幂等；Malformed MCP 参数也统一进入 Registry 的 `invalid_request` 路径。
- 结构化平台直链支持安全降级；`generic_web`、短链、敏感参数、非标准端口和危险地址不会在 Fetcher 故障时被错误公开。
- 工具遥测使用 allowlist、响应后调度、HMAC workflow fingerprint 与 `event_ledger` RLS；不保存 Tool 原始参数或结果。
- Public Skill、Registry 名称与 Tool Contract 版本由自动测试保持一致。
- 本地验证已运行全仓测试、类型检查、Lint 和 Web 生产构建。`TEST_DATABASE_URL` 未配置，因此数据库 runtime/RLS 集成测试由 CI 执行，本地不伪装为通过。
