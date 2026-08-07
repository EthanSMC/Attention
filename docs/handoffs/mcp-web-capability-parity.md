# Web 与 MCP 能力等价交接

状态：代码审计基线，持续维护

更新日期：2026-08-07

## 1. 当前产品边界

第一期不提供 Hosted Agent，也不在 Web 展示托管 Channel 或本地微信连接面板。用户自己的 Agent 通过 Attention Skill + Hosted MCP 使用业务能力；本地 Agent / iLink 的安装、心跳和绑定证明属于独立的 Channel Runtime 控制面，不属于 MCP 业务工具。

因此，“Web 与 MCP 等价”特指：**同一账号、同一项适合由 Agent 执行的 Attention 业务动作，必须经过相同的 Core service、实时权益和可见性规则。** 它不表示浏览器 Session、OAuth 授权仪式、付款确认或凭据签发也要伪装成 MCP 工具。

有效能力始终是：

```text
账号实时权益（Free / Member / Filter）
∩ credential 的 resource audience
∩ OAuth consent scope 或 API Key 的存量 scope 上限
∩ 该动作允许的安全边界
```

MCP 不能绕过公开流预览上限、Member 检查、Filter 公开资格、内容安全状态或账号所有权。

## 2. 当前 MCP Tool Registry

公开 Tool Contract 为 `1.3.0`，当前共 14 个工具。Skill `1.3.0` 与它绑定；服务端继续接受旧 Skill `1.0.0`、`1.1.0` 和 `1.2.0` 的 `client_context` 以兼容已安装客户端，但旧版本不会声明新增工具：

| Tool | Scope | 实时权益 | 对应 Web / Core | 状态 |
|---|---|---|---|---|
| `attention_get_my_account` | `profile:read` | 登录账号 | `loadAccountOverview` + Principal capability | 已对齐；只返回展示名、Attention ID、是否有头像和实时 Member/Filter，不返回邮箱、密码状态、Session 或内部账号 ID |
| `attention_get_membership_status` | `subscription:read` | 登录账号 | `loadCurrentSubscription` + Principal capability | 已对齐只读状态；不会开始、修改或取消付费 |
| `attention_list_collections` | `collection:read` | Free 可用 | `/account` 使用的 `loadMyCollections` | 已对齐；返回标题、作者、来源、标签、摘要与摘要状态、发布时间、署名、原文路由、原始及有效可见性 |
| `attention_collect_content` | `collection:write` | Free 可私密；公开需 Filter | `/api/v1/collection-attempts` / `collectFromWeb` | 已对齐；强制幂等键，候选与处理状态不在入口内猜测 |
| `attention_select_collection_candidate` | `collection:write` | Free 可私密；公开需 Filter | `/api/v1/collection-attempts/select` / `selectCandidateFromWeb` | 已对齐；一次性 token，非幂等 |
| `attention_get_collection_status` | `collection:read` | Free 可用 | `getCollectionStatus` | 已对齐；仅查询当前账号的 attempt / collection |
| `attention_update_collection` | `collection:write` | 改私密可用；公开需 Filter | 可见性 Web API / `updateCollectionVisibility` | 已对齐；每次重新检查 Filter 与内容有效状态 |
| `attention_list_public_content` | `public:read`，完整流还需 `public:full` | Free 仅服务器配置的前 N 张；Member 才能完整读取 | `/ai` / `loadPublicContents` | 已对齐；返回标签、摘要状态、发布时间和全部 Filter 署名；`public:full` 单独存在不能绕过 Member |
| `attention_search_content` | `ai:search` | Member / Filter | `/api/agent/query` / `retrieveForAgent` | Core 已对齐；只有实时 Member 且有 scope 时才出现在工具列表中 |
| `attention_report_content` | `moderation:write` | 登录账号 | `/api/moderation/reports` / `reportPublicContent` | 已对齐；复用公开可举报状态、同账号幂等、Filter 开案限流和社区阈值 |
| `attention_list_moderation_cases` | `moderation:court:read` | 当前有效 Filter | `/account/court` / `listModerationCourtCases` | 已对齐；只读返回当前案件、票数、本人投票、截止时间与受保护原文路由 |
| `attention_cast_moderation_vote` | `moderation:court:vote` | 当前有效 Filter | cases vote API / `castModerationVote` | 受控对齐；必须逐案逐决定获得用户明确确认并传 `explicit_confirmation: true`，同票重试幂等、改票和过期轮次拒绝 |
| `attention_get_digest_settings` | `digest:read` | 登录账号 | `/api/account/digests` / `loadDigestSettings` | 已对齐；返回可用领域、当前配置和实时资格，不会修改订阅 |
| `attention_update_digest_settings` | `digest:write` | Member / Filter | `/api/account/digests` / `updateDigestSettings` | 已对齐；复用领域、时区、时间窗与实时权益校验 |

上述账号与会员只读工具补上了原先已经可授权、却没有 Tool 的 `profile:read` 和 `subscription:read`。邮箱等非必要私密资料没有因为“Web 能看见”而自动扩大到 Agent。

MCP 失败结果保留稳定的 `code / guidance / request_id`，并按需附加机器可执行的 `required_scope`、`required_entitlement` 和 `retry_after_seconds`。`required_entitlement` 当前取值为 `member`、`filter` 或 `member_or_filter`；举报开案限流会把 Core 计算出的等待秒数直接传给客户端。以上均为 `1.3.0` 合同的向后兼容可选字段。

## 3. Web 能力矩阵

| 业务能力 | Web 状态 | MCP / 其他协议状态 | 结论 |
|---|---|---|---|
| 浏览公开发现流 | 游客、Free、Member 均有；游客/Free 前 N 张 | MCP 需要账号 credential；Free 同样前 N 张，Member + `public:full` 完整读取 | 已对齐账号能力；不提供匿名 MCP 是明确边界，不是遗漏 |
| 查看自己的收藏 | `/account` | `attention_list_collections` | 已对齐 |
| 收藏链接、分享文本、候选确认、查询处理进度 | Web 收藏模块和 v1 API | collect / select / status 三个工具 | 已对齐 |
| 修改公开 / 私密 | Web 卡片开关 | `attention_update_collection` | 已对齐；只有 Filter 可公开 |
| AI 检索与引用 | Web API 保留，Web Agent 页面不作为第一期主入口 | `attention_search_content` | Core 已对齐；第一期由用户自己的 Agent 使用 |
| 查看公开身份与实时角色 | 个人页和设置页 | `attention_get_my_account` | 已对齐必要字段 |
| 查看会员与订阅状态 | 设置页 | `attention_get_membership_status` | 已对齐只读字段；付费确认仍是 Web-only |
| 举报公开内容 | 公开卡片 + `/api/moderation/reports` | `attention_report_content` | 已对齐；Agent 不得自行发起举报，Skill 要求用户明确提出 |
| 日报订阅和时间设置 | `/account/digests` + account API | digest 读取、更新工具 | 已对齐；更新前读取当前配置，避免覆盖未要求变更的字段 |
| Filter 小法庭案件列表 | `/account/court` + cases API | `attention_list_moderation_cases` | 已对齐；仅当前有效 Filter 且持有 court read scope 可见 |
| Filter 小法庭投票 | Web 显式点击，一人一票 | `attention_cast_moderation_vote` | 受控对齐；参数强制显式确认，Skill 禁止模型自行判断或把旧确认转移到另一案件/轮次 |
| 修改展示名、头像、Attention ID | 账号设置 | 无 MCP 工具 | 暂定 Web-only；Attention ID 有 365 天冷却，头像是大体积二进制，不能盲目加入默认 scope |
| 邀请、Filter 年卡、兑换与积分 | 账号设置 + growth API | 无 MCP 工具 | 暂定 Web-only；包含一次性 secret 和权益变更，不属于第一批基础工具 |
| 创建 / 撤销 API Key，查看 / 撤销 OAuth 连接 | 连接与授权页 | 无 MCP 工具 | Web-only 安全控制面；禁止 PAT 或普通 MCP token 再签发凭据 |
| 开始付费订阅 | Web 二次确认 + billing provider | 无 MCP 工具 | Web-only；必须由真人确认金额、扣费时间和自动续费 |
| 登录、验证码、密码、退出 | Web 登录模块和安全设置 | 无 MCP 工具 | Web-only 身份仪式 |
| 删除收藏 | Web 尚无产品入口；同步协议已有 delete mutation | MCP 无删除工具 | 不是当前 Web/MCP 漂移；产品语义确定后两端一起补 |
| 本地历史同步与离线冲突 | 无普通 Web 入口 | 独立 `/api/sync`，不是 MCP Tool | 协议分层正确；首次历史导入强制私密 |
| Agent 安装、心跳、iLink 绑定证明 | 第一版无前端入口 | 独立 Runtime OAuth + `/api/runtime` 控制面（实现中） | 不应混入 Attention 业务 MCP；也不恢复 Hosted Channel UI |

## 4. Credential、audience 与 scope 真相源

### 4.1 OAuth resource audience

| Audience | 默认 resource | 支持 scope | 401 challenge 的默认 scope | PAT |
|---|---|---|---|---|
| `attention-mcp` | `${origin}/mcp` | `profile:read`, `collection:read`, `collection:write`, `digest:read`, `digest:write`, `moderation:write`, `moderation:court:read`, `moderation:court:vote`, `public:read`, `public:full`, `ai:search`, `subscription:read` | 同左 | 允许 |
| `attention-sync` | `${origin}/api/sync` | `sync:read`, `sync:write` | 同左 | 允许 |
| `attention-channel-runtime` | `${origin}/api/runtime` | `runtime:register`, `runtime:heartbeat`, `channel:bind:report`, `channel:disconnect:report` | 必须是完整的四项集合 | **拒绝** |

OAuth authorization code、refresh token 和 access token 都绑定 audience；MCP、Sync 与 Runtime token 不能交叉使用。Runtime scope 不能与普通 MCP / Sync scope 混合，API Key 也不能调用 Runtime。

`oauthScopesByAudience` 是受保护资源的完整能力真相源。MCP 的首次连接 challenge 请求完整 MCP scope 集合，确保公开 Tool Contract 中的工具在完成授权后可实际调用；工具发现仍按 token scope 和实时权益过滤。动态注册不传 scope 时得到完整 MCP + Sync scope 上限，但不会得到 Runtime scope。

### 4.2 API Key

新 API Key 获得固定的 legacy 协议 scope 集合，实际动作仍每次解析账号的实时 Member / Filter capability。历史上已经签发的较窄 Key 保留其存量 scope 上限，必须由用户轮换才能扩大；Key 类型之间没有“高级 Key”。

API Key 可用于 MCP 和 Sync，不能用于 Runtime，也不能通过 MCP 再创建 API Key。

## 5. 仍需完成的基础设施缺口

以下是代码审计后仍然真实存在、且与第一期基础设施直接相关的缺口：

1. **为各 Tool 声明 output schema**：结构化成功结果和失败元数据已有测试覆盖，但工具发现尚未发布机器可检查的 output schema。
2. **机器可检查的 capability manifest**：Agent 安装清单已经机器可检查，但 Web/MCP 业务能力仍靠本文件和分散测试维护。CI 需要同时校验 Web adapter、MCP Tool、scope、实时 entitlement、稳定错误、审计事件与 Web-only 理由，防止后续再次漂移。
3. **共享 Core adapter 测试**：同一 fixture 应分别通过 Web adapter 与 MCP Registry 调用，断言权限、可见性和稳定错误一致，而不只验证各自的 route 单测。

已经补齐、不要再列为缺口的基础设施：

- `/mcp` 使用数据库桶按账号、credential 与客户端指纹做分布式限流；失败时 fail closed，响应包含稳定的 `429 / Retry-After`，额度存储受账号 RLS 约束。
- `attention_search_content` 的成功公开引用由服务端写入内容级 `mcp_retrieval` 事件；事件使用稳定去重键，客户端不能自行申报贡献。
- `agent.tool_call.v1` 继续记录隐私最小化的工具审计；两类事件均不保存 OAuth token、API Key 或用户查询正文。

收藏、公开流和 AI 检索中的 `/out/...` 引用现在由 MCP Registry 基于当前受信任服务 origin 转成绝对 URL；浏览器 Web 仍继续使用相对路由。

Runtime API、五类 Agent 安装描述和 iLink 绑定数据模型属于并行的本地 Agent 基础设施工作；它们是否完成不能用本文件里的 14 个业务 Tool 代替验收。

## 6. 明确不应做成普通 MCP Tool 的动作

- 邮箱注册、验证码登录、设置或重置密码、退出当前浏览器 Session；
- OAuth consent、动态客户端注册和 token 交换；
- 创建、轮换或显示 API Key 原文；
- 支付、退款、自动续费确认；
- 未经用户明确确认的小法庭投票；
- 纯 UI 偏好，例如卡片 / 列表显示方式；
- 本地 iLink token、二维码、消息正文或浏览器凭据上传到 Attention。

“Web-only”只适用于上述身份、安全、支付和 UI 控制面。不能用这个标签掩盖举报、日报等本来适合 Agent 执行的业务缺口。

## 7. 防漂移验收

后续 capability manifest 每项至少登记：

```text
capability
web_adapter
mcp_tool_or_protocol
scope
entitlement
stable_errors
audit_event
intentional_web_only_reason
```

CI 最少验证：

- Web 新增适合 Agent 执行的业务动作时，MCP 或独立协议状态不能留空；
- Tool Registry、公开 Skill、README 数量和工具名完全一致；
- PRM 的 `scopes_supported` 来自 audience 完整范围，401 challenge 来自其默认子集；
- PAT 永远不能进入 Runtime，跨 audience OAuth token 永远失败；
- Free、Member、Filter fixtures 在 Web / MCP 上得到相同的公开流上限、AI 可见性和 Filter 公开规则；
- Web-only 例外必须有具体安全理由，不接受“尚未实现”。

在 Tool output schema、机器可检查的业务 capability manifest 和共享 Core adapter fixture 完成前，不应对外宣称“Web 与 MCP 完全等价”。
