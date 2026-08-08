# Attention 账号体系首版交接

更新时间：2026-08-07

权威产品规格：[`第一版范围`](../first-release-scope.md)；账号与增长细节见 [`2026-08-04-attention-identity-membership-growth-design.md`](../superpowers/specs/2026-08-04-attention-identity-membership-growth-design.md)

## 1. 已实现范围

- Guest、注册 Member、历史/显式撤销后的兼容 Free、Filter 的实时服务端能力解析。
- 邮箱验证码统一注册/登录；可选密码登录与验证码重设；协议/隐私版本记录。
- 不可预测且唯一的 `user-#########` handle 和可修改的“用户#########”显示名。
- 可撤销 opaque Browser Session 与安全 Cookie。
- Guest 的可配置公开流前 N 张限制，以及原文跳转的二次服务端检查。
- 注册 Member 私人收藏；Filter 公开收藏；Guest 登录前不接收 URL。
- 首订三个月体验的预览、明确扣费确认和 billing adapter。
- OAuth Authorization Code + PKCE、refresh rotation、RFC 8707 resource audience 与动态 public client 注册。
- 单一类型的命名 API Key，一次显示明文、独立撤销；Key 不分级，实际能力随账号实时权益变化。
- SDK 实现的 Streamable HTTP Hosted MCP、公开 Skill 和实时 Member/Filter 动态工具集；历史兼容 Free 账号仍按实时权益收窄。
- 云同步 Pull cursor 与 Push mutation；历史首次导入强制私密。
- Local Channel Runtime 所需的 Channel Identity、pending 与 BindIntent 底层实现仍保留；第一期产品 HTTP 入口已禁用，不生成 Hosted Channel 绑定链接。
- 公开 `/doc` Agent 接入文档；Web Agent 页面不属于第一期主入口。
- Consumer 新邮箱 OTP 邀请注册、双方三个月顺延 grant，以及 referral 账号永久排除 direct trial。
- Filter 每 UTC 自然年累计五张单次年卡、注册后兑换与十二个月顺延 grant。
- provider-neutral 首订/现金续费/退款/拒付事件，账号级 direct trial exactly-once，以及同币种 15% 积分、预留、消费、释放和冲正账本。
- `/account/rewards` 与对应 growth API；所有邀请/兑换原文只展示一次并只存哈希。

学生认证尚未启用。增长账本已经实现，但生产支付商、税费口径、跨币种规则、积分有效期和更完整的反作弊/运营复核仍待接入；provider event service 只接受可信服务端已结算事件，不能由客户端、MCP 或普通管理页面冒充续费成功。

## 2. 用户入口

| 场景 | 路由 | 行为 |
| --- | --- | --- |
| 站内登录 | `/login` intercepted modal | 保留底层 Domain、视图和滚动状态；用 `return_to` 恢复收藏等 intent |
| 站外认证 | `/auth` | OAuth、CLI 和 Local Channel Runtime 授权使用完整页面 |
| 收藏 | `/collect` | Guest 只看到登录门；验证前 DOM 中没有 URL 输入框 |
| 我的账号 | `/account` | 显示 handle、Member/Filter 状态和设置入口 |
| 安全设置 | `/account/settings` | 修改显示名、设置密码、继续保留验证码登录 |
| Agent 接入文档 | `/doc`、`/doc/:agent` | 公开、无需登录；每个 Agent 使用独立文档展示 Skill、MCP、OAuth 与验收步骤 |
| 连接管理 | `/account/connections` | 一键复制给 AI 的接入提示词、OAuth 与 API Key 状态；不铺安装命令，不展示 Channel 连接状态 |
| 会员 | `/membership`、`/membership/checkout` | 展示 Member 订阅和历史兼容权益，并在创建订阅前明确确认扣费信息 |
| 增长权益 | `/account/rewards`、`/join/:token` | 创建新用户邀请、签发/兑换 Filter 年卡、查看积分；邀请注册页不泄露 inviter |
| Agent 接入 | `/doc`、`/doc/:agent` | 无需登录的宿主文档；用户自己的 Agent 通过 Skill/MCP 使用能力 |

## 3. 凭据边界

四种凭据完全独立：

1. Browser Session 只用于网站；Cookie 不携带会员权益，权益在每次请求实时解析。
2. OAuth token 用于第三方客户端、Hosted MCP 与 Sync API；access/refresh 可按 client 吊销。
3. API Key 是 OAuth 不可用时的备用；所有 Key 类型相同，只保存哈希和前缀，可逐个吊销。Key 不选择产品权限，服务端每次调用按账号当前 Member/Filter（以及历史兼容 Free）权益决定能力。
4. Channel Identity 是保留给本地 Runtime/Adapter 的底层映射，不是网站登录凭据；第一期没有可用的 Hosted Channel 产品入口。

吊销其中一种不会退出其他 Browser Session、撤销其他 API Key/OAuth client 或解除其他 Channel。

## 4. API 与发现文档

### 认证

- `POST /api/auth/email/start`
- `POST /api/auth/email/verify`
- `POST /api/auth/password`
- `POST /api/auth/password/set`
- `POST /api/auth/logout`

### OAuth

- `GET /oauth/authorize`
- `POST /oauth/authorize/confirm`
- `GET /oauth/authorize/cancel`
- `POST /oauth/token`
- `POST /oauth/register`
- `POST /oauth/revoke`
- `GET /.well-known/oauth-authorization-server`
- `GET /.well-known/oauth-protected-resource`（MCP）
- `GET /.well-known/oauth-protected-resource/api/sync`（Sync）

只允许 PKCE S256。授权请求、authorization code token 请求与 refresh token 请求都必须使用 RFC 8707 `resource`，不再接受私有 `audience` 参数。`attention-mcp` 内部 audience 只映射到 `ATTENTION_MCP_PUBLIC_URL`（默认 `${NEXT_PUBLIC_APP_URL}/mcp`）；`attention-sync` 只映射到 `ATTENTION_SYNC_PUBLIC_URL`（默认 `${NEXT_PUBLIC_APP_URL}/api/sync`），scope 与 token 不能跨 resource 使用。

动态 client redirect URI 必须是 HTTPS，或本机 loopback HTTP，并禁止 fragment 与 URL credentials；授权与取消回跳都会重新验证 client 和精确 redirect URI。DCR 接受 RFC 7591/OIDC 客户端常见的 `grant_types`、`response_types`、`scope`、`application_type`、`software_id` 等元数据，并按 RFC 7591 忽略不理解的字段；服务端最终注册为 public client，并在响应中明确返回 `token_endpoint_auth_method: none`。

### Cloud 与第一期 Channel 边界

- `POST /mcp`：OAuth/API Key Bearer；Streamable HTTP JSON response。
- `GET|POST /api/sync`：OAuth/API Key Bearer，audience 为 `attention-sync`。
- `POST /api/channels/messages`：`410 Gone`。
- `POST /api/channels/bind`：`410 Gone`。
- `GET /api/channels/pending/:id`：`410 Gone`。
- `DELETE /api/account/channels/:id`：`410 Gone`。

四个旧入口统一返回 `hosted_channel_not_available`，不会认证、写库、恢复 pending request 或生成 `/channel/bind`。这不删除底层 Auth/Runtime 合同；未来重新启用时必须引入新的版本化产品入口和完整验收，不能静默恢复这些旧路由。

### 增长权益

- `GET /api/account/growth`：仅返回当前账号可见的邀请、年卡与积分摘要，不返回 token/hash。
- `POST /api/account/growth/invitations`：active 注册账号（包括 Filter）创建或替换新用户邀请链接。
- `POST /api/account/growth/filter-codes`：当前有效 Filter 签发年卡原文。
- `POST /api/account/growth/filter-codes/redeem`：登录账号兑换单次年卡。
- `POST /api/auth/email/start` 可携带 `consumer_invite_token`，但只允许尚未存在的新邮箱把 referral intent 带入 OTP 注册事务。

## 5. 能力矩阵

| 能力 | Guest | Free | Member | Filter |
| --- | --- | --- | --- | --- |
| 公开流 | 前 N 张 | 前 N 张 | 完整 | 完整 |
| 打开当前可见原文 | 是 | 是 | 是 | 是 |
| 私人云收藏/同步 | 否 | 是 | 是 | 是 |
| 公开收藏 | 否 | 否 | 否 | 是 |
| 个人收藏 MCP | 否 | 是 | 是 | 是 |
| Agent / Member 专属 MCP 能力 | 否 | 否 | 是 | 是 |
| Hosted Channel | 第一期开启前均不可用 | 第一期开启前均不可用 | 第一期开启前均不可用 | 第一期开启前均不可用 |

`PUBLIC_FEED_PREVIEW_LIMIT` 默认 20，所有网页、原文跳转和 MCP 公共读取都由服务端执行边界。未来新增标签、搜索或 Filter 主页时必须复用同一权限服务，不能只做前端遮罩。

## 6. 隐私与同步

- Guest 没有匿名账号或云端私人数据。
- 登录验证码成功前不创建新账号；收藏页也不提交或暂存 Guest URL。
- 私人链接云同步意味着服务端可见并保存 URL，这一点已写入隐私页和同步合同。
- 私人 Collection 不进入公开流、公共检索、日报或其他账号结果。
- Attention 不存原文正文；只存 URL、必要元数据、AI 派生信息、Collection 和事件。
- 首次本地历史导入的 `historical=true` 会强制私密，Filter 也不能批量自动公开历史数据。

## 7. 生产接入点

本地可演示 adapter 不等于生产供应商已经接入：

- 邮件登录：Web 可配置 `ATTENTION_EMAIL_PROVIDER=resend`，并从 secret store 注入 `RESEND_API_KEY`、`ATTENTION_RESEND_FROM`、`ATTENTION_RESEND_TEMPLATE_ID`。当前模板 alias 为 `attention-login-code`，注册、登录、重新验证和密码重设验证共用同一中性文案，只包含 `verification_code` 与 `valid_minutes`；当前 TTL 为 10 分钟。现有 `welcome-email-attention` 与 `password-reset-attention` 不得按账号是否存在分别发送，以免形成账号枚举侧信道。模板源文件见 [`../email-login-code-template.html`](../email-login-code-template.html)。
- 邮件兼容与日报：登录 OTP 仍保留 `console`（仅开发）和 `webhook` provider。Resend-only staging 必须设置 `ATTENTION_DIGEST_WORKER_ENABLED=false`，webhook URL/token 可以留空；启用日报时必须补齐两项 webhook 凭据，否则 Worker 启动时 fail closed。Worker 日报继续使用 webhook adapter、`attention-daily-digest-v1` 模板和 delivery UUID 幂等键，供应商需返回可选的 `message_id` 并保证重复请求不重复投递。
- 支付：`ATTENTION_BILLING_PROVIDER=webhook` 与 checkout webhook；生产禁用 demo provider。首订、已结算续费、退款和拒付账本已有 provider-neutral 服务合同，但仍需真实支付商的验签 webhook 和对账层调用，仓库没有假装某一支付商已联调。
- 微信：需要官方账号资质、签名/消息加密、回调和回复 Adapter；内部 Channel 合同与账号绑定已经可用。
- Secrets：HMAC、Auth、Channel 和 Adapter secret 必须分别配置，不能硬编码或复用短密钥。
- 部署前仍需增加分布式 MCP/API 限流、结构化审计事件、邮件退信/投诉/送达监控和支付 webhook 对账；日报 outbox 已能安全重试，但最终 exactly-once 仍依赖邮件供应商遵守 `Idempotency-Key`。

## 8. 主要实现位置

- `packages/auth/src/email-auth.ts`
- `packages/auth/src/passwords.ts`
- `packages/auth/src/sessions.ts`
- `packages/auth/src/oauth.ts`
- `packages/auth/src/api-credentials.ts`
- `packages/auth/src/channels.ts`
- `packages/auth/src/growth.ts`
- `packages/db/src/schema.ts`
- `apps/web/src/server/public-access.ts`
- `apps/web/src/server/membership.ts`
- `apps/web/src/app/account/rewards/page.tsx`
- `apps/web/src/server/sync-service.ts`
- `apps/web/src/app/mcp/route.ts`

## 9. 验证

```bash
pnpm typecheck
pnpm lint
TEST_DATABASE_URL=postgresql:///attention_test pnpm test
pnpm --filter @attention/web build
```

数据库测试会迁移并清空 `TEST_DATABASE_URL`，不得指向开发或生产数据库。当前端到端演示已验证：Guest 收藏门、邮箱验证码自动创建 Free、return intent、随机 handle、Free Agent 升级门、API Key 创建/撤销，以及撤销后 Hosted MCP 返回 401。
