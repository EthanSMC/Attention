# Attention 身份、会员、云端连接与增长机制设计

状态：已确认，作为相关产品与架构决策的当前权威来源

日期：2026-08-04

适用范围：账号注册与登录、Guest/Free/Member 权限、Local/Cloud 边界、同步、Hosted MCP、Skill、Channel 绑定、订阅体验、Consumer 邀请、Filter 年卡兑换与续费积分。

本设计补充并在冲突处取代 [`2026-07-31-attention-v1-design.md`](./2026-07-31-attention-v1-design.md) 中关于身份、会员、MCP 接入和支付边界的旧结论。收藏、Content、Collection、公开资格、去重与内容安全仍以原设计为准。

> 第一版范围已在 [`docs/first-release-scope.md`](../../first-release-scope.md) 统一。本文中的 Hosted Channel、公众号/企业微信绑定和官方 Agent 段落是后续能力；第一期只交付用户自己的 Agent、Skill/MCP、OAuth/API Key，以及本地 iLink Runtime 所需的基础设施，Web 不展示 Hosted Channel。

## 1. 产品原则

1. Attention 的公开发现流本身就是产品展示页，不额外设置阻挡体验的传统营销首页。
2. 账号身份、会员权益、Filter 资格和渠道身份是相互独立的维度，不能压缩成一个角色枚举。
3. 开源本地工具必须可以在没有 Attention 账号时独立工作；云端同步是 Free 能力，托管 AI、完整内容网络和会员级检索/订阅是 Member 能力。第一期不提供 Attention 托管 Channel。
4. Hosted MCP 的协议和端点对外开放，实际工具能力由账号权益决定；开放连接不等于所有托管能力免费。
5. 登录、OAuth、API Key 和微信 `openid` 是不同凭据，不复用 token、表或生命周期。
6. 裂变权益使用可审计的 grant、referral 和 points 账本，不通过覆盖一个 `member_enabled` 布尔值实现。

## 2. 产品入口与公开展示

### 2.1 产品即展示页

- `/ai` 是默认公开产品入口，直接展示真实的 AI Domain 瀑布流。
- 游客与 Free 账号只能浏览前 `public_feed_preview_limit` 张公开卡片。
- `public_feed_preview_limit` 是服务端配置，默认值为 `20`，不能写死在前端。
- 该限制按 Domain 的当前公开排序结果计算：同一 Domain 中只有排名前 `N` 的 Content 属于预览窗口，不因分页、会话、账号或查询次数重新计数。
- 超过限制后，服务端不返回真实标题、来源、摘要或其他可恢复的内容字段。
- 第 `N + 1` 位显示全宽会员说明卡，后面可显示 2–3 张不含真实内容的锁定轮廓。
- 会员说明卡使用“解锁完整发现”，不能承诺“免费注册后继续看”，因为 Free 仍受相同公开流限制。

### 2.2 公开会员展示页

- `/membership` 无需登录即可访问，并直接公开价格。
- 第一屏展示 Free 与 Member 两张方案卡；详细能力对照放在其后。
- Free 的核心表述是“建立并同步自己的收藏库”。
- Member 的核心表述是“让 AI 和内容网络替你整理、发现与调用”。
- 站内升级保留当前 Domain、视图模式、滚动位置和原始 intent；支付完成后回到原操作，不统一跳转首页。

## 3. 身份与权益模型

### 3.1 平台状态与本地模式

| 状态 | 是否有平台账号 | 数据位置 | 核心能力 |
| --- | --- | --- | --- |
| Local only（使用模式） | 可选 | 仅本地 | 开源 Core、CLI、Local MCP、Skill、本地处理与检索 |
| Guest | 否 | 无私人云端数据 | 浏览公开流前 `N` 张、打开可见卡片原文 |
| Free | 是 | 本地与个人云端收藏 | 不限量收藏、云端同步、Hosted MCP 个人收藏能力 |
| Member | 是 | 本地 + Attention Cloud | 完整公开流、托管 AI、筛选订阅、Member 专属 MCP 能力 |

Local only 不是与 Guest/Free/Member 互斥的套餐，而是一种运行模式：未注册者可以只在本地使用，Free 或 Member 也可以继续运行本地工具。一个没有连接云端的本地实例从平台视角没有可识别账号，也不受平台账号生命周期约束。

### 3.2 Filter 与 Consumer

- Filter 是受邀的公开供给资格，不是会员套餐。Filter 的新收藏默认公开，历史收藏的隐私选择不因身份变化而改变。
- 有效 Filter 自动获得完整 Member 能力，来源记录为独立 `filter_grant`；移除 Filter 只撤销该来源，不影响购买、兑换或其他 grant。
- Consumer 在增长机制中是内部 referral 术语；新用户邀请面向所有 active 注册账号，包括 Free、Member 和 Filter。
- Filter 年卡额度与 Consumer 邀请额度是不同机制，不能复用同一种 invitation。
- Consumer 邀请额度由服务端配置；账号页显示已成功邀请数与总名额，文案不写死具体人数。

### 3.3 能力矩阵

| 能力 | Guest | Free | Member | Filter |
| --- | --- | --- | --- | --- |
| 浏览公开流前 `N` 张 | 是 | 是 | 是 | 是 |
| 浏览 `N` 张之后的公开流 | 否 | 否 | 是 | 是 |
| 打开当前可见卡片原文 | 是 | 是 | 是 | 是 |
| 不限量收藏自己的链接 | 否 | 是 | 是 | 是 |
| 云端同步 | 否 | 是 | 是 | 是 |
| 基础确定性链接识别与元数据 | 否 | 是 | 是 | 是 |
| 复用已经存在的公开 AI 摘要 | 仅可见卡片 | 是 | 是 | 是 |
| 为新私人链接触发托管 AI | 否 | 否 | 是 | 是 |
| 托管/云端搜索、筛选与订阅 | 否 | 否 | 是 | 是 |
| Hosted MCP 个人收藏工具 | 否 | 是 | 是 | 是 |
| Hosted MCP 托管 AI/完整公共网络能力 | 否 | 否 | 是 | 是 |
| 企业微信、公众号等 Hosted Channel | 后续 | 后续 | 后续 | 后续 |
| 向公共瀑布流供给 | 否 | 否 | 否 | 是 |

Free 新收藏默认私密，也不会因为本地同步而批量公开。Filter 第一次把本地历史收藏同步到云端时同样全部默认私密；同步完成后的新单条收藏再遵循 Filter 默认公开规则。

### 3.4 学生权益

学生权益不属于首期实现。未来使用独立 `student_grant` 提供在校期间的 Member 能力，不创建新的账号类型；认证周期与失效规则由届时选定的认证能力决定。

## 4. 注册与登录体验

### 4.1 统一入口

注册与登录共用同一个邮箱入口：

```text
输入邮箱 -> 输入验证码 -> 已有账号登录 / 新账号自动创建
```

- 新账号验证成功后立即成为 Free。
- 创建账号时不要求设置密码、填写展示名、选择兴趣或绑定微信。
- 系统生成不可预测且唯一的内部 handle，例如 `user-482731`，默认展示名可对应显示为 `用户482731`；内部 handle 不对用户展示，用户可在“我的”中修改展示名并按需设置 Attention ID。
- 内部不可变 `account_id` 是身份主键，handle 和展示名都不是登录凭据。handle 修改、旧地址跳转和保留期在账号技术规格中定义。
- 用户可在账号安全设置中添加密码，登录页提供较弱的“使用密码登录”切换入口。
- 首次创建账号时明确展示用户协议和隐私政策。

### 4.2 站内与站外承载

- 从瀑布流收藏、升级或顶部登录进入时，桌面端使用居中浮层，移动端可使用全屏 sheet，保持当前页面上下文。
- Local Channel Runtime 授权/配对链接、CLI 登录、Hosted MCP OAuth 等站外入口使用独立 `/auth` 页面。
- 两种承载复用同一个认证组件和账号规则。
- 登录 intent 使用服务端 continuation，至少记录 `intent_type`、安全校验后的 `return_to`、发起时间、过期时间和一次性消费状态。
- 登录完成后继续原来的收藏、升级、授权或绑定动作。

### 4.3 Browser Session

- 网站登录成功后签发服务端可撤销的 opaque session，并通过 `HttpOnly`、`Secure`、`SameSite=Lax` Cookie 传递。
- Session 只证明浏览器身份，不修改会员或 Filter 权益。
- 日常登录不能复用会授予角色或会员的 invitation token。

## 5. Local、Cloud、同步与 MCP

### 5.1 开源边界

开源并可本地独立运行：

- Attention Core。
- CLI。
- 本地 SQLite 与导入导出。
- 基础确定性链接处理与本地检索。
- Local MCP。
- Skill。
- Source Adapter SDK 与本地模型/BYOK 接口。

官方托管服务包括云端同步、公开 canonical 图谱、Filter 网络、完整发现、托管 AI、筛选订阅、Hosted MCP、治理和下架。Hosted Channel 和官方 Agent 不属于第一版。

### 5.2 同步与 MCP 分工

```text
本地 Agent -> Local MCP / CLI -> Sync API -> Attention Cloud
第三方 Agent -----------------> Hosted MCP -> Attention Cloud
```

- Sync API 负责增量同步、游标、批量上传、幂等和冲突处理。
- Hosted MCP 负责 Agent 工具调用，不承担完整的数据复制协议。
- 两者可以共用后端服务、OAuth 和权益判断，但对外合同必须分开。
- 本地 Core 使用 append-only mutation log 与 sync cursor；AI 摘要、标签和向量均视为可重建派生数据。

### 5.3 Hosted MCP 权益

Hosted MCP 是公开可发现、可配置的远程 MCP 服务，但必须认证：

- Free 可连接并操作自己的基础收藏，例如 `content.collect`、`collection.list` 和个人范围的 `content.get`。
- Member 在此基础上获得托管 AI、语义检索、完整公开流、筛选和订阅等账号专属能力。
- Guest 不能连接 Hosted MCP。
- MCP 返回公共流时必须执行与网页相同的 `N` 张限制，不能成为绕过公开流付费墙的接口。
- Free 的 `content.get` 只能读取自己的 Collection，或当前 Domain 预览窗口内本来可见的公共 Content。Free 主动收藏一个已存在的 canonical Content 后，它成为该账号自己的 Collection，可以复用已有公开摘要；客户端不能通过枚举 Content ID 或 URL 批量读取预览窗口之外的公共内容。
- Skill 文本与 MCP schema 公开；付费墙放在托管数据和服务端能力上。

## 6. 凭据与授权

| 场景 | 凭据 | 主要用途 |
| --- | --- | --- |
| 网站 | Session Cookie | 浏览器登录态 |
| CLI 云同步 | OAuth Authorization Code + PKCE | Free/Member 同步自己的收藏 |
| Hosted MCP | OAuth Authorization Code + PKCE | Agent 代表账号调用 MCP |
| 自动化脚本 | 命名 API Key | 不支持浏览器 OAuth 时的备用方案 |
| 微信 | `wechat_app_id + openid` 绑定 | 将渠道消息映射到 Attention 账号 |
| Local only | 无 | 本地使用，不连接平台 |

授权规则：

- OAuth 优先，API Key 只作为不支持浏览器 OAuth 时的备用入口。
- Skill 不包含 token。
- Access token 必须绑定 audience/resource 与 scopes；客户端不能提交任意 `account_id`。
- Token 只证明身份和授权范围，服务端每次调用仍检查实时 Free/Member/Filter 权益。
- API Key 只有一种，可命名、设置有效期、独立吊销和轮换；客户端不能为 Key 选择产品权限。原文只展示一次，服务端只保存安全哈希、前缀和生命周期元数据。
- API Key 只证明账号身份；服务端每次调用都按账号当前 Free/Member/Filter 权益计算有效能力。账号升级、降级或 Filter 资格变化后，无需更换 Key。
- API Key、网站 Session、微信绑定和 OAuth grant 相互独立，吊销一种凭据不能隐式改变其他凭据。
- Sync API 与 Hosted MCP 是不同 resource server；具体 scope、token audience、refresh token 和多 resource 授权交互由后续 OAuth 技术规格固化。

## 7. Agent 加载体验

### 7.1 Local only

用户可以直接从开源仓库安装 CLI、Local MCP 与 Skill，不需要访问 Attention 网站或创建账号。

### 7.2 连接 Attention Cloud

```text
我的 -> 连接 Agent -> 选择 Codex / Claude 等客户端
-> 复制安装指令给 Agent
-> Agent 安装开源 Skill 与客户端配置
-> 浏览器完成登录与 OAuth 授权
-> 自动配置 Hosted MCP
-> 执行连通性测试
```

- Free 完成后获得账号允许的 Hosted MCP 个人收藏能力与云同步。
- Member 同一连接自动获得账号新增能力，不需要重新生成 token 或 API Key。
- 完成页分别显示“Skill 已安装”“Hosted MCP 已连接”“同步正常”。
- 不支持 OAuth 的客户端可以在连接设置中创建同一种 API Key。

## 8. 后续 Hosted Channel 与微信绑定

本节不是第一版交付范围。第一期的微信路径是用户自己的 Agent / iLink 在本地接收消息，再通过 Attention Skill + MCP 调用 Core；Attention 不托管模型、消息会话或 iLink 凭据。Local Channel Runtime 的安装、授权和运行时审计边界见 [`本地 Agent 与微信 Channel 一期设计`](./2026-08-07-local-agent-channel-runtime-design.md)。

在未来启用 Hosted Channel 时，它才会作为 Member 能力；Free 可以注册、收藏、同步和使用账号允许的 Hosted MCP 个人收藏能力，但第一期平台不为任何账号托管企业微信、公众号等消息入口。

微信首次发送消息时：

```text
收到未绑定消息
-> 创建短期 pending request 与一次性绑定 intent
-> 返回绑定链接
-> 用户完成统一登录
-> Free 用户先查看并开通 Member
-> 展示目标展示名与 Attention ID（如已设置）
-> 用户明确确认
-> 建立 ChannelIdentity
-> 自动继续处理原消息
```

- `openid` 是 Channel Identity，不是网站登录账号；`unionid` 仅作为可选辅助标识。
- Bind intent 初始只绑定 `wechat_app_id + openid` 和 pending request，不能提前绑定目标 `attention_account_id`。
- 目标账号必须在确认时由当前已认证 Web Session 推导。
- Pending request 建议保留约 10 分钟并只消费一次；超时后提示用户重新发送。
- 已经绑定其他账号时不能静默换绑。
- 普通网站注册不主动要求绑定微信；未来 Local Channel Runtime 若需要显式绑定，再从独立 Runtime 控制面进入，不把微信绑定塞进注册流程。

## 9. 订阅与增长机制

### 9.1 三条获客路径

账号注册来源只区分：

- `direct`：用户自己进入 Attention 完成注册。
- `consumer_referral`：用户通过 Consumer 邀请链接完成注册。

Filter 年卡是注册后可兑换的独立 grant，不改变 `signup_source`，也不建立返积分关系。

### 9.2 自主注册的新客订阅体验

只有 `signup_source = direct` 的新客户在首次开通并绑定订阅时触发：

```text
自主注册成为 Free
-> 首次绑定订阅
-> 获得 3 个月 Member 体验
-> 体验结束后按公开价格收费
```

- 开通前明确展示首次扣费日期、金额和自动续费规则。
- 体验期内允许取消；取消后保留权益至体验结束。
- Consumer 邀请注册用户不获得这项自主注册体验。
- 自主注册用户即使曾兑换 Filter 年卡，仍保留首次订阅的 3 个月体验资格；体验期顺延到既有 grant 之后，不能与既有会员月份重叠浪费。
- 资格是账号级 exactly-once：只有第一次绑定真实付费订阅的可信 provider 事件可以触发；Webhook 重试、重新订阅或更换支付方式不能再次生成体验。

### 9.3 新用户邀请（Consumer referral）

- 新用户邀请的创建者必须是当前 `active` 的注册账号，包括 Free、Member 和 Filter；每个账号的成功邀请次数受服务端配置的名额限制。
- 邀请使用唯一链接；只有新用户通过该链接完成注册才生效。
- 每次成功注册消耗一个邀请名额；过期、失效或被替换的链接不消耗成功名额。
- 注册成功后，被邀请者获得 3 个月 Member，邀请者获得 3 个月 Member 延期。
- 已有账号打开链接不能补绑邀请关系。
- 一个邀请链接成功注册一次后即失效，邀请关系不可改绑。
- 邀请奖励不要求被邀请者先绑定支付方式。
- 被邀请者后续发生真实现金续费时，直接邀请者获得实付价值 15% 的续费积分。
- 返积分只存在一层，不向邀请链上游继续分配。
- 邀请者成为或保持 Filter 不影响未使用 Consumer 链接；Filter 年卡签发是独立能力，不改变新用户邀请资格。
- Consumer 链接默认 30 天到期，可由服务端环境变量在 1 至 365 天内配置。

Consumer 季卡按注册即时生效。若邀请者当前是 Free，则立即进入 3 个月 Member；若已有 Member，则在当前有效期后顺延 3 个月。

### 9.4 Filter 年卡兑换

- 每位有效 Filter 每个 UTC 自然年累计最多签发 5 个单次年卡兑换码；兑换码过期、撤销或未使用都不补回当年额度。
- 兑换码可以发送给新用户、现有 Free 或现有 Member；Member 兑换后在当前有效期后顺延。
- 兑换后直接获得或顺延 12 个月 Member。
- Filter 年卡是纯兑换，不要求绑定订阅，不建立邀请关系，不产生返积分。
- Filter 不因兑换获得自己的会员延期或积分。
- Filter 不能兑换自己签发的年卡。
- 原始兑换码只展示一次，服务端只保存安全哈希。
- 每个兑换码只能使用一次，并具有明确有效期。
- Filter 被移除后，未兑换的码作废；已经兑换的权益保留。
- 兑换码默认 30 天到期，可由服务端环境变量在 1 至 90 天内配置。

### 9.5 续费积分

- 积分只在被邀请者发生真实现金续费后产生；Consumer 季卡结束后的第一笔实际现金收费即属于这里的续费。
- 基数为退款、拒付、优惠和积分抵扣之后的实际现金支付价值；税费是否计入由支付实现与法务确认。
- 邀请者获得基数的 15%。
- 积分只能抵扣 Attention 后续续费，不能提现、转让或赠送。
- 退款或拒付按原结算事件撤销对应积分；可用余额、预留余额与账面余额始终不得为负。若积分已使用，以单独的非负 `clawback` 待抵扣额审计，并由后续奖励优先偿还。
- 使用积分支付的部分不再次产生积分，避免循环放大。
- 邀请者当前不是 Member 时积分仍保留，可在重新开通或续费时使用。

### 9.6 Grant 叠加规则

- 季卡、年卡、直接注册体验和付费订阅都写入独立账本，不覆盖历史记录。
- 有固定时长的新 promotional grant 在账号当前 Member 有效期之后顺延，不能因同时发放而重叠浪费。
- 固定月份按 UTC 日历月计算；目标月份没有原日期时夹到该月最后一天，并保留原 UTC 时分秒。
- `filter_grant` 是跟随 Filter 有效状态即时生效、即时撤销的动态权益，不排队、不延长付费订阅，也不消耗其他固定时长 grant。
- 订阅首次扣款时间必须考虑尚未消费的有效 grant。
- Free 表示 active account 当前没有有效 Member grant 或付费订阅，不需要单独账号类型。
- Consumer 邀请注册不获得自主注册体验；Filter 兑换不改变 direct 用户的首次订阅体验资格。

## 10. 建议数据模型

### 10.1 Account

- `id`
- `primary_email`
- `email_verified_at`
- `password_hash`：可空
- `stable_handle`：系统生成、不可变、仅内部使用，不进入公开 DTO 或页面
- `attention_id`：可空的公开账号标识；6–20 位、字母开头，仅小写字母、数字、`_`、`-`
- `attention_id_changed_at`：首次设置后每 365 天最多修改一次；既有账号不从 `stable_handle` 回填
- `display_name`
- `signup_source`：`direct | consumer_referral`
- `status`
- `created_at`

### 10.2 MembershipGrant

- `id`
- `account_id`
- `kind`：`filter_grant | direct_trial | consumer_invitee_quarter | consumer_inviter_quarter | filter_annual_redemption | admin_grant`
- `source_id`
- `starts_at`
- `ends_at`
- `status`
- `created_at`
- `revoked_at`
- `revocation_reason`

同一账号和同一种 `kind` 可以存在多条合法记录，不能沿用 `(account_id, source)` 唯一约束。

例外：`direct_trial` 每个账号终身最多一条，必须以首次订阅或支付 provider 事件作为幂等来源；Webhook 重试、取消后重新订阅或更换支付方式不能生成第二次体验。

### 10.3 Subscription

- `id`
- `account_id`
- `provider`
- `provider_customer_id`
- `provider_subscription_id`
- `status`
- `intro_eligible`
- `first_charge_at`
- `current_period_start`
- `current_period_end`
- `cancel_at_period_end`
- `cancelled_at`

### 10.4 ConsumerReferral

- `id`
- `inviter_account_id`
- `invite_token_hash`
- `invitee_account_id`
- `status`
- `issued_at`
- `expires_at`
- `registered_at`

成功状态下必须保证 `invitee_account_id` 全局唯一，且邀请人与被邀请人不能相同；同一 `inviter_account_id` 可以在配置额度内拥有多条成功 referral。一个账号可以先作为 invitee 注册，之后再作为 inviter，不受上述约束误伤。

### 10.5 FilterRedemptionCode

- `id`
- `filter_account_id`
- `token_hash`
- `grant_year`
- `status`
- `expires_at`
- `redeemed_by_account_id`
- `redeemed_at`

兑换时必须校验 `redeemed_by_account_id != filter_account_id`，并以 `grant_year + filter_account_id` 限制当年累计签发数量，而不是限制某一时刻仍 active 的码数。

### 10.6 GrowthBillingEvent、PointsBalance 与 PointsLedger

- `GrowthBillingEvent` 以 `provider + provider_event_id` 全局幂等，记录 `paid_subscription_bound | renewal_settled | renewal_refunded | renewal_chargeback`、原结算事件、真实现金 minor units、币种、referral 与积分结果。
- `PointsBalance` 按 `account_id + currency` 唯一，维护非负 `available_minor`、`reserved_minor` 与 `clawback_minor`；它是不可变流水的并发安全投影，不是无审计的可覆盖余额。
- `PointsReservation` 以账号内 idempotency key 唯一，状态为 `reserved | released | consumed`，预留和最终消费都必须持有余额锁且不能透支。
- `PointsLedgerEntry` 的 `entry_type` 为 `earn | reversal | reserve | release | consume`，同时记录三个余额分量的 delta 与 after snapshot，并以 billing event 或 reservation 作为幂等来源。
- 所有金额使用同币种 minor units；15% 使用 `floor(cash_minor * 15 / 100)`。赠送 grant、积分抵扣和其他非现金价值不进入现金基数。

### 10.7 ChannelIdentity 与 BindIntent

- `ChannelIdentity`：`provider + app_id + subject_id(openid) -> account_id`。
- `BindIntent`：渠道身份、pending request、token hash、状态、过期时间和确认时间；创建时不包含由用户输入的目标账号。

### 10.8 OAuth 与 API Key

- OAuth client、authorization grant、access/refresh token 元数据和撤销状态独立保存。
- API Key 使用独立 `ApiCredential`，不能与 OAuth token 或 Browser Session 共表复用。所有 Key 类型相同，产品能力不固化在 Key 上。

## 11. 安全与滥用边界

- Consumer 邀请只认通过链接完成的首次注册，不接受注册后补填邀请码。
- 邀请人与被邀请人不能是同一账号；服务条款允许对明显的批量账号、自邀和自动化套利撤销 promotional grant。
- 注册必须完成邮箱验证；设备、网络和后续支付方式信号可用于风险判断，但不能把邮件地址当作唯一自然人证明。
- Filter 不能兑换自己签发的年卡；明显的转售、批量代兑或关联账号套利可以撤销未消费权益并进入人工复核。
- Filter 兑换码、Consumer 邀请 token、Bind intent 和登录验证码都必须随机、短期或有明确期限、只存哈希并支持撤销。
- 15% 积分只从真实结算事件产生，不能由客户端、MCP 或管理员前端直接上报“续费成功”。
- 所有 grant、积分、订阅和兑换状态变化写入审计事件。

## 12. 验收场景

### 12.1 身份与公开流

- Guest 和 Free 请求当前 Domain 排名第 `N + 1` 张及之后的公开内容时，响应中不存在真实锁定内容字段。
- 新邮箱通过验证码后创建 Free 账号和随机展示名，不要求设置密码。
- 已有邮箱走相同入口并创建新 Session，不修改权益。
- 登录、付费或 OAuth 完成后能安全恢复原 intent。

### 12.2 同步与 MCP

- Local only 在无网络、无账号时可以收藏、查询和导出。
- Free 通过 OAuth 或 API Key 使用账号允许的同步与 Hosted MCP 能力。
- Free 不能通过 MCP 读取第 `N` 张之后的公共流，也不能触发 Member AI 工具。
- 账号升级后原 OAuth 连接和 API Key 自动获得服务端允许的新能力；降级后实时失去对应能力。
- API Key 吊销不影响网站 Session、微信绑定或其他 OAuth 客户端。

### 12.3 Channel

以下规则属于未来 Hosted Channel，不是第一期 Web 或 Local iLink 的用户入口。

- 未绑定微信消息只创建 pending request，不执行私人收藏。
- 登录与开通 Member 后，用户明确确认绑定并自动继续原消息。
- 绑定 intent 过期、重复消费或账号冲突时不能静默换绑。
- Free 账号不能使用 Hosted Channel，但不影响其 Web 收藏、同步和账号允许的 MCP 能力。

### 12.4 增长机制

- 每个 Consumer 链接只对一个通过它注册的新账号生效；成功注册消耗邀请人的一个名额，双方各获得一个季度且不重叠浪费。
- Consumer 邀请注册账号不会获得 direct 三个月订阅体验。
- direct 账号兑换 Filter 年卡后仍保留首次订阅体验，并在年卡后顺延。
- Filter 每个 UTC 自然年累计最多签发 5 个兑换码，过期或撤销不补额度；单个码不能重复使用或由签发者自兑。
- Filter 兑换不产生 referral 或积分。
- 只有已结算现金续费产生 15% 积分，退款和拒付可完整冲正。

## 13. 待后续确定

- Member 具体价格、按月/按年周期和支付服务商。
- 积分有效期、单次续费最大抵扣比例和跨币种价值规则。
- 自动续费、扣款提醒、退款和消费者保护的地区化合规实现。
- 学生认证供应商、复核周期与毕业失效规则。
- 邮箱验证码有效期、重发与限流、邮箱更换、密码重置、账号恢复和重复账号合并规则。
- OAuth 的精确 scopes、resource/audience、refresh token、安全存储和无图形环境授权方式。
- 同一微信身份的并发 pending request、失败重试、显式换绑及会员到期后的 Channel 回复规则。
- 订阅扣款中途获得新 grant 时的真实支付商账单调整方式。
