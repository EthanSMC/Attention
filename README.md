# Attention

Attention 是一个“人筛选，AI 整理”的收藏与公开信息层。当前仓库已经形成账号体系首版：Guest 公开预览、邮箱验证码注册/登录、Free 私人收藏、Member 权益门、网页 Agent、OAuth + PKCE、PAT、Hosted MCP、云同步、Hosted Channel 绑定、Consumer 裂变、Filter 年卡兑换和续费积分账本都执行真实的服务端身份与权限判断。生产支付与微信供应商仍未联调，仓库中的 provider-neutral 合同和本地 adapter 不能被当成已经上线的供应商能力。

系统架构、微信统一 Agent 数据流与 Attention MCP 见 [`docs/architecture.md`](docs/architecture.md)。当前账号、Free/Member、OAuth、云同步、Channel 和增长机制的产品决策见 [`docs/superpowers/specs/2026-08-04-attention-identity-membership-growth-design.md`](docs/superpowers/specs/2026-08-04-attention-identity-membership-growth-design.md)。

通用容器、Compose、数据库角色、HTTPS 反代、环境变量和 CI 基线见 [`docs/deployment.md`](docs/deployment.md)。这些文件是可移植部署起点，不表示仓库或外部供应商已经上线。

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
- 登录用户可以举报公开内容；两个不同 Consumer 或一个当前有效 Filter 会立即触发复核并从所有公共出口隐藏。有效 Filter 在 `/account/court` 一人一票，票一经投出不可更改。
- `/account/rewards` 提供 Consumer 邀请、Filter 年卡签发/兑换和按币种积分账本；邀请与兑换原文只展示一次，数据库只存哈希，grant 会在既有权益后按日历月顺延。
- 原始分享文案不落库，只保留 HMAC、被选中的安全 URL 和必要审计信息。

微信入口的内部 Channel 合同、账号绑定与 pending continuation 已实现；独立 Adapter 已覆盖服务器验证、明文/安全模式回调、消息 AES、被动回复、客服消息 provider 和 access token 缓存。代码尚未在持有相应资质的真实公众号后台完成联调，生产前置条件见下方说明和 [`docs/handoffs/wechat-adapter-handoff.md`](docs/handoffs/wechat-adapter-handoff.md)。

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

### 微信公众号 Adapter

在公众号后台取得 AppID、AppSecret、回调 Token 和 43 字符 EncodingAESKey 后，补齐 `.env.local` 中的 `WECHAT_*` 配置并启动：

```bash
pnpm dev:wechat
```

默认回调路径是 `/wechat/callback`。生产环境必须通过公网 HTTPS 把它暴露给微信服务器，并让 `ATTENTION_CHANNEL_API_BASE_URL` 指向 Attention Web 的可信内部地址；Adapter 使用 `ATTENTION_CHANNEL_ADAPTER_SECRET` 调用现有 `/api/channels/messages` 与 pending 接口，Free、未绑定和 Member 规则仍由 Web 内部 API 统一判断。

`WECHAT_MESSAGE_MODE=compatible` 同时接受验签后的明文和 AES 消息，正式环境建议在公众号后台和 Adapter 一起切到 `safe`。只有公众号具备客服消息权限且已配置相应生产能力时，才设置 `WECHAT_ASYNC_REPLY_PROVIDER=customer_service`；否则保持 `disabled`，超时请求会安全确认并允许用户重试。Adapter 不记录原始 XML、openid 或 AppSecret。当前仓库只实现并测试了协议合同，未宣称已通过微信平台服务器验证或资质联调。

当前 Worker 默认完成确定性元数据整理；未设置 `ATTENTION_AI_MODEL` 时，摘要会进入明确的 unavailable 状态，网页 Agent 使用关键词检索降级。配置 `ATTENTION_AI_MODEL`、可选的 `ATTENTION_AI_BASE_URL` 和 `ATTENTION_AI_API_KEY` 后，Worker 会通过隔离 Fetcher 临时读取受限页面内容并生成摘要/标签，网页 Agent 会基于当前账号可访问的引用生成回答。原文正文不会写入数据库，供应商失败也不会伪装成生成成功。

本地验证码与 Domain 日报可使用 `ATTENTION_EMAIL_PROVIDER=console`；只有非生产环境设置 `ATTENTION_AUTH_EXPOSE_OTP=true` 时，页面才会显示开发验证码。生产邮件通过同一个 webhook adapter 接入：日报请求使用 `template=attention-daily-digest-v1`，并以 delivery UUID 同时填充 `message_id` 与 `Idempotency-Key`。供应商必须按该键去重重试；仓库不包含供应商密钥。

Member 与 Filter 可在 `/account/digests` 订阅 Domain 并设置 IANA 时区、发送开始时间和窗口长度。Worker 每天选择账号当地日期的前一日新增内容；无新增不发。真正调用邮件 adapter 前会重新检查当前 Member/Filter 权益、退订状态、Domain/Filter/Collection 公开资格、摘要隐藏状态和条目快照的 `visibility_version`。第一版只种子化 AI Domain，表结构支持后续增加独立 Domain。

社区举报和 Filter 小法庭共用 `public_contents_current` 公开资格：`pending_review` 与 `hidden` 不会进入公开流、公共搜索、日报、Agent、MCP 或公开跳转。单个有效 Filter 的首次举报仍会立即隐藏对应内容；为避免单一账号批量压制公开流，每个 Filter 默认在滚动 24 小时内最多新开 10 个案件，可通过 `ATTENTION_FILTER_REPORT_CASE_LIMIT_24H` 在 1 至 100 之间调整。投票窗口至少 24 小时，至少 3 个有效 Filter 投票后按简单多数裁决；平票、票数不足或当前有效 Filter 少于 3 人时继续隐藏并转管理员。安全阻断、法律下架和 takedown 始终优先，社区票决不能恢复。公开裁决保留原 `first_public_at`，不会制造第二次日报。

## Agent、MCP 与同步

登录后打开 `/account/connections`。支持浏览器 OAuth 的客户端应直接连接 Hosted MCP：

```bash
codex mcp add attention --url http://127.0.0.1:3000/mcp
claude mcp add --transport http --scope user attention http://127.0.0.1:3000/mcp
```

公开 Skill 位于 `/skills/attention/SKILL.md`，不会嵌入 token。`/mcp` 与 `/api/sync` 只接受 OAuth/PAT Bearer credential；网站 Cookie 不能冒充 Agent credential。OAuth 客户端必须按 RFC 8707 在授权请求和 token 请求（包括刷新）中发送同一个 `resource`：MCP 使用 `ATTENTION_MCP_PUBLIC_URL`（默认 `${NEXT_PUBLIC_APP_URL}/mcp`），同步使用 `ATTENTION_SYNC_PUBLIC_URL`（默认 `${NEXT_PUBLIC_APP_URL}/api/sync`）。两个 resource 的 token 不能交叉使用。首次本地历史同步必须标记 `historical=true`，服务端会强制作为私密收藏导入。

生产构建会把 Worker 及其工作区依赖打包为单一 Node.js 产物，运行时不依赖 `tsx`：

```bash
pnpm --filter @attention/worker build
pnpm --filter @attention/worker start
```

## 创建邀请

> 以下命令只描述 legacy Filter/admin invitation。正式 Consumer 邀请、Filter 年卡兑换和日常登录已经使用相互独立的凭据与账本，不能复用这里的 invitation。

Filter 邀请：

```bash
DATABASE_URL=postgresql:///attention_dev \
pnpm --filter @attention/db exec tsx ../../scripts/create-invite.ts \
  --kind filter \
  --handle ethan \
  --display-name "Ethan" \
  --base-url http://127.0.0.1:3000
```

Legacy member invitation 把 `--kind filter` 改成 `--kind member`，并移除 `--display-name`。它不能扩展或复用为 Consumer referral。原始邀请 token 只输出一次，数据库只保存 SHA-256 hash。
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

## 许可证

Copyright 2026 Attention contributors。仓库代码以 [Apache License 2.0](LICENSE) 发布，包含明确的专利授权与贡献条款。
