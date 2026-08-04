# Attention

Attention 是一个“人筛选，AI 整理”的收藏与公开信息层。当前仓库已经形成账号体系首版：Guest 公开预览、邮箱验证码注册/登录、Free 私人收藏、Member 权益门、网页 Agent、OAuth + PKCE、PAT、Hosted MCP、云同步和 Hosted Channel 绑定都执行真实的服务端身份与权限判断。Consumer 裂变、Filter 年卡兑换、积分账本和生产支付/微信供应商接入仍按规格后续启用。

系统架构、微信统一 Agent 数据流与 Attention MCP 见 [`docs/architecture.md`](docs/architecture.md)。当前账号、Free/Member、OAuth、云同步、Channel 和增长机制的产品决策见 [`docs/superpowers/specs/2026-08-04-attention-identity-membership-growth-design.md`](docs/superpowers/specs/2026-08-04-attention-identity-membership-growth-design.md)。

## 当前能力

- 支持普通网页、抖音、小红书和微信公众号文章链接。
- 支持从整段中文分享文案中提取链接，不要求用户补写推荐理由。
- 所有候选链接都先交给隔离 Fetcher 做 DNS/IP、凭证参数和跳转校验；主 Web 服务不直接访问外部 URL。
- 多个不同内容链接先返回候选，用户选择前不会创建 Content 或公开收藏。
- Guest 不建立匿名账号，只能浏览可配置的前 N 张公开卡片；收藏入口在验证码成功前不会显示或接收 URL。
- 新邮箱验证码验证成功后自动创建 Free，生成不可预测的唯一 handle 和“用户+编号”显示名；密码是可选登录方式。
- Free 可不限量私密收藏和云同步；Filter 默认公开收藏。公开可见性仍只能由 Filter 产生。
- 同一用户重复收藏不会制造重复记录，也不会偷偷改变原可见性。
- 收藏后立即可在“我的收藏”查看；公开内容按首次公开时间出现在 AI 公开流。
- Member 解锁完整公开流、网页 Agent、托管 AI 检索、高级 MCP 和 Hosted Channel；所有公共表面都使用相同服务端权益边界。
- OAuth Authorization Code + PKCE 是 CLI、第三方 Agent、Sync API 与 Hosted MCP 的推荐连接方式；PAT 仅作为不支持浏览器 OAuth 的备用。
- 微信等 Hosted Channel 使用一次性绑定链接，明确显示目标 `@handle`；Channel、OAuth、PAT 与网站 Session 可分别吊销。
- “查看原文”统一经过受控跳转，并在跳转时重新检查 owner、公开资格、风控与下架状态。
- 原始分享文案不落库，只保留 HMAC、被选中的安全 URL 和必要审计信息。

微信入口的内部 Channel 合同、账号绑定与 pending continuation 已实现。微信官方签名、回调解密、客服消息与生产资质接入仍由独立 Adapter 完成，详见 [`docs/handoffs/wechat-adapter-handoff.md`](docs/handoffs/wechat-adapter-handoff.md)。

## 本地运行

需要 Node.js 24、pnpm 11 和 PostgreSQL 16。

```bash
cp .env.example .env.local
createdb attention_dev
pnpm install
MIGRATION_DATABASE_URL=postgresql:///attention_dev pnpm db:migrate
```

至少设置以下值（开发密钥也必须达到 32 个字符）：

```dotenv
DATABASE_URL=postgresql:///attention_dev
WORKER_DATABASE_URL=postgresql:///attention_dev
ATTENTION_HMAC_SECRET=replace-with-at-least-32-random-characters
ATTENTION_AUTH_SECRET=replace-with-a-separate-32-character-auth-secret
ATTENTION_CHANNEL_SECRET=replace-with-a-separate-32-character-channel-secret
ATTENTION_CHANNEL_ADAPTER_SECRET=replace-with-an-internal-adapter-bearer-secret
FETCHER_BASE_URL=http://127.0.0.1:4100
FETCHER_SHARED_SECRET=replace-with-at-least-32-random-characters
NEXT_PUBLIC_APP_URL=http://127.0.0.1:3000
PUBLIC_FEED_PREVIEW_LIMIT=20
```

分别启动三个进程：

```bash
pnpm dev:fetcher
pnpm dev:worker
pnpm --filter @attention/web dev --hostname 127.0.0.1
```

当前 Worker 默认使用明确的未配置 handler：收藏本身会成功，但在接入实际元数据/模型服务前，标题和摘要任务会安全失败并显示“暂时无法生成摘要”，不会伪装成处理成功。

本地验证码可使用 `ATTENTION_EMAIL_PROVIDER=console`；只有非生产环境设置 `ATTENTION_AUTH_EXPOSE_OTP=true` 时，页面才会显示开发验证码。生产邮件与支付通过 webhook adapter 接入，仓库不包含供应商密钥。

## Agent、MCP 与同步

登录后打开 `/account/connections`。支持浏览器 OAuth 的客户端应直接连接 Hosted MCP：

```bash
codex mcp add attention --url http://127.0.0.1:3000/mcp
claude mcp add --transport http --scope user attention http://127.0.0.1:3000/mcp
```

公开 Skill 位于 `/skills/attention/SKILL.md`，不会嵌入 token。`/mcp` 与 `/api/sync` 只接受 OAuth/PAT Bearer credential；网站 Cookie 不能冒充 Agent credential。首次本地历史同步必须标记 `historical=true`，服务端会强制作为私密收藏导入。

生产构建会把 Worker 及其工作区依赖打包为单一 Node.js 产物，运行时不依赖 `tsx`：

```bash
pnpm --filter @attention/worker build
pnpm --filter @attention/worker start
```

## 创建邀请

> 以下邀请命令描述当前过渡实现。目标产品将使用统一邮箱验证码注册/登录；Consumer 邀请、Filter 年卡兑换和日常登录使用相互独立的凭据与账本，不能复用当前 invitation。

Filter 邀请：

```bash
DATABASE_URL=postgresql:///attention_dev \
pnpm --filter @attention/db exec tsx ../../scripts/create-invite.ts \
  --kind filter \
  --handle ethan \
  --display-name "Ethan" \
  --base-url http://127.0.0.1:3000
```

Legacy member invitation 把 `--kind filter` 改成 `--kind member`，并移除 `--display-name`。它只描述当前过渡实现，不能扩展或复用为目标 Consumer referral。原始邀请 token 只输出一次，数据库只保存 SHA-256 hash。
打开邀请链接只显示确认页，不会消费 token；用户同源点击确认后才会创建 session，避免聊天软件或邮件的链接预览提前吃掉邀请。

## 生产数据库角色

迁移必须使用独立的表 owner 连接；迁移会创建两个无默认密码、不可绕过 RLS 的登录角色：`attention_web_runtime` 与 `attention_worker_runtime`。密码应由部署平台或数据库管理员在仓库外设置。生产环境分别配置：

```dotenv
MIGRATION_DATABASE_URL=postgresql://attention_migration_owner:...@db/attention
DATABASE_URL=postgresql://attention_web_runtime:...@db/attention
WORKER_DATABASE_URL=postgresql://attention_worker_runtime:...@db/attention
ATTENTION_WEB_DATABASE_ROLE=attention_web_runtime
ATTENTION_WORKER_DATABASE_ROLE=attention_worker_runtime
```

Web 和 Worker 在生产模式会拒绝使用角色名不匹配的 DSN。不要把 migration owner 的连接串交给应用进程；owner 会绕过 PostgreSQL RLS。

## 验证

```bash
pnpm typecheck
TEST_DATABASE_URL=postgresql:///attention_test pnpm test
pnpm lint
pnpm build
```

集成测试会迁移并清空 `TEST_DATABASE_URL` 指向的测试库，请勿把它指向开发库或生产库。

## 安全边界

- Fetcher 无数据库凭据，只接受内部 Bearer secret。
- Fetcher 禁止私网、环回、链路本地、保留地址、非 80/443 端口、URL credentials、HTTPS 降级和自动重定向。
- 候选 URL 只在 24 小时歧义选择窗口中使用 AES-256-GCM 加密保存；选择 token 只保存 hash，Worker 会硬删除过期候选集合。候选消费、Content、Collection、审计链接、异步 Job 和 Attempt 终态在同一事务提交，失败时一起回滚。
- Cookie 为 `HttpOnly; SameSite=Lax`，生产环境额外使用 `Secure` 与 `__Host-` 前缀。
- `collections` 的 owner-only RLS policy 只授予 Web runtime role；集成测试会以真实非 owner 角色验证无上下文不可见、带账号上下文只见本人数据。
