# Attention 账号体系首版交接

更新时间：2026-08-04

权威产品规格：[`2026-08-04-attention-identity-membership-growth-design.md`](../superpowers/specs/2026-08-04-attention-identity-membership-growth-design.md)

## 1. 已实现范围

- Guest、Free、Member、Filter 的实时服务端能力解析。
- 邮箱验证码统一注册/登录；可选密码登录与验证码重设；协议/隐私版本记录。
- 不可预测且唯一的 `user-#########` handle 和可修改的“用户#########”显示名。
- 可撤销 opaque Browser Session 与安全 Cookie。
- Guest/Free 的可配置公开流前 N 张限制，以及原文跳转的二次服务端检查。
- Free 私人收藏；Filter 公开收藏；Guest 登录前不接收 URL。
- 首订三个月体验的预览、明确扣费确认和 billing adapter。
- OAuth Authorization Code + PKCE、refresh rotation、resource audience 与动态 public client 注册。
- 命名 PAT/API Key，一次显示明文、独立撤销。
- SDK 实现的 Streamable HTTP Hosted MCP、公开 Skill 和 Free/Member 动态工具集。
- 云同步 Pull cursor 与 Push mutation；历史首次导入强制私密。
- Hosted Channel pending request、一次性明确绑定、原请求 continuation、结果轮询和独立解绑。
- 网页 Agent 页面与 Member 服务端权限门。

Consumer 推荐、Filter 年卡兑换、积分返还和学生认证尚未启用。它们的业务规则已在权威规格中记录，但支付事件、反作弊和运营规则仍待封口，不能复用 legacy invitation 冒充正式增长账本。

## 2. 用户入口

| 场景 | 路由 | 行为 |
| --- | --- | --- |
| 站内登录 | `/login` intercepted modal | 保留底层 Domain、视图和滚动状态；用 `return_to` 恢复收藏等 intent |
| 站外认证 | `/auth` | OAuth、CLI 和 Channel 绑定使用完整页面 |
| 收藏 | `/collect` | Guest 只看到登录门；验证前 DOM 中没有 URL 输入框 |
| 我的账号 | `/account` | 显示 handle、Free/Member 状态和设置入口 |
| 安全设置 | `/account/settings` | 修改显示名、设置密码、继续保留验证码登录 |
| 连接管理 | `/account/connections` | OAuth、PAT、MCP/Skill 安装信息与 Channel 解绑 |
| 会员 | `/membership`、`/membership/checkout` | 展示 Free/Member 价值并在创建订阅前明确确认扣费信息 |
| Agent | `/agent` | Member 才能执行检索；Free 看到升级说明 |

## 3. 凭据边界

四种凭据完全独立：

1. Browser Session 只用于网站；Cookie 不携带会员权益，权益在每次请求实时解析。
2. OAuth token 用于第三方客户端、Hosted MCP 与 Sync API；access/refresh 可按 client 吊销。
3. PAT 是 OAuth 不可用时的备用；只保存哈希和前缀，可逐个吊销。
4. Channel Identity 是 `provider + app_id + subject HMAC` 到账号的绑定，不是登录凭据，可单独解绑。

吊销其中一种不会退出其他 Browser Session、撤销其他 PAT/OAuth client 或解除其他 Channel。

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
- `GET /.well-known/oauth-protected-resource`

只允许 PKCE S256。动态 client redirect URI 必须是 HTTPS，或本机 loopback HTTP；授权与取消回跳都会重新验证 client 和精确 redirect URI。

### Cloud 与 Channel

- `POST /mcp`：OAuth/PAT Bearer；Streamable HTTP JSON response。
- `GET|POST /api/sync`：OAuth/PAT Bearer，audience 为 `attention-sync`。
- `POST /api/channels/messages`：仅可信 Adapter 的内部 Bearer。
- `POST /api/channels/bind`：Browser Session 明确确认。
- `GET /api/channels/pending/:id`：可信 Adapter 轮询 continuation 结果。

## 5. 能力矩阵

| 能力 | Guest | Free | Member | Filter |
| --- | --- | --- | --- | --- |
| 公开流 | 前 N 张 | 前 N 张 | 完整 | 完整 |
| 打开当前可见原文 | 是 | 是 | 是 | 是 |
| 私人云收藏/同步 | 否 | 是 | 是 | 是 |
| 公开收藏 | 否 | 否 | 否 | 是 |
| 基础个人 MCP | 否 | 是 | 是 | 是 |
| Agent / 高级 MCP | 否 | 否 | 是 | 是 |
| Hosted Channel | 否 | 否 | 是 | 是 |

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

- 邮件：`ATTENTION_EMAIL_PROVIDER=webhook` 与 `ATTENTION_EMAIL_WEBHOOK_URL/TOKEN`。
- 支付：`ATTENTION_BILLING_PROVIDER=webhook` 与 checkout webhook；生产禁用 demo provider。
- 微信：需要官方账号资质、签名/消息加密、回调和回复 Adapter；内部 Channel 合同与账号绑定已经可用。
- Secrets：HMAC、Auth、Channel 和 Adapter secret 必须分别配置，不能硬编码或复用短密钥。
- 部署前仍需增加分布式 MCP/API 限流、结构化审计事件、邮件送达监控和支付 webhook 对账。

## 8. 主要实现位置

- `packages/auth/src/email-auth.ts`
- `packages/auth/src/passwords.ts`
- `packages/auth/src/sessions.ts`
- `packages/auth/src/oauth.ts`
- `packages/auth/src/api-credentials.ts`
- `packages/auth/src/channels.ts`
- `packages/db/src/schema.ts`
- `apps/web/src/server/public-access.ts`
- `apps/web/src/server/membership.ts`
- `apps/web/src/server/sync-service.ts`
- `apps/web/src/app/mcp/route.ts`

## 9. 验证

```bash
pnpm typecheck
pnpm lint
TEST_DATABASE_URL=postgresql:///attention_test pnpm test
pnpm --filter @attention/web build
```

数据库测试会迁移并清空 `TEST_DATABASE_URL`，不得指向开发或生产数据库。当前端到端演示已验证：Guest 收藏门、邮箱验证码自动创建 Free、return intent、随机 handle、Free Agent 升级门、PAT 创建/撤销，以及撤销后 Hosted MCP 返回 401。
