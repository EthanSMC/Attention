# 通用生产部署基线

这份文档描述仓库当前提供的可移植部署基线，不代表 Attention 已经上线，也不代表邮件、支付、AI 或微信公众号资质已经完成生产联调。部署者仍需选择可信的托管平台、密钥管理、数据库备份、监控和外部供应商。

## 构建产物

根目录 `Dockerfile` 使用固定的 Node.js 24.11.1 与 pnpm 11.9.0，通过 lockfile 冻结安装，并提供以下 multi-stage target：

| Target | 进程 | 监听与健康检查 |
|---|---|---|
| `web` | Next.js standalone server | `3000`，`GET /api/health` |
| `worker` | 收藏 enrichment 与可选日报 worker | 无 HTTP 端口；以进程存活和结构化日志监控 |
| `fetcher` | 隔离的 URL/DNS/跳转抓取服务 | `4100`，`GET /health` |
| `wechat-adapter` | 微信公众号回调 Adapter | `4200`，`GET /healthz` |
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

`compose.yaml` 是单机或本地通用示例，不是高可用编排。它不会把 PostgreSQL 发布到宿主机端口；Web 和可选微信 Adapter 也默认只绑定 `127.0.0.1`，等待宿主机反向代理。

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

启用微信 Adapter 需要先完成下文的微信生产配置：

```bash
docker compose --env-file .env.compose.local --profile wechat up -d wechat-adapter
```

升级时先备份数据库，以新镜像单独运行 `migrate`，成功后再滚动替换 Web/Worker。不要在每个应用副本启动时并发执行迁移，也不要让应用进程拿到 migration owner DSN。当前迁移只前进；回滚数据库必须使用经过演练的备份恢复或专门的兼容迁移，不能用 `down`/清库代替。

## 数据库 owner、RLS 与网络

PostgreSQL 至少使用三种身份：

- `attention_migration_owner`（名称可由平台决定）：拥有 DDL，仅供一次性迁移任务。
- `attention_web_runtime`：Web 的非 owner、`NOBYPASSRLS` 登录角色。
- `attention_worker_runtime`：Worker 的非 owner、`NOBYPASSRLS` 登录角色。

迁移 `0002_runtime_roles.sql` 创建两个 runtime role，但故意不设置密码。Compose 的 `runtime-role-passwords` 工具只从环境注入密码；托管 PostgreSQL 更适合由数据库管理员或密钥平台在仓库外设置。Web 与 Worker 在 `NODE_ENV=production` 时会核对 DSN 用户名，并拒绝 migration owner。表 owner 会绕过 PostgreSQL RLS，因此绝不能为了方便把 owner DSN 交给常驻应用。

生产数据库应只接受私网或受控网络连接，强制 TLS，限制安全组来源，并启用自动备份、恢复演练、连接上限和慢查询监控。Compose 的 `database` 网络标记为 internal，且 Postgres 没有 `ports`；若需要本地管理，请使用 `docker compose exec postgres psql ...`，不要增加 `0.0.0.0:5432:5432`。

## 必需环境变量

所有 secret 都应来自部署平台 secret store 或只读文件注入，不能写入镜像、Compose 文件、CI 日志或 Git。长度要求以代码校验为准，以下 HMAC/Auth/Channel/Adapter/Fetcher secret 至少使用独立的 32 字节随机值，不能复用。

### Web

| 变量 | 生产要求 |
|---|---|
| `DATABASE_URL` | `attention_web_runtime` 的 PostgreSQL DSN；不能是 owner。 |
| `ATTENTION_WEB_DATABASE_ROLE` | 默认并建议保持 `attention_web_runtime`。 |
| `NEXT_PUBLIC_APP_URL` | 用户访问的唯一 HTTPS origin，例如 `https://attention.example.com`。 |
| `ATTENTION_HMAC_SECRET` | 候选与收藏流程的独立随机 secret。 |
| `ATTENTION_AUTH_SECRET` | 浏览器认证的独立随机 secret。 |
| `ATTENTION_CHANNEL_SECRET` | Channel intent 的独立随机 secret。 |
| `ATTENTION_CHANNEL_ADAPTER_SECRET` | Web 与 Adapter 间 Bearer secret；两端必须一致。 |
| `FETCHER_BASE_URL` | 内网 Fetcher 地址；Compose 为 `http://fetcher:4100`。 |
| `FETCHER_SHARED_SECRET` | Web/Worker/Fetcher 三端一致的独立 Bearer secret。 |
| `ATTENTION_EMAIL_PROVIDER` | 生产必须使用 `webhook`，不能使用 `console`。 |
| `ATTENTION_EMAIL_WEBHOOK_URL` | 无 credentials/query/fragment 的可信 HTTPS 邮件入口。 |
| `ATTENTION_EMAIL_WEBHOOK_TOKEN` | 邮件服务 Bearer token。 |
| `ATTENTION_MCP_PUBLIC_URL` | 对外 HTTPS MCP resource URL。 |
| `ATTENTION_SYNC_PUBLIC_URL` | 对外 HTTPS Sync resource URL。 |
| `ATTENTION_TRUSTED_CLIENT_SOURCE_HEADER` | 入口代理拥有的专用客户端来源头名称；代理必须先丢弃同名入站头再按连接源覆盖。生产缺失时登录与动态注册会 fail closed；应用拒绝 `Forwarded`、`X-Forwarded-For`、`X-Real-IP` 和 CDN 常规客户端地址头。 |

`PUBLIC_FEED_PREVIEW_LIMIT`、价格展示、OAuth 动态注册全局/单来源频率等有安全默认值，但仍应在部署配置中显式审阅。生产不要设置 `ATTENTION_AUTH_EXPOSE_OTP=true`；即使误设，代码也不会在 production 展示验证码。

若启用订阅结账，设置 `ATTENTION_BILLING_PROVIDER=webhook`、可信的 `ATTENTION_BILLING_CHECKOUT_WEBHOOK` 与 `ATTENTION_BILLING_WEBHOOK_SECRET`。仓库内的 `demo` 仅适用于非生产环境；当前仓库不包含真实支付商、退款/拒付对账或地区合规实现。

### Worker

| 变量 | 生产要求 |
|---|---|
| `WORKER_DATABASE_URL` | `attention_worker_runtime` 的 PostgreSQL DSN；不能是 owner。 |
| `ATTENTION_WORKER_DATABASE_ROLE` | 默认并建议保持 `attention_worker_runtime`。 |
| `FETCHER_BASE_URL` / `FETCHER_SHARED_SECRET` | 与隔离 Fetcher 一致。 |
| `NEXT_PUBLIC_APP_URL` | 开启日报时生成公开链接所需的 HTTPS origin。 |
| `ATTENTION_DIGEST_WORKER_ENABLED` | 是否运行日报循环；默认 `true`。 |
| 邮件 webhook 三变量 | 开启日报时与 Web 相同；生产 console provider 会拒绝启动。 |

`ATTENTION_AI_MODEL` 为空时仍可运行确定性元数据流程，但不会伪造 AI 摘要。要启用托管 AI，设置模型名、可信 OpenAI-compatible `ATTENTION_AI_BASE_URL`、`ATTENTION_AI_API_KEY` 和合理超时。模型供应商会接收为生成摘要所需的临时页面文本；部署者必须完成隐私、数据驻留、保留策略和供应商合同审查。

### Fetcher

`FETCHER_SHARED_SECRET` 必需且至少 32 字符。容器默认监听 `0.0.0.0:4100`，但只应在应用私网可达，不能直接暴露到公网。每个请求的 DNS、重定向、连接和响应正文读取共享一个总 deadline；入口按真实 streaming chunks 将授权 JSON 请求限制为 16 KiB，超限会取消读取并返回 `413`。默认最多并发 16 个抓取、排队 32 个、等待队列 1 秒，分别通过 `FETCHER_MAX_CONCURRENCY`、`FETCHER_MAX_QUEUE`、`FETCHER_QUEUE_TIMEOUT_MS` 调整。容量或排队 deadline 超限会快速返回 `503 overloaded`，边缘层仍应设置连接和请求速率限制。Fetcher 不需要也不应获得数据库、Auth、邮件、微信或 AI 密钥。

### 微信 Adapter

除与 Web 共享的 `ATTENTION_CHANNEL_ADAPTER_SECRET` 外，必须从微信公众号后台取得 `WECHAT_APP_ID`、`WECHAT_APP_SECRET`、`WECHAT_CALLBACK_TOKEN` 和 43 字符 `WECHAT_ENCODING_AES_KEY`。生产建议 `WECHAT_MESSAGE_MODE=safe`，并在微信后台同步配置。Compose 同栈内允许使用固定服务地址 `http://web:3000`；任何其他跨主机或公网 `ATTENTION_CHANNEL_API_BASE_URL` 都必须是无 credentials/query/fragment 的 HTTPS URL。

只有账号具备客服消息权限且真实联调通过后才启用 `WECHAT_ASYNC_REPLY_PROVIDER=customer_service`。当前代码测试了协议合同，但未宣称已经通过微信平台服务器验证、备案、IP 白名单、客服消息权限或资质审核。

## HTTPS、反向代理与健康检查

公网只应到达受信任的反向代理/WAF。代理负责：

- TLS 终止与自动续期，HTTP 永久跳转 HTTPS；
- 保留原始 `Host`/scheme，限制请求体和超时；
- 对认证、OAuth 动态注册、收藏和微信回调设置合适的按 IP/账号限流；
- 只把 Web 路由到 `3000`，需要微信时只把配置的 callback path 路由到 `4200`；
- 不对外发布 Fetcher、Worker、migration job 或 PostgreSQL。

认证与 OAuth 动态注册的数据库限流只接受入口认证后的来源值，不读取客户端可伪造的 `X-Forwarded-For`。仓库提供 [`deploy/nginx/attention.conf.example`](../deploy/nginx/attention.conf.example) 作为最小 Nginx 参考：代理必须覆盖 `X-Attention-Client-Source`，并把同一名称配置到 `ATTENTION_TRUSTED_CLIENT_SOURCE_HEADER`。应用会拒绝 `Forwarded`、`X-Forwarded-For`、`X-Real-IP`、`CF-Connecting-IP`、`True-Client-IP` 和 `Fastly-Client-IP` 等常规转发/客户端地址头；若使用 Cloudflare、ALB、Kubernetes ingress 等其他边缘，必须另外创建专用头并实现同等的“清除入站同名头、按已验证连接元数据重新设置、限制 Web 仅能由该入口访问”语义。

Web `GET /api/health`、Fetcher `GET /health` 和微信 `GET /healthz` 都只返回固定 `{ "status": "ok" }`，不查询数据库、不回显配置，也不证明外部供应商可用，适合作为 liveness。数据库、邮件、AI、微信等依赖应另做不含 secret 的平台级 readiness/合成监控。Worker 不是 HTTP 服务；以进程退出、任务延迟、失败码和队列积压监控，不要为了容器健康检查额外开放无认证端口。

## CI 基线

`.github/workflows/ci.yml` 使用最小 `contents: read` 权限、同分支并发取消、固定 Node/pnpm，并在全新 PostgreSQL 17.6 service 上从 `0000` 执行到最新迁移。之后依次执行 typecheck、lint、完整测试和生产 build，并构建、以只读文件系统启动 Fetcher target，等待镜像内 healthcheck 成功。

CI 中的数据库口令和应用 secret 只是隔离 runner 的固定测试值，不能复制到部署环境。真实部署 secret 不应放入 workflow YAML；若增加发布 job，应使用受保护 environment、短期 OIDC 凭据、不可变镜像 digest 和人工审批。
