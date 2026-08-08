# 通用生产部署基线

这份文档描述仓库当前提供的可移植部署基线，不代表 Attention 已经上线，也不代表邮件、支付、AI 或微信公众号资质已经完成生产联调。部署者仍需选择可信的托管平台、密钥管理、数据库备份、监控和外部供应商。

产品第一期范围以 [`docs/first-release-scope.md`](./first-release-scope.md) 为准。部署首版只需要 Web、Worker、Fetcher、PostgreSQL、OAuth/MCP 和本地 Agent Runtime 所需的基础设施；不要把历史微信公众号 Adapter 或 Hosted Channel 当成第一期公网服务。

Novelty Studio ECS 上的隔离 staging 部署使用专用的
[`deploy/staging/RUNBOOK.md`](../deploy/staging/RUNBOOK.md)。它包含安全组硬门禁、
固定目录与端口、备份恢复演练、Nginx/TLS、验收和应用回滚步骤；不得用本页的
通用 Compose 示例替代该 runbook。

## 构建产物

根目录 `Dockerfile` 使用固定的 Node.js 24.11.1 与 pnpm 11.9.0，通过 lockfile 冻结安装，并提供以下 multi-stage target：

| Target | 进程 | 监听与健康检查 |
|---|---|---|
| `web` | Next.js standalone server | `3000`，`GET /api/health` |
| `worker` | 收藏 enrichment 与可选日报 worker | 无 HTTP 端口；以进程存活和结构化日志监控 |
| `fetcher` | 隔离的 URL/DNS/跳转抓取服务 | `4100`，`GET /health` |
| `wechat-adapter` | 保留的微信公众号协议原型；第一期不部署 | `4200`，`GET /healthz` |
| `migrate` | Drizzle 一次性迁移任务 | 不常驻、无端口 |

四个常驻 target 都以镜像内已有的非 root `node` 用户运行。Worker、Fetcher、微信 Adapter 均为单文件 bundle；Web 只复制 standalone server、静态文件和公开资源。源码、开发依赖、`.env*`、Git 元数据、测试输出、浏览器产物和本地构建目录不会进入运行时镜像。

示例构建：

```bash
docker build --target web -t attention-web:local .
docker build --target worker -t attention-worker:local .
docker build --target fetcher -t attention-fetcher:local .
docker build --target wechat-adapter -t attention-wechat-adapter:local .
docker build --target migrate -t attention-migrate:local .
```

镜像使用固定版本 tag，但生产发布还应由自己的 registry 记录镜像 digest，并以 digest 部署和回滚。

## Compose 示例

`compose.yaml` 是单机或本地通用示例，不是高可用编排。它不会把 PostgreSQL 发布到宿主机端口；Web 默认只绑定 `127.0.0.1`，等待宿主机反向代理。`wechat` profile 仅保留协议原型测试，第一期产品部署不要启用。

先复制示例变量到不会提交的本地文件，并替换全部 `replace-me`：

```bash
cp .env.compose.example .env.compose.local
docker compose --env-file .env.compose.local config --quiet
```

迁移和 runtime role 密码配置都是显式、一次性的工具任务，不会随 `docker compose up` 自动执行，也不会删除数据库：

```bash
docker compose --env-file .env.compose.local --profile tools run --rm migrate
docker compose --env-file .env.compose.local --profile tools run --rm runtime-role-passwords
```

首次迁移完成后再启动常驻服务：

```bash
docker compose --env-file .env.compose.local up -d postgres fetcher web worker
```

以下命令只用于维护历史协议原型，不能形成第一期产品链路，因为 Web Channel 入口稳定返回 `410 Gone`：

```bash
docker compose --env-file .env.compose.local --profile wechat up -d wechat-adapter
```

升级时先备份数据库，以新镜像单独运行 `migrate`，成功后再滚动替换 Web/Worker。不要在每个应用副本启动时并发执行迁移，也不要让应用进程拿到 migration owner DSN。当前迁移只前进；回滚数据库必须使用经过演练的备份恢复或专门的兼容迁移，不能用 `down`/清库代替。

生产与 staging 的 migrate target 必须显式获得 `MIGRATION_DATABASE_URL`，不会回退到常驻应用的 `DATABASE_URL`。启动时先校验 PostgreSQL URL 中的 role/host/database，再从服务器读取 `current_user`、`current_database()` 和 `server_version_num`；只有预期身份、预期数据库和 PostgreSQL 17 才会继续。迁移使用固定 PostgreSQL advisory lock 串行化，拿不到锁会立即退出，并在成功或失败后释放锁。错误信息不会打印 DSN 或密码。

## 数据库 owner、RLS 与网络

PostgreSQL 至少使用三种身份：

- `attention_migration_owner`（名称可由平台决定）：拥有 DDL，仅供一次性迁移任务。
- `attention_web_runtime`：Web 的非 owner、`NOBYPASSRLS` 登录角色。
- `attention_worker_runtime`：Worker 的非 owner、`NOBYPASSRLS` 登录角色。

迁移 `0002_runtime_roles.sql` 创建两个 runtime role，但故意不设置密码。Compose 的 `runtime-role-passwords` 工具只从环境注入密码；托管 PostgreSQL 更适合由数据库管理员或密钥平台在仓库外设置。Web 与 Worker 在 `NODE_ENV=production` 时会核对 DSN 用户名，并拒绝 migration owner。表 owner 会绕过 PostgreSQL RLS，因此绝不能为了方便把 owner DSN 交给常驻应用。

生产数据库应只接受私网或受控网络连接，强制 TLS，限制安全组来源，并启用自动备份、恢复演练、连接上限和慢查询监控。Compose 的 `database` 网络标记为 internal，且 Postgres 没有 `ports`；若需要本地管理，请使用 `docker compose exec postgres psql ...`，不要增加 `0.0.0.0:5432:5432`。

## 必需环境变量

所有 secret 都应来自部署平台 secret store 或只读文件注入，不能写入镜像、Compose 文件、CI 日志或 Git。长度要求以代码校验为准，以下 HMAC/Auth/Channel/Channel Pairing/Adapter/Fetcher secret 至少使用独立的 32 字节随机值，不能复用。

### Migrate

| 变量 | 生产要求 |
|---|---|
| `MIGRATION_DATABASE_URL` | 显式的 PostgreSQL 17 owner DSN；生产/staging 必填，不能使用 runtime role。 |
| `ATTENTION_MIGRATION_DATABASE_ROLE` | 预期 owner role，默认 `attention_migration_owner`。URL 与实际 `current_user` 都必须匹配。 |
| `ATTENTION_MIGRATION_DATABASE_HOST` | 可选的预期 DSN host；Compose 固定为 `postgres`。 |
| `ATTENTION_MIGRATION_DATABASE_NAME` | 可选的预期数据库名；Compose 从 `POSTGRES_DB` 注入，staging 为 `attention_staging`。URL 与实际 `current_database()` 都必须匹配。 |

### Web

| 变量 | 生产要求 |
|---|---|
| `DATABASE_URL` | `attention_web_runtime` 的 PostgreSQL DSN；不能是 owner。 |
| `ATTENTION_WEB_DATABASE_ROLE` | 默认并建议保持 `attention_web_runtime`。 |
| `NEXT_PUBLIC_APP_URL` | 用户访问的唯一 HTTPS origin，例如 `https://attention.example.com`。 |
| `ATTENTION_HMAC_SECRET` | 候选与收藏流程的独立随机 secret。 |
| `ATTENTION_AUTH_SECRET` | 浏览器认证的独立随机 secret。 |
| `ATTENTION_CHANNEL_SECRET` | 旧 Channel intent 协议的独立随机 secret。 |
| `ATTENTION_CHANNEL_PAIRING_SECRET` | Local Agent Channel Runtime 配对 challenge 的独立 HMAC secret；至少 32 字符，只注入 Web 服务端，不能复用 Auth、旧 Channel 或 Adapter secret。 |
| `ATTENTION_CHANNEL_ADAPTER_SECRET` | Web 与 Adapter 间 Bearer secret；两端必须一致。 |
| `FETCHER_BASE_URL` | 内网 Fetcher 地址；Compose 为 `http://fetcher:4100`。 |
| `FETCHER_SHARED_SECRET` | Web/Worker/Fetcher 三端一致的独立 Bearer secret。 |
| `ATTENTION_EMAIL_PROVIDER` | Web 生产使用 `resend` 或 `webhook`，不能使用 `console`。原生 Resend 仅发送统一身份验证码。 |
| `RESEND_API_KEY` | `resend` provider 的专用 Key，只放 secret store；泄露后必须轮换。 |
| `ATTENTION_RESEND_FROM` | 已在 Resend 验证的发件人，例如 `Attention <no_reply@service.noveltystudio.cn>`。 |
| `ATTENTION_RESEND_TEMPLATE_ID` | 中性统一验证码模板 ID/alias，当前为 `attention-login-code`。 |
| `ATTENTION_EMAIL_WEBHOOK_URL` | `webhook` provider 的无 credentials/query/fragment 可信 HTTPS 邮件入口。 |
| `ATTENTION_EMAIL_WEBHOOK_TOKEN` | `webhook` provider 的邮件服务 Bearer token。 |
| `ATTENTION_MCP_PUBLIC_URL` | 对外 HTTPS MCP resource URL。 |
| `ATTENTION_MCP_REQUESTS_PER_MINUTE` | 每个 MCP credential/client 的 PostgreSQL 共享分钟预算，必须为 10–1000 的整数；默认 120。超限返回 `429`、`Retry-After` 与 `retry_after_seconds`。 |
| `ATTENTION_SYNC_PUBLIC_URL` | 对外 HTTPS Sync resource URL。 |
| `ATTENTION_CHANNEL_RUNTIME_PUBLIC_URL` | 对外 HTTPS Local Channel Runtime control-plane resource URL。 |
| `ATTENTION_TRUSTED_CLIENT_SOURCE_HEADER` | 入口代理拥有的专用客户端来源头名称；代理必须先丢弃同名入站头再按连接源覆盖。生产缺失时登录与动态注册会 fail closed；应用拒绝 `Forwarded`、`X-Forwarded-For`、`X-Real-IP` 和 CDN 常规客户端地址头。 |
| `ATTENTION_CONSUMER_INVITE_QUOTA` | 每个 active 注册账号（包括 Filter）可成功邀请的人数；账号页显示已使用 / 总名额，必须是 1–100 的整数。 |

Resend 模板源文件见 [`email-login-code-template.html`](email-login-code-template.html)。注册、登录、重新验证和密码重设验证必须复用这一个中性模板，只传 `verification_code` 与 `valid_minutes`；当前 challenge TTL 为 10 分钟。服务端不得查询账号状态后选择 `welcome-email-attention` 或 `password-reset-attention`，否则会形成账号枚举侧信道。原生 provider 直接调用 `https://api.resend.com/emails`，以 login challenge ID 派生 `Idempotency-Key`；成功日志只保留脱敏邮箱与 provider message ID。

仓库的 `.env.compose.example` 默认是 Resend-only staging：Web 使用原生 Resend，`ATTENTION_DIGEST_WORKER_ENABLED=false`，日报 webhook URL/token 留空。若要启用日报，必须同时设置 `ATTENTION_DIGEST_WORKER_ENABLED=true`、`ATTENTION_EMAIL_WEBHOOK_URL` 与 `ATTENTION_EMAIL_WEBHOOK_TOKEN`。Compose 允许日报关闭时传入空 webhook 值；一旦日报开启，Worker 会构造 webhook provider，并在任一凭据缺失时 fail closed。

`PUBLIC_FEED_PREVIEW_LIMIT`、价格展示、OAuth 动态注册全局/单来源频率等有安全默认值，但仍应在部署配置中显式审阅。登录验证码不会写入浏览器响应；本地和 staging 的邮件 E2E 也必须通过实际邮件 provider 完成发送验证。

若启用订阅结账，设置 `ATTENTION_BILLING_PROVIDER=webhook`、可信的 `ATTENTION_BILLING_CHECKOUT_WEBHOOK` 与 `ATTENTION_BILLING_WEBHOOK_SECRET`。仓库内的 `demo` 仅适用于非生产环境；当前仓库不包含真实支付商、退款/拒付对账或地区合规实现。

### Worker

| 变量 | 生产要求 |
|---|---|
| `WORKER_DATABASE_URL` | `attention_worker_runtime` 的 PostgreSQL DSN；不能是 owner。 |
| `ATTENTION_WORKER_DATABASE_ROLE` | 默认并建议保持 `attention_worker_runtime`。 |
| `FETCHER_BASE_URL` / `FETCHER_SHARED_SECRET` | 与隔离 Fetcher 一致。 |
| `NEXT_PUBLIC_APP_URL` | 开启日报时生成公开链接所需的 HTTPS origin。 |
| `ATTENTION_DIGEST_WORKER_ENABLED` | 是否运行日报循环；代码默认 `true`，但 Resend-only staging 示例必须显式设为 `false`。 |
| 邮件 webhook 三变量 | 开启日报时必须配置；Worker 日报仍使用 `webhook`，不使用 Web 的 Resend 登录验证码模板。生产 console provider 会拒绝启动。 |

`ATTENTION_AI_MODEL` 为空时仍可运行确定性元数据流程，但不会伪造 AI 摘要。要启用托管 AI，设置模型名、可信 OpenAI-compatible `ATTENTION_AI_BASE_URL`、`ATTENTION_AI_API_KEY` 和合理超时。模型供应商会接收为生成摘要所需的临时页面文本；部署者必须完成隐私、数据驻留、保留策略和供应商合同审查。

### Fetcher

`FETCHER_SHARED_SECRET` 必需且至少 32 字符。容器默认监听 `0.0.0.0:4100`，但只应在应用私网可达，不能直接暴露到公网。每个请求的 DNS、重定向、连接和响应正文读取共享一个总 deadline；入口按真实 streaming chunks 将授权 JSON 请求限制为 16 KiB，超限会取消读取并返回 `413`。默认最多并发 16 个抓取、排队 32 个、等待队列 1 秒，分别通过 `FETCHER_MAX_CONCURRENCY`、`FETCHER_MAX_QUEUE`、`FETCHER_QUEUE_TIMEOUT_MS` 调整。容量或排队 deadline 超限会快速返回 `503 overloaded`，边缘层仍应设置连接和请求速率限制。Fetcher 不需要也不应获得数据库、Auth、邮件、微信或 AI 密钥。

### 微信 Adapter

本节只记录历史原型的安全要求，第一期不要把它部署到生产。未来若重新启用，除与 Web 共享的 `ATTENTION_CHANNEL_ADAPTER_SECRET` 外，必须从微信公众号后台取得 `WECHAT_APP_ID`、`WECHAT_APP_SECRET`、`WECHAT_CALLBACK_TOKEN` 和 43 字符 `WECHAT_ENCODING_AES_KEY`，并重新设计版本化 Web 产品入口；不得直接取消现有旧路由的 `410 Gone`。

只有账号具备客服消息权限且真实联调通过后才启用 `WECHAT_ASYNC_REPLY_PROVIDER=customer_service`。当前代码测试了协议合同，但未宣称已经通过微信平台服务器验证、备案、IP 白名单、客服消息权限或资质审核。

## HTTPS、反向代理与健康检查

公网只应到达受信任的反向代理/WAF。代理负责：

- TLS 终止与自动续期，HTTP 永久跳转 HTTPS；
- 保留原始 `Host`/scheme，限制请求体和超时；
- 对认证、OAuth 动态注册、收藏和微信回调设置合适的按 IP/账号限流；
- 第一时期只把 Web 路由到 `3000`，不要把历史 Adapter 的 `4200` 或 callback path 发布到公网；
- 不对外发布 Fetcher、Worker、migration job 或 PostgreSQL。

认证与 OAuth 动态注册的数据库限流只接受入口认证后的来源值，不读取客户端可伪造的 `X-Forwarded-For`。仓库提供 [`deploy/nginx/attention.conf.example`](../deploy/nginx/attention.conf.example) 作为最小 Nginx 参考：代理必须覆盖 `X-Attention-Client-Source`，并把同一名称配置到 `ATTENTION_TRUSTED_CLIENT_SOURCE_HEADER`。应用会拒绝 `Forwarded`、`X-Forwarded-For`、`X-Real-IP`、`CF-Connecting-IP`、`True-Client-IP` 和 `Fastly-Client-IP` 等常规转发/客户端地址头；若使用 Cloudflare、ALB、Kubernetes ingress 等其他边缘，必须另外创建专用头并实现同等的“清除入站同名头、按已验证连接元数据重新设置、限制 Web 仅能由该入口访问”语义。

Web `GET /api/health`、Fetcher `GET /health` 和微信 `GET /healthz` 都只返回固定 `{ "status": "ok" }`，不查询数据库、不回显配置，也不证明外部供应商可用，适合作为 liveness。数据库、邮件、AI、微信等依赖应另做不含 secret 的平台级 readiness/合成监控。Worker 不是 HTTP 服务；以进程退出、任务延迟、失败码和队列积压监控，不要为了容器健康检查额外开放无认证端口。

## CI 基线

`.github/workflows/ci.yml` 使用最小 `contents: read` 权限、同分支并发取消、固定 Node/pnpm，并在全新 PostgreSQL 17.6 service 上从 `0000` 执行到最新迁移。之后依次执行 typecheck、lint、完整测试和生产 build，并构建、以只读文件系统启动 Fetcher target，等待镜像内 healthcheck 成功。

CI 中的数据库口令和应用 secret 只是隔离 runner 的固定测试值，不能复制到部署环境。真实部署 secret 不应放入 workflow YAML；若增加发布 job，应使用受保护 environment、短期 OIDC 凭据、不可变镜像 digest 和人工审批。
