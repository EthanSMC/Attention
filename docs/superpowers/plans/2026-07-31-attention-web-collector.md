# Attention Web 收藏入口实现计划

状态：已完成（历史 Web 收藏切片）

日期：2026-07-31

对应产品规格：`docs/superpowers/specs/2026-07-31-attention-v1-design.md`

> 当前第一版范围以 [`docs/first-release-scope.md`](../../first-release-scope.md) 为准。本计划只记录最早的 Web 收藏纵向切片；其中“本轮不实现 Email、MCP、支付”等是当时的切片边界，不是当前第一版的产品清单。当前账号、会员、OAuth、MCP、公开接入文档和本地 Agent/iLink 基础设施见统一范围文档及相关交接。

## 1. 本轮交付

完成一个不依赖微信平台接入的 Web 纵向切片：

`邀请链接登录 → 粘贴链接或整段平台分享文案 → 自动识别/安全解析 → 公开或私密收藏 → 我的收藏 → /ai 公开流 → 查看原文`

首批输入来源同时包含：

- 抖音直链和复制分享文案。
- 小红书直链和复制分享文案。
- 微信公众号文章链接及含链接的分享文本。
- 普通网页直链和含单个链接的文本。

本轮不实现微信消息入口、Email、MCP、支付、推荐排序和全文问答，但采集服务不得绑定 Web 请求结构，后续微信只需构造同一种 InputEnvelope。

## 2. 技术方案

### 2.1 形态

采用“模块化单体 + 独立 Worker + 隔离抓取器”的结构：

- pnpm workspace 管理 Web、Worker、Fetcher 和共享 package。
- Next.js App Router + TypeScript 提供页面与 HTTP API。
- PostgreSQL 保存账号、会话、输入、内容、收藏、任务和事件。
- Drizzle ORM 管理 schema 与显式 SQL migration。
- PostgreSQL jobs 表承担首版异步任务，不为单一 worker 引入 Redis。
- 独立 collector domain 模块完成 URL 提取、来源适配、规范化与去重。
- `apps/fetcher` 是唯一可发起外部 HTTP/DNS 的进程，不持有数据库、模型或云平台凭证；部署时禁止访问内网。所有逐跳安全检查、IP pinning 和受限页面抓取都在这里完成。
- 独立 worker 进程补全元数据；AI 摘要通过可替换 Provider 接口接入，未配置时使用明确降级状态。
- Vitest 负责领域和集成测试，Playwright 负责关键 Web 路径。

Fetcher 是首期唯一拆出的安全边界；其余能力保持一个部署单元，避免过早微服务化。`collector`、`auth`、`repositories` 和 `worker` 都通过明确接口隔离，未来可以继续拆分而不改变产品语义。

### 2.2 首版身份

首批 Filter 使用管理员生成的一次性邀请链接登录：

- 邀请 token 和 session token 只保存哈希。
- session 使用 Secure、HttpOnly、SameSite cookie。
- 邀请可指定 member 或 filter 能力。
- Filter 自动获得 member entitlement。
- 不接入第三方 OAuth 或邮件服务，避免额外平台配置阻塞 Web 收藏验证。

### 2.3 后台任务

API 同步完成：

- 身份与权限。
- 输入幂等。
- URL 候选提取。
- 安全检查和有限短链解析。
- 来源识别。
- 确定性 upsert。
- Collection 建立与回执。

worker 异步完成：

- HTML 元数据抓取。
- canonical 信任判断。
- canonical merge candidate 或安全自动合并。
- AI 摘要、标签和向量 Provider 调用。
- 失败重试与最终降级。

## 3. Web 体验方向

### 3.1 页面唯一任务

首屏不做营销 Hero。页面的主角就是收藏动作：用户粘贴任何平台分享内容后，立即知道系统识别了什么、将以什么可见性保存，以及最终会跳向哪里。

### 3.2 视觉 Token

- `canvas #F3F7F6`：冷调工作台背景。
- `surface #FFFFFF`：输入与卡片表面。
- `ink #152023`：正文与结构线。
- `ai-signal #2949C7`：AI 整理、主动作和键盘焦点。
- `human-signal #C43F32`：Filter 收藏信号与公开提示。
- `success #0D6B4F`：成功和私密确认。
- `danger #A12B24`：安全阻断。

字体：

- 页面主标题：`LXGW WenKai Screen / Noto Serif SC`，只在极少量位置体现“人的筛选”。
- 中文主体：`Atkinson Hyperlegible Next / PingFang SC / Noto Sans SC / sans-serif`。
- 数据、来源和状态：`IBM Plex Mono / SFMono-Regular / monospace`。
- 页面必须在字体加载失败时保持稳定布局；中文正文不依赖远程字体才能可读。

### 3.3 签名元素

收藏成功前后展示一条真实的“双轨信号线”：珊瑚色代表 Filter 的人类收藏，靛蓝色代表系统识别与 AI 整理。轨迹内容为：

`输入 → 小红书/抖音/公众号/网页 → 原文地址 → 公开/私密`

提交过程中只有这一处出现横向扫描动效；开启 reduced motion 时替换为静态进度变化。卡片中的双轨缩成一条侧边线，并同时配有文字和图标，不能只靠颜色传意。它既是视觉记忆点，也是用户确认默认公开没有被隐藏的产品信息。

### 3.4 布局草图

桌面收藏页：

```text
┌──────────────────────────────────────────────────────────────┐
│ ATTENTION        收藏     我的收藏     AI                    │
├──────────────────────────────────────────────────────────────┤
│ 把值得留下的链接放进来                      本次将：公开       │
│ ┌──────────────────────────────────┐   ┌───────────────────┐ │
│ │ 粘贴链接，或整段平台分享文案      │   │ 识别结果/卡片预览  │ │
│ │                                  │   │ 来源、原文、状态    │ │
│ └──────────────────────────────────┘   └───────────────────┘ │
│ [ 输入 ] ─ [ 来源 ] ─ [ 原文 ] ─ [ 公开 ]    [公开收藏]     │
└──────────────────────────────────────────────────────────────┘
```

移动端：

```text
┌──────────────────────┐
│ ATTENTION       菜单 │
│ 把链接放进来         │
│ ┌──────────────────┐ │
│ │ 分享文案/链接     │ │
│ └──────────────────┘ │
│ 本次将公开  [切换]   │
│ [收藏]               │
│ 输入→来源→原文→公开  │
│ ┌──────────────────┐ │
│ │ 识别结果          │ │
│ └──────────────────┘ │
└──────────────────────┘
```

公开/私密使用原生 radio 语义而非含混开关，CTA 复述结果：“公开收藏”或“保存到我的收藏”。“我的收藏”使用清晰列表而不是数据后台；`/ai` 在移动端单列、桌面端两列起步，DOM 保持时间顺序且不使用会重排键盘顺序的 dense 布局。卡片背景由 canonical URL 稳定映射到调色板，不搬运原站图片。

### 3.5 自我审查

最初方向容易滑向深色“AI 控制台”、通用圆角 Dashboard 或报表式瀑布墙。当前方案改用冷调明亮工作台、极少量圆角和一条有真实含义的双轨信号线；技术感只出现在来源/状态层，正文仍保持适合长时间浏览的中文阅读密度。视觉风险集中在双轨扫描一处，其余动画、KPI 和装饰全部移除。

## 4. 目录规划

```text
apps/
  web/
    src/app/
      (auth)/invite/[token]/route.ts
      collect/page.tsx
      mine/page.tsx
      ai/page.tsx
      api/v1/collection-attempts/route.ts
      api/v1/collection-attempts/[id]/selection/route.ts
      api/v1/me/collections/[id]/visibility/route.ts
      out/[contentId]/route.ts
    src/components/
  worker/
  fetcher/
packages/
  auth/
  collector/
    src/adapters/
    src/extract-candidates.ts
    src/normalize.ts
    src/service.ts
    src/types.ts
  contracts/
  db/
  domain/
  observability/
  testkit/
scripts/
  create-invite.ts
drizzle/
tests/
  unit/
  integration/
  e2e/
```

## 5. 数据库首批表

本轮只落真正参与 Web 闭环的表，但字段遵守产品规格：

- `accounts`
- `entitlements`
- `filter_profiles`
- `invitations`
- `sessions`
- `domains`
- `input_attempts`
- `input_candidates`
- `pending_candidate_sets`（加密、TTL、不进长期备份）
- `contents`
- `content_identities`
- `content_links`
- `content_aliases`
- `canonical_merge_candidates`
- `content_merge_audits`
- `content_restriction_audits`
- `collections`
- `collection_events`
- `enrichment_runs`
- `jobs`
- `event_ledger`

决定性数据库约束：

- `input_attempts(channel, account_id, channel_message_id)` 唯一。
- `content_identities(dedupe_key)` 唯一，并保留 adapter 规则升级产生的新旧身份。
- `collections(account_id, content_id)` 唯一。
- session、invite 和 ambiguous selection token 只保存哈希，并有到期时间。
- visibility、filter revoke、moderation 和 content safety 使用独立字段，不压缩成模糊状态。
- InputAttempt 保存处理 lease、result_content_id 和 result_collection_id，支持崩溃恢复。
- 私人 Collection 启用 PostgreSQL RLS；请求事务用 `SET LOCAL app.account_id` 注入当前身份。
- 建立统一 `public_contents_current` 数据库视图，Feed 与公开跳转复用同一有效公开谓词。

## 6. 任务拆分

### Task 1：项目骨架和质量门

创建：

- `package.json`
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`
- `tsconfig.json`
- `next.config.ts`
- `eslint.config.mjs`
- `vitest.config.ts`
- `playwright.config.ts`
- `.env.example`
- `.gitignore`

要求：

- Node/TypeScript strict。
- `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 可独立运行。
- 环境变量启动时用 Zod 校验，测试环境可注入隔离配置。

### Task 2：数据库 schema、migration 与仓储

实现：

- 第 5 节首批表。
- 枚举和时间字段的数据库约束。
- 原子 ContentIdentity `dedupe_key` upsert。
- Collection active/private/public/revoked 转换函数。
- `public_contents_current` 视图和私人 Collection RLS。
- migration 和最小开发 seed。

测试：

- 并发相同 dedupe_key 只产生一个 Content。
- 同一账号/Content 只产生一个 Collection。
- active 私密收藏重复提交不变公开状态。
- deleted Collection 重新收藏进入新周期。

### Task 3：邀请与 session

实现：

- 管理员 CLI 生成一次性邀请。
- 邀请路由兑换安全 session cookie。
- `requireAccount`、`requireMember`、`requireFilter`。
- Filter 自动 member entitlement。
- 登出和 session 过期。

测试：

- token 只能消费一次。
- 数据库只存 token hash。
- 普通会员不能创建公开 Collection。
- Filter 的历史私人收藏不会因权限变化自动公开。

### Task 4：InputEnvelope 与候选 URL 提取

实现：

- Web payload 转统一 InputEnvelope。
- 从纯 URL、中文/英文文本、Emoji 和平台模板中提取 HTTP(S) URL。
- 清理零宽字符和 URL 外层标点。
- 同一输入候选去重。
- 原始文本只在请求生命周期内存在；审计使用服务端 HMAC。
- 限制输入 32 KiB、候选最多 16 个、单 URL 最多 4 KiB。

测试覆盖抖音、小红书、公众号、generic 的直链与整段分享文案，以及无链接、多链接和尾随中文标点。

### Task 5：隔离 Fetcher 与安全网络层

实现：

- Adapter 和 Web/Worker 不得自行联网，全部经不持有数据库/云凭证的 Fetcher。
- 每一跳限制为 HTTP(S) 的 80/443 端口，默认禁止 HTTPS 降级到 HTTP。
- DNS 解析后拒绝回环、私网、链路本地、保留、组播和云元数据地址。
- 将已验证 IP 固定到本次连接，保留原 host 的 TLS SNI/证书校验，并复核实际 peer IP，防 DNS 重绑定。
- 手动处理最多五次重定向，每一跳重新校验。
- 禁用环境代理、cookie、认证头、Referer 和自动重定向。
- 连接/总 timeout、header/解压后正文上限、允许内容类型和脱敏 redirect chain。
- 已知平台公开分享参数白名单与通用凭证参数阻断。

测试不得访问公网，使用本地受控 DNS/HTTP fixture 模拟：

- 公网地址成功。
- 初始私网拒绝。
- 公网跳私网拒绝。
- DNS 重绑定拒绝。
- 重定向环和超限。
- 明显 token/签名链接阻断。
- 大 header、压缩炸弹、慢响应和环境代理均不能绕过限制。

### Task 6：Source Adapter 与确定性规范化

实现统一接口：

- `detect(url)`
- `rank(candidate)`
- `normalize(url)`
- `canonicalIdentity(url)`
- `extractMetadata(document)`

适配器不得持有网络能力。适配器：

- douyin
- xiaohongshu
- wechat_official_article
- generic_web

规则配置带版本。通用规范化保持保守：不改变 path 大小写、不解码编码斜杠、不删除未知 query，fragment 在无法确认语义时保留；公众号文章身份参数和平台内容 ID 由各自 adapter 管理。已识别的平台下载/营销页或安全失败不能通过 generic fallback 绕过。标题或 AI 相似度永远不参与 V1 dedupe。

### Task 7：收藏领域服务和 API

实现：

- `POST /api/collections`
- `POST /api/collections/select`
- 输入幂等：同键同 HMAC 重放结果，同键不同 HMAC 返回 `409 idempotency_key_reused`。
- 单一高可信候选自动处理。
- 多个高可信目标返回一次性、账号/attempt/候选集合绑定、24 小时有效的选择 token；选择前不创建 Content/Collection，候选集合选择或过期即删除。
- `accepted`、`already_collected`、`merged_with_existing_content`、`ambiguous`、`resolution_pending`、`invalid`、`unsafe` 回执。
- Filter 默认公开，member 私密；请求参数不能越权。
- 首次成功返回 201、幂等重放 200、pending 202、ambiguous 409、invalid/unsafe 422；响应始终带稳定业务 status 和 InputAttempt ID。
- 幂等重放复用处理结果，但回执中的当前 visibility 必须重新读取 Collection，不能重放过期的“已公开”。

### Task 8：元数据 worker 与降级

实现：

- PostgreSQL job claim：`FOR UPDATE SKIP LOCKED`，收藏写入与 job/outbox 建立处于同一事务。
- 指数退避、最大次数和 dead 状态。
- 仅临时读取受限 HTML，提取 title、author、source、published_at 和受信 canonical。
- 不存正文和原站图片。
- 可替换 Summarizer Provider；未配置或失败时持久化“暂时无法生成摘要”。
- canonical 冲突先建 merge candidate；满足规格的无冲突场景才事务化合并。

### Task 9：收藏入口 UI

实现：

- 真实 textarea，接受 URL 或整段分享文案。
- Filter 用 fieldset/radio 明示“本次将公开”，可选择私密；member 固定私密且不显示虚假公开选项。
- 提交 loading、识别轨迹、成功、重复、ambiguous、pending、unsafe 和 invalid 状态。
- 识别结果显示 source、最终原文 host、可见性，不把平台模板文字当摘要。
- 键盘 focus、aria-live、移动端和 reduced-motion。
- 不把原始输入放入 localStorage、分析事件、session replay 或客户端错误上报。

### Task 10：我的收藏与可见性

实现：

- 按 collected_at 倒序。
- 标题、来源、处理状态、公开/私密和查看原文。
- Filter 显式公开/改为私密。
- active 私密重复收藏不自动公开。
- 可见性更新递增 Content visibility_version。

### Task 11：最小 `/ai` 流与跳转事件

实现：

- 只返回当前有效公开 Content。
- 按不可变 first_public_at 倒序。
- 两列起步、移动端单列的轻量瀑布流。
- 无原图，使用 canonical hash 生成背景。
- 显示标题、摘要/降级、来源、作者和 Filter。
- 跳转前重新校验公开资格；写入过滤后的 outbound_click 事件后 302 到 outbound URL。
- 公开跳转只接受不可枚举的服务端内容标识，不提供 `?url=` 开放重定向，并返回 `Cache-Control: no-store`、`Referrer-Policy: no-referrer`。
- 私人收藏使用 owner-only 跳转路由，不能复用公开跳转资格。

### Task 12：端到端验证和运行文档

Playwright 覆盖：

1. Filter 通过邀请登录。
2. 粘贴小红书分享文本并默认公开收藏。
3. 在“我的收藏”看到结果并改为私密。
4. `/ai` 不再出现该内容。
5. 普通会员收藏只进入私人列表。
6. unsafe 和 ambiguous 不产生公开内容。

README 写明：

- 安装依赖。
- 创建本地数据库和执行 migration。
- 创建 Filter 邀请。
- 启动 Web 和 worker。
- 执行全部质量命令。
- 当前尚未接入的微信和 AI Provider 边界。

## 7. 提交节奏

建议按可回滚的功能边界提交：

1. `chore: scaffold web collector`
2. `feat: add account and collection schema`
3. `feat: add invite sessions`
4. `feat: parse and secure shared links`
5. `feat: add source adapters and collection service`
6. `feat: add collection workspace`
7. `feat: add personal and public feeds`
8. `test: cover web collection journey`

## 8. 完成标准

- 四类来源的直链和典型整段分享文本均可从 Web 正确处理。
- 不要求用户填写“为什么值得看”。
- 公开/私密状态在提交前、回执和我的收藏中一致。
- unsafe、ambiguous 和 unresolved 短链不会误公开。
- 同一账号重复收藏不重复背书，不改变既有私密状态。
- 两个并发相同链接只生成一条 Content。
- 同一个幂等键携带不同 payload 时明确返回 409，不复用旧结果。
- 元数据或摘要失败不丢收藏。
- `/ai` 只显示当前有效公开 Content，并可直达原文。
- lint、typecheck、unit/integration、e2e 和 production build 全部通过。
- 微信尚未接入，但其未来输入不需要改动 collector domain API。
- 普通直链回执目标 P95 不超过 1 秒；短链目标 P95 不超过 3 秒，超时进入 pending。
