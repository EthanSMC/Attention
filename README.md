# Attention

## 为什么是 Attention

Attention 解决的是 AI 时代的信息质量与知识沉淀问题。传统内容平台依赖用户交互和分发算法组织信息；当低成本生成内容大量涌入后，重复、空洞却“看似言之有物”的 AI Slop 不断消耗用户的注意力。与此同时，平台中仍然存在真正有思考、有经验、有长期价值的内容，只是它们越来越难被识别和保留下来。

对普通用户（Consumer）而言，Attention 利用真实的人类收藏作为质量信号，帮助用户减少筛选低质量内容的时间，在公开瀑布流中发现经 Filter 判断“值得保留”的信息，并始终回到原作者和原文阅读。

对 Filter 而言，Attention 解决的是优质信息散落和无法复用的问题。过去收藏通常分散在微信文件传输助手、浏览器书签以及不同平台的收藏夹中，之后很难再次找到。Attention 将这些跨平台收藏统一整理为可检索、可管理、可被个人 Agent 调用的知识资产；Filter 也可以通过公开收藏完成一次轻量背书，让自己筛选过的好内容获得再次被看见的机会。

Attention 不试图用 AI 生产更多内容，而是让人的判断成为过滤 AI Slop 的信号，让真正有价值的信息能够被保存、发现和持续利用。

## 当前版本

Attention 是一个“人筛选，AI 整理”的收藏与公开信息层。当前仓库已经形成账号体系首版：Guest 公开预览、邮箱验证码注册/登录、注册即 Member、Filter 公开供给、OAuth + PKCE、API Key、Hosted MCP、云同步、Consumer 裂变、Filter 年卡兑换和续费积分账本都执行真实的服务端身份与权限判断。第一期不提供官方 Hosted Agent 或 Hosted Channel；用户使用自己的 Agent，Attention 交付 Skill、MCP、OAuth 与 Local Channel Runtime 基础设施。

第一期范围以 [`docs/first-release-scope.md`](docs/first-release-scope.md) 为唯一口径。系统架构与 Attention MCP 见 [`docs/architecture.md`](docs/architecture.md)；本地 Agent、Desktop 交互与 iLink Runtime 边界见 [`Local Agent Channel Runtime 设计`](docs/superpowers/specs/2026-08-07-local-agent-channel-runtime-design.md)。当前账号、注册 Member、OAuth、云同步和增长机制的产品决策见 [`账号与会员设计`](docs/superpowers/specs/2026-08-04-attention-identity-membership-growth-design.md)。Web 视觉 token、组件和交互规则见 [`docs/design-system.md`](docs/design-system.md)；机器可读设计基线见 [`DESIGN.md`](DESIGN.md)，产品上下文见 [`PRODUCT.md`](PRODUCT.md)，设置页审查见 [`docs/settings-design-audit.md`](docs/settings-design-audit.md)。

通用容器、Compose、数据库角色、HTTPS 反代、环境变量和 CI 基线见 [`docs/deployment.md`](docs/deployment.md)。这些文件是可移植部署起点，不表示仓库或外部供应商已经上线。

## 当前能力

- 支持普通网页、抖音、小红书和微信公众号文章链接。
- 支持从整段中文分享文案中提取链接，不要求用户补写推荐理由。
- 所有候选链接都先交给隔离 Fetcher 做 DNS/IP、凭证参数和跳转校验；主 Web 服务不直接访问外部 URL。
- 多个不同内容链接先返回候选，用户选择前不会创建 Content 或公开收藏。
- Guest 不建立匿名账号，只能浏览可配置的前 N 张公开卡片；收藏入口在验证码成功前不会显示或接收 URL。
- 新邮箱验证码验证成功后自动创建 Member，生成不可预测的唯一 handle 和“用户+编号”显示名；密码是可选登录方式。
- Member 可不限量私密收藏和云同步；Filter 默认公开收藏。公开可见性仍只能由 Filter 产生。
- 同一用户重复收藏不会制造重复记录，也不会偷偷改变原可见性。
- 收藏后立即可在“我的收藏”查看；公开内容按首次公开时间出现在 AI 公开流。
- Member 解锁完整公开流、日报、托管 AI 检索和 Member 专属 MCP 能力；Web 与 MCP 使用相同服务端权益边界。
- OAuth Authorization Code + PKCE 是 CLI、第三方 Agent、Sync API 与 Hosted MCP 的推荐连接方式；API Key 仅作为不支持浏览器 OAuth 的备用。API Key 只有一种，实际能力始终跟随账号当前权益。
- Local Channel Runtime 使用独立 OAuth audience 和最小运行时 scopes；它只报告安装、心跳与用户自行持有的渠道绑定状态，不托管模型、会话或微信凭据。第一期 Web 不展示渠道绑定或连接状态。
- “查看原文”统一经过受控跳转，并在跳转时重新检查 owner、公开资格、风控与下架状态。
- 登录用户可以举报公开内容；两个不同 Consumer 或一个当前有效 Filter 会立即触发复核并从所有公共出口隐藏。有效 Filter 在 `/account/court` 一人一票，票一经投出不可更改。
- `/account/rewards` 提供新用户邀请（内部 Consumer referral）、Filter 年卡签发/兑换和按币种积分账本；邀请与兑换原文只展示一次，数据库只存哈希，grant 会在既有权益后按日历月顺延。
- 原始分享文案不落库，只保留 HMAC、被选中的安全 URL 和必要审计信息。

仓库仍保留早期官方公众号 Adapter 的实验代码与交接资料，但它不属于第一期产品面，也没有前端入口或生产联调承诺。第一期渠道方向以用户自己的 Agent 与 Local Channel Runtime 为准。

## 本地运行

需要 Node.js 24、pnpm 11 和 PostgreSQL 17。

```bash
cp .env.example .env.local
createuser attention_migration_owner
createdb --owner=attention_migration_owner attention_dev
pnpm install
MIGRATION_DATABASE_URL=postgresql://attention_migration_owner@localhost/attention_dev pnpm db:migrate
```

至少设置以下值（开发密钥也必须达到 32 个字符）：

```dotenv
DATABASE_URL=postgresql:///attention_dev
WORKER_DATABASE_URL=postgresql:///attention_dev
ATTENTION_HMAC_SECRET=replace-with-at-least-32-random-characters
ATTENTION_AUTH_SECRET=replace-with-a-separate-32-character-auth-secret
ATTENTION_CHANNEL_SECRET=replace-with-a-separate-32-character-channel-secret
ATTENTION_CHANNEL_PAIRING_SECRET=replace-with-an-independent-32-character-pairing-secret
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

### 早期微信公众号 Adapter（非第一期产品）

以下入口只用于维护已有协议测试，不代表 Attention 提供托管 Channel。取得 AppID、AppSecret、回调 Token 和 43 字符 EncodingAESKey 后，可补齐 `.env.local` 中的 `WECHAT_*` 配置并启动实验 Adapter：

```bash
pnpm dev:wechat
```

默认回调路径是 `/wechat/callback`，但第一期不要把这个实验 Adapter 部署为产品入口。Web 中旧 `/api/channels/messages`、`/api/channels/bind`、`/api/channels/pending/:id` 和账号 Channel 撤销接口统一返回 `410 Gone`，不会再生成已经移除的 `/channel/bind` 链接。底层 Channel 身份、Auth 合同和 Local Channel Runtime 基础设施继续保留，等待未来重新设计并显式启用。

`WECHAT_MESSAGE_MODE=compatible` 同时接受验签后的明文和 AES 消息，正式环境建议在公众号后台和 Adapter 一起切到 `safe`。只有公众号具备客服消息权限且已配置相应生产能力时，才设置 `WECHAT_ASYNC_REPLY_PROVIDER=customer_service`；否则保持 `disabled`，超时请求会安全确认并允许用户重试。Adapter 不记录原始 XML、openid 或 AppSecret。当前仓库只实现并测试了协议合同，未宣称已通过微信平台服务器验证或资质联调。

当前 Worker 默认完成确定性元数据整理；未设置 `ATTENTION_AI_MODEL` 时，摘要会进入明确的 unavailable 状态，托管 AI 检索使用关键词降级。配置 `ATTENTION_AI_MODEL`、可选的 `ATTENTION_AI_BASE_URL` 和 `ATTENTION_AI_API_KEY` 后，Worker 会通过隔离 Fetcher 临时读取受限页面内容并生成摘要/标签，检索服务会基于当前账号可访问的引用生成回答。原文正文不会写入数据库，供应商失败也不会伪装成生成成功。

普通本地开发与 Domain 日报可使用 `ATTENTION_EMAIL_PROVIDER=console`，验证码只写入服务端终端，浏览器和 API 响应永远不会收到验证码。登录邮件 E2E 必须配置原生 Resend 并实际调用 Resend 服务；生产 Web 登录验证码也可使用原生 Resend 或 webhook provider。Worker 日报目前仍只使用 webhook adapter。日报请求使用 `template=attention-daily-digest-v1`，并以 delivery UUID 同时填充 `message_id` 与 `Idempotency-Key`。供应商必须按该键去重重试；仓库不包含供应商密钥。

配置 `apps/web/.env.local` 中的真实 Resend provider、发件人和 `attention-login-code` 模板后，可运行 `DATABASE_URL=... ATTENTION_AUTH_SECRET=... pnpm test:e2e:resend`。该入口会在缺少 Resend 配置时直接失败，使用 Resend 官方交付测试地址实际发送，并断言浏览器响应不包含验证码。

Member 与 Filter 可在 `/account/digests` 订阅 Domain 并设置 IANA 时区、发送开始时间和窗口长度。Worker 每天选择账号当地日期的前一日新增内容；无新增不发。真正调用邮件 adapter 前会重新检查当前 Member/Filter 权益、退订状态、Domain/Filter/Collection 公开资格、摘要隐藏状态和条目快照的 `visibility_version`。第一版只种子化 AI Domain，表结构支持后续增加独立 Domain。

社区举报和 Filter 小法庭共用 `public_contents_current` 公开资格：`pending_review` 与 `hidden` 不会进入公开流、公共搜索、日报、Agent、MCP 或公开跳转。单个有效 Filter 的首次举报仍会立即隐藏对应内容；为避免单一账号批量压制公开流，每个 Filter 默认在滚动 24 小时内最多新开 10 个案件，可通过 `ATTENTION_FILTER_REPORT_CASE_LIMIT_24H` 在 1 至 100 之间调整。投票窗口至少 24 小时，至少 3 个有效 Filter 投票后按简单多数裁决；平票、票数不足或当前有效 Filter 少于 3 人时继续隐藏并转管理员。安全阻断、法律下架和 takedown 始终优先，社区票决不能恢复。公开裁决保留原 `first_public_at`，不会制造第二次日报。

## Agent、MCP 与同步

公开接入文档位于 `/doc`，并为 OpenClaw、Hermes、Codex、Claude Code 和
WorkBuddy 提供独立 URL。登录后的 `/account/connections` 只提供一键复制给 AI
的接入提示词、OAuth 授权状态和 API Key 管理，不再铺开安装命令。支持浏览器
OAuth 的客户端应直接连接 Hosted MCP：

```bash
codex mcp add attention --url http://127.0.0.1:3000/mcp
claude mcp add --transport http --scope user attention http://127.0.0.1:3000/mcp
```

仓库内的本地安装/诊断 CLI 会从同一份机器可读宿主 manifest 生成
OpenClaw、Hermes、Codex、Claude Code 和 WorkBuddy 的配置，不会另建一套能力声明：

```bash
pnpm --filter @attention/cli build
apps/cli/dist/index.js integrations list
apps/cli/dist/index.js configure codex --origin http://127.0.0.1:3000
apps/cli/dist/index.js configure workbuddy --origin http://127.0.0.1:3000
apps/cli/dist/index.js doctor codex --origin http://127.0.0.1:3000
```

`configure` 默认只打印可复制步骤；只有显式加入 `--apply` 才会落地 Skill/MCP
配置，OAuth 还需要额外加入 `--login`。CLI 不接收 iLink token，也不会把
WorkBuddy 的宿主内微信状态或尚未交付的 Codex/Claude inbound companion 显示为
“已连接”。WorkBuddy 的 `--apply` 只会下载并校验公开 ZIP，用户仍须在宿主 UI
手动导入。完整用法与安全边界见 [`apps/cli/README.md`](apps/cli/README.md)。

公开 Skill 位于 `/skills/attention/SKILL.md`，不会嵌入 token。`/mcp` 与 `/api/sync` 只接受 OAuth/API Key Bearer credential；网站 Cookie 不能冒充 Agent credential。OAuth 客户端必须按 RFC 8707 在授权请求和 token 请求（包括刷新）中发送同一个 `resource`：MCP 使用 `ATTENTION_MCP_PUBLIC_URL`（默认 `${NEXT_PUBLIC_APP_URL}/mcp`），同步使用 `ATTENTION_SYNC_PUBLIC_URL`（默认 `${NEXT_PUBLIC_APP_URL}/api/sync`），本地 Channel Runtime 使用 `ATTENTION_CHANNEL_RUNTIME_PUBLIC_URL`（默认 `${NEXT_PUBLIC_APP_URL}/api/runtime`）且只接受 OAuth。三个 resource 的 token 不能交叉使用。Runtime 的短期配对码只以 `ATTENTION_CHANNEL_PAIRING_SECRET` 派生的 HMAC 落库；该 secret 只注入 Web 服务端，必须与 Auth、旧 Channel 和 Adapter secret 独立。首次本地历史同步必须标记 `historical=true`，服务端会强制作为私密收藏导入。

公开 Tool Contract 当前为 `1.3.0`：包含账号与会员状态读取、收藏、候选选择、处理状态、个人列表、可见性修改、公开流、Member 搜索、内容举报、Filter 小法庭案件/投票与日报读写 14 个工具。小法庭投票只接受当前有效 Filter，并强制逐案逐决定传入 `explicit_confirmation: true`；Skill 禁止模型自行推断确认。收藏调用必须提供由客户端生成并在重试间复用的 `idempotency_key`；一次性候选选择明确标记为非幂等。工具调用审计只记录受限的版本、耗时、稳定状态和 HMAC 工作流指纹，不记录 URL、query、分享文本、正文、token 或一次性凭证。

生产构建会把 Worker 及其工作区依赖打包为单一 Node.js 产物，运行时不依赖 `tsx`：

```bash
pnpm --filter @attention/worker build
pnpm --filter @attention/worker start
```

## 创建邀请

> 以下命令只描述 legacy Filter/admin invitation。正式新用户邀请（内部 Consumer referral）、Filter 年卡兑换和日常登录已经使用相互独立的凭据与账本，不能复用这里的 invitation。

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
ATTENTION_MIGRATION_DATABASE_ROLE=attention_migration_owner
ATTENTION_MIGRATION_DATABASE_HOST=db
ATTENTION_MIGRATION_DATABASE_NAME=attention
DATABASE_URL=postgresql://attention_web_runtime:...@db/attention
WORKER_DATABASE_URL=postgresql://attention_worker_runtime:...@db/attention
ATTENTION_WEB_DATABASE_ROLE=attention_web_runtime
ATTENTION_WORKER_DATABASE_ROLE=attention_worker_runtime
```

生产和 staging 迁移必须显式设置 `MIGRATION_DATABASE_URL`，不会回退到 runtime `DATABASE_URL`。迁移在执行前同时核对 URL 与实际连接的角色、数据库和 PostgreSQL 17，并持有进程级 advisory lock；已有迁移运行时会立即失败。Web 和 Worker 在生产模式会拒绝使用角色名不匹配的 DSN。不要把 migration owner 的连接串交给应用进程；owner 会绕过 PostgreSQL RLS。

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
