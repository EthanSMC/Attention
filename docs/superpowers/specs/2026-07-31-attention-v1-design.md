# Attention V1 产品设计

状态：收藏与内容部分已确认；身份、会员、MCP 鉴权、Channel 绑定与增长部分已被 2026-08-04 设计取代

日期：2026-07-31

首个交付切片：多来源收藏工具

> 2026-08-04 更新：账号注册登录、Guest/Free/Member 权限、公开流预览限制、Local/Cloud、OAuth、Hosted MCP、Channel、订阅体验与裂变机制，现以 [`2026-08-04-attention-identity-membership-growth-design.md`](./2026-08-04-attention-identity-membership-growth-design.md) 为准。本文件中与其冲突的角色表、游客访问范围、API Key-only 接入和“支付不在 V1”描述仅保留为首个收藏切片的历史上下文。

## 1. 一句话定义

Attention 是一个由受邀 filter 公开收藏链接、由系统自动整理，并供人和 AI 浏览、订阅与检索的信息层。

这里的“收藏”只表示 filter 认为内容值得保留或可能有用，不表示 filter 已经读完、完全认同或强烈推荐。

## 2. 产品判断

Attention 不与微信收藏、文件传输助手或浏览器书签比“保存链接”本身。它提供的不可替代回报是：

1. 一次收藏自动变成结构化、可找回的知识条目。
2. 同一条内容可被其他人看见，也可进入 AI 的检索结果。
3. 收藏者不需要补写“为什么值得看”，系统自行完成来源识别、摘要、标签与归类。
4. 内容仍然归原站承载，Attention 只保存链接和必要的派生信息。

V1 只做 AI 一个 Domain，先证明下面这条闭环：

`发送链接或平台分享文案 → 自动识别真实内容 → 收藏成功 → 生成卡片 → 进入公开瀑布流或私人收藏 → Email/MCP 再发现`

## 3. V1 目标

### 3.1 产品目标

- 让 filter 用接近“发给文件传输助手”的成本完成收藏。
- 接收抖音、小红书、微信公众号和普通网页等不同来源。
- 同时支持原始链接、短链接、整段平台分享文案和微信链接卡片。
- 将有效公开收藏自动变成 AI Domain 中的一张卡片。
- 让会员通过搜索、筛选、Email 和 MCP 找回有用内容。
- 为每条公开内容分别记录过滤后的原文跳转量与 AI 检索返回量。

### 3.2 首个交付切片目标

第一阶段交付一个可实际使用的收藏纵向切片，不等待 Email 和 MCP 上线：

1. Web 入口可接收原始链接和整段平台分享文案。
2. 正确识别输入中的目标链接和来源。
3. 建立 Content 与 Collection，完成公开/私密判断和确定性去重。
4. 立即返回清晰回执。
5. 异步补全元数据、AI 摘要和标签；补全失败不丢收藏。
6. 提供“我的收藏”，可查看处理状态、打开原文，并由 Filter 管理公开/私密。
7. 提供最小 `/ai` 公开流，让公开收藏完成从供给到消费的闭环。
8. 收藏内核保持渠道无关，为后续微信入口复用同一 Input Envelope 和处理流水线。

### 3.3 非目标

V1 不做：

- 推荐算法、学习曲线或个性化难度排序。
- 热门排序、阅读完成度或“已读”状态。
- 金融等第二个 Domain。
- 按人物、公司、对象或 filter 订阅。
- Bundle、跨语言合并、转载/解读的语义合并。
- 评论、关注、私信等社交能力。
- 全文阅读器、原文缓存、付费墙绕过或原站图片搬运。
- 基于全文的完整问答。
- 在线支付、真实分账与提现。
- 以 AI 相似度自动合并两条内容。

## 4. 核心概念

### 4.1 Content

Content 是去重后的内容对象，代表一个可访问的原始链接及其派生元数据。一条 Content 可以被多人收藏。

### 4.2 Collection

Collection 是“某个用户收藏了某条 Content”的关系，包含公开状态和收藏时间。同一个用户对同一条 Content 只保留一条 Collection。

### 4.3 Filter

Filter 是受邀的公开供给者。其收藏默认公开，但可在微信回执或 Web 中切换为私密。稳定网名即可，不要求实名。

### 4.4 Domain

Domain 是相互独立的信息圈。V1 只存在 `AI` Domain。未来金融 Domain 与 AI Domain 分开运营、排序与订阅。

### 4.5 收藏与背书

公开收藏是一种弱背书：它给消费者提供“看到这条内容的机会”。产品文案不得把它解释成“读完推荐”“事实认证”或 filter 对全部观点负责。

## 5. 角色与权限

> 本节的旧角色表和支付边界已废弃。当前 Guest/Free/Member/Filter 能力矩阵见 [`2026-08-04-attention-identity-membership-growth-design.md`](./2026-08-04-attention-identity-membership-growth-design.md#33-能力矩阵)。

角色能力不是一个互斥枚举，而是三个独立维度：

- 账号身份。
- 会员权益。
- Filter 权限。

| 能力 | 游客 | 会员 | Filter |
| --- | --- | --- | --- |
| 浏览公开瀑布流 | 是 | 是 | 是 |
| 打开原文 | 是 | 是 | 是 |
| 查看 Filter 公开主页 | 是 | 是 | 是 |
| 搜索与标签筛选 | 否 | 是 | 是 |
| 私人收藏 | 否 | 是 | 是 |
| AI Domain 每日 Email | 否 | 是 | 是 |
| 公共知识库与个人收藏 MCP | 否 | 是 | 是 |
| 向公共瀑布流供稿 | 否 | 否 | 是 |
| 管理自己收藏的公开状态 | 否 | 私密收藏无需切换 | 是 |

受邀 Filter 自动获得完整会员能力，保证供给者能直接获得搜索和个人 MCP 的回报。管理员可邀请或移除 Filter、处理举报、屏蔽危险链接和合并标签。

支付系统不在 V1 内；早期会员权益由后台授予。数据模型保留会员权益边界，避免未来接入支付时重构权限。

角色变化不改变历史隐私选择：

- 普通会员被邀请为 Filter 后，历史私人收藏仍然私密；只有之后的新收藏默认公开。
- Filter 被移除时，其所有公开 Collection 立即失去公共资格，但历史事件和私人收藏保留。
- 重新邀请不会自动恢复旧公开 Collection，必须由本人重新公开并生成新的 `public_since`。
- Filter 自动获得的会员权益单独标记为 `filter_grant`；移除 Filter 时只撤销这项权益，独立购买或授予的会员权益不受影响。

## 6. 收藏入口与默认行为

### 6.1 Web 入口

Web 提供粘贴输入框并复用完全相同的处理流水线：

- Filter 默认公开，可在提交前或提交后切换为私密。
- 普通会员只保存为私密。
- Web 收藏与微信收藏没有内容语义上的差异。

Web 是首个实际交付入口。抖音、小红书、公众号和普通网页的适配器先全部通过 Web 输入完成开发与验收。

### 6.2 微信入口（后续）

微信相关账号、平台配置和接入流程不阻塞 Web 版本。条件具备后使用官方微信公众号能力作为微信入口，不使用非官方个人号机器人。

同一个入口按已绑定账号能力决定行为：

- 已绑定 Filter：通过 Channel 权益检查，默认公开收藏，并返回“改为私密”入口。
- 已绑定 Member：通过 Channel 权益检查，保存为私人收藏。
- 已绑定 Free：不执行 Channel 收藏，返回会员展示与升级入口，并短期保留 pending request。
- 未绑定用户：不保存，返回账号绑定链接；登录、开通 Member 并确认绑定后可在有效期内继续 pending request。

### 6.3 默认公开的安全例外

默认公开不能覆盖安全判断。下列输入不得直接公开：

- 非 HTTP(S) 链接。
- localhost、私网、内网或云元数据地址。
- URL 中明显包含访问令牌、临时签名、账号凭证或私密分享密钥。
- 被安全策略或管理员列入阻断名单的来源。

对于可确认是私密凭证链接的输入，系统拒绝抓取并提示用户，不建立 Content 或 Collection，只保留脱敏安全审计；不通过“先公开再撤回”的方式处理。

## 7. 支持的输入形态

收藏工具不能依赖某个平台固定的一句分享文案。系统首先提取 URL，再由来源适配器识别内容。

首批必须支持：

1. 抖音原始内容链接。
2. 含抖音短链接的整段复制分享文案。
3. 小红书原始内容链接。
4. 含小红书短链接、文字、话题或 Emoji 的整段复制分享文案。
5. 微信公众号文章原始链接。
6. 转发给公众号入口的微信链接卡片。
7. 含公众号文章链接的文本。
8. 任意普通 HTTP(S) 网页链接。
9. 含一个可识别网页链接的普通分享文本。

系统对平台文案只做 URL 提取，不把“复制后打开 App”等模板文字当成内容摘要或用户评价。

## 8. 多来源采集架构

本节描述的候选提取、来源识别和安全解析属于 Attention Agent 的链接解析能力。网页和微信 Channel Adapter 只产生统一 `InputEnvelope`；Agent 根据意图调用这些内部能力及受控 Web/Browser MCP，然后通过 Attention MCP 提交收藏。渠道入口不得分别实现一套解析器。

### 8.1 Input Envelope

每次输入先统一为 `InputEnvelope`：

- `channel`：wechat 或 web。
- `sender_account_id`：已绑定账号。
- `channel_message_id`：微信消息 ID 或 Web 幂等键。
- `payload_type`：text、link_card 或 url。
- `raw_payload`：仅用于本次解析的原始载荷。
- `received_at`：服务端接收时间。
- `parser_version`：解析器版本。

整段分享文案可能含聊天上下文或个人信息，因此不得长期保存。处理完成后只保留消息 ID、输入的服务端 HMAC、解析版本、候选数量、最终安全地址和必要的错误码；无效或危险候选只保留不可逆指纹与脱敏主机名。原始载荷只存在于同步解析所需的短生命周期内，不进入失败队列、异常追踪或备份；日志对 token、签名参数和文本内容脱敏。

### 8.2 URL 候选提取

`LinkCandidateExtractor` 按以下顺序工作：

1. 若输入是微信链接卡片，读取卡片 URL，同时保留可用的标题与描述作为低可信元数据。
2. 从文本中提取全部 HTTP(S) URL。
3. 清除零宽字符和包裹 URL 的中文/英文标点，不改动 URL 内部有效字符。
4. 合并完全相同的候选 URL。
5. 过滤已知 App 下载、活动跳转和纯追踪链接。
6. 对短链接执行受限、安全的重定向解析。
7. 将解析结果交给来源适配器评分。

当存在一个高可信内容目标时，系统无感处理。若存在多个不同的高可信内容目标，系统不擅自公开，也不创建 Content 或 Collection，而是返回候选供用户选择：选择凭证是绑定账号和本次输入的 opaque token，24 小时后失效且只能成功消费一次；渠道重试在有效期内返回同一候选状态。若不存在有效目标，返回可理解的失败原因。

### 8.3 Source Adapter

采集核心提供统一的 `SourceAdapter` 接口，首批适配器为：

- `douyin`
- `xiaohongshu`
- `wechat_official_article`
- `generic_web`

每个适配器负责：

- 判断 URL 是否属于该来源。
- 区分内容页、短链、下载页和营销页。
- 解析安全重定向后的真实目标。
- 生成来源名称和内容类型。
- 按平台规则产生 normalized URL 与 canonical URL。
- 在来源允许且可访问时提取标题、作者、发布时间等元数据。

域名和路径规则放在可版本化配置中。平台改变分享域名或链接结构时，只更新适配器和配置，不修改收藏核心流程。

`generic_web` 是兜底适配器。平台专用适配失败时，只要最终 URL 安全有效，仍可作为普通网页保存，不因摘要或作者提取失败而丢弃收藏。

### 8.4 安全重定向解析

服务端访问用户提供的 URL 前必须执行：

- 仅允许 HTTP(S)。
- 每一跳都重新做 DNS、IP 与协议校验，防止 SSRF 和 DNS 重绑定。
- 禁止访问私网、回环、链路本地和云元数据地址。
- 限制重定向次数、连接时间、响应时间和最大响应体。
- 只接受允许的内容类型，不下载可执行文件或任意大文件。
- 对跳转链和最终地址执行危险域名检查。

### 8.5 解析结果

一次采集返回以下状态之一：

- `accepted`：新收藏已建立。
- `already_collected`：该用户已经收藏，幂等返回原结果。
- `merged_with_existing_content`：新 Collection 关联到已有 Content。
- `ambiguous`：有多个真实内容候选，需要用户选择。
- `resolution_pending`：短链接目标暂时无法确定，未建立 Content 或 Collection，系统在受限次数内异步重试。
- `invalid`：没有有效 HTTP(S) 内容链接。
- `unsafe`：链接触发安全策略。

安全的普通直链即使网络暂时不可达或元数据抓取失败，也返回 `accepted`。无法确定安全最终目标的短链接不能公开，只能保持 `resolution_pending`，重试耗尽后明确通知失败。来源识别、页面抓取和 AI 补全是独立 enrichment 状态，不得把普通抓取失败改写为收藏失败。

## 9. 收藏处理流水线

### 9.1 同步路径

为了让操作接近“发给文件传输助手”，同步路径只做必要工作：

1. 账号绑定与权限判断。
2. 输入幂等检查。
3. URL 候选提取和安全检查。
4. 短链接解析与来源识别。
5. Content 确定性查重。
6. 建立或复用 Content。
7. 建立 Collection，并按角色写入公开状态。
8. 返回回执。

### 9.2 异步路径

收藏成功后异步执行：

1. 获取可公开访问的页面元数据。
2. 计算规范 URL 和受信 canonical URL。
3. 必要时创建可审计的 canonical 合并候选，并按第 10 节规则处理。
4. 临时读取正文生成短摘要、标签和向量。
5. 发布或更新卡片。

抓取失败时保留卡片，能取得多少信息就显示多少，并标记“暂时无法生成摘要”。系统不能仅凭一次抓取失败判断原链接已经失效。

### 9.3 微信回执

Filter 的成功回执至少包含：

- 已识别的来源和标题；标题未知时显示域名。
- “已公开收藏”状态。
- “改为私密”入口。
- “在 Web 查看”入口。

普通会员显示“已保存到我的收藏”。重复提交显示“已经收藏过”，不制造第二次收藏或背书。

重复提交永远不改变 active Collection 的可见性。尤其 Filter 再次发送一条已私密收藏的链接时，系统仍返回“已私密收藏”，并提供显式“重新公开”入口，不能因为 Filter 的新收藏默认值而偷偷公开。若既有 Collection 已被用户删除，再次提交视为新的收藏周期：复用原行并恢复 active、重写 `collected_at`；普通会员恢复为 private，Filter 按本次入口的默认值或显式选择决定 visibility，公开时生成新的 `public_since`。旧周期保留在事件账本。

## 10. URL 规范化与去重

V1 只做可解释、可回滚的确定性 URL 去重。

InputAttempt 保存本次提交的安全解析记录；Content 只保存合并后可稳定访问的目标。核心字段为：

- `selected_url`：本次输入选中的安全候选；危险 URL 不以明文保存。
- `redirect_chain`：本次安全解析得到的脱敏跳转链。
- `outbound_url`：Content 当前用于“查看原文”的稳定原站地址，不使用 Attention 详情页替代。
- `normalized_url`：按来源适配器规范化后的地址。
- `canonical_url`：页面声明且通过信任校验的 canonical，或 normalized URL。
- `dedupe_key`：由适配器版本化的稳定身份规则生成，用于数据库原子 upsert。

规则：

- 相同可信 canonical URL 合并为一条 Content。
- 平台专用适配器决定哪些查询参数构成文章身份，不能用全局规则粗暴删除所有参数。
- 页面声明的跨域 canonical 默认不接受，除非适配器明确允许。
- 转载、翻译、视频改写和解读保持独立卡片。
- 标题相同或 AI 判断相似不能触发自动合并。
- canonical 合并保留审计记录，并允许管理员拆分。
- 同一用户与同一 Content 的 Collection 有唯一约束。
- 多个提交合并后仍保留各自的 InputAttempt 审计记录，但卡片统一跳转到当前可信 `outbound_url`。
- 同步查重通过数据库唯一 `dedupe_key` 和原子 upsert/锁完成，不能用“先查再插”的非原子流程；异步发现的 canonical 等价关系再进入下述合并流程。

异步 canonical 合并必须满足隐私和可逆性约束：

- 若同一账号在两条候选 Content 上已有不同可见性的 Collection，不自动合并，只建立 merge candidate。
- 无可见性冲突时，在事务中选择最早 Content 为主对象，重挂 Collection、公开标签和事件引用，并保留旧 Content alias 与 merge audit。
- `first_public_at` 取两者中最早的非空值；已投递 Email 记录按主对象去重，不能因合并重复发送。
- 合并不得把任意私人 Collection 变成公开，也不得把私人标签或索引迁入公共作用域。
- 拆分根据 ContentLink 和 merge audit 恢复 URL 归属及引用，不能依赖当前标题或 AI 相似度猜测。

## 11. 公开状态与排序

### 11.1 公开存在条件

一条 Content 至少存在一个“当前有效、公开、未被移除”的 Filter Collection，才会出现在：

- AI 瀑布流。
- 每日 Email。
- 公共 MCP。

最后一个公开 Collection 变为私密或失效后，Content 立即退出后续公共入口，但 Content、私人 Collection 和历史事件仍保留。

Filter 公开主页只展示该 Filter 自己当前有效且公开的 Collection。即使同一 Content 仍被其他 Filter 公开，已经转私密或被移除的 Collection 也不能继续出现在原 Filter 的主页。

Collection 状态机只使用四组正交字段：

- `collection_status`：active 或 deleted，表示收藏关系是否存在。
- `visibility`：public 或 private，表示用户最近一次明确选择。
- `filter_revoked_at`：Filter 资格撤销导致的暂停时间；重新邀请后仍需本人显式重新公开。
- `moderation_status`：clear 或 blocked；只有管理员可设置或解除，用户操作不能覆盖。

| 动作 | collection_status | visibility | filter_revoked_at | moderation_status | public_since |
| --- | --- | --- | --- | --- | --- |
| 普通会员首次收藏 | active | private | 空 | clear | 空 |
| Filter 首次收藏 | active | public | 空 | clear | 当前服务端时间 |
| 用户改为私密 | active | private | 不变 | 不变 | 空；历史写事件账本 |
| 有效 Filter 显式公开 | active | public | 清空 | 不变 | 新的服务端时间 |
| Filter 被移除 | active | 保留原选择 | 写入当前时间 | 不变 | 不参与当前归因 |
| 重新邀请但尚未重新公开 | active | 保留原选择 | 保持非空 | 不变 | 不参与当前归因 |
| 管理员阻断该 Collection | active | 保留原选择 | 不变 | blocked | 不参与当前归因 |
| 管理员解除阻断 | active | 保留原选择 | 不变 | clear | 仍需满足其他公开条件 |
| 用户显式删除收藏 | deleted | 保留审计快照 | 保留 | 保留 | 不参与当前归因 |
| 已删除后重新收藏 | active | 按当前角色/明确选择重置 | 有效 Filter 可清空 | 保留 | 公开时写新时间 |

有效公开资格严格等于：`collection_status = active`、`visibility = public`、`filter_revoked_at IS NULL`、`moderation_status = clear`、对应 Filter 当前有效，并且 Content 为 active、未被安全阻断或下架。active Collection 的重复提交不触发任何状态转换；用户永远不能通过删除、重发或切换 visibility 绕过 moderation block。

### 11.2 时间规则

Content 和 Collection 使用不同的时间：

- `Content.first_public_at` 在 Content 第一次满足公开存在条件时写入，之后永久不变，用于瀑布流排序和 Email 新内容判断。
- `Collection.public_since` 在该 Collection 每次从私密切换为公开时重写，只用于当前首位 Filter 归因。
- 私密期间的时间不计入公开排序。
- 公开后转私密，再次公开时使用新的时间，不能夺回旧的首位。
- 同时提交按服务端接收时间排序，再用稳定 ID 打破平局。
- 瀑布流按 `Content.first_public_at` 倒序排列；首位 Filter 退出但仍有其他公开 Filter 时，旧卡片不会突然浮到最新位置。
- Content 在全部公开 Collection 消失后又重新公开，仍保留原 `first_public_at`，V1 不把它伪装成新内容或重复进入 Email。

### 11.3 撤回边界

切换为私密会停止未来网站、Email 和公共 MCP 的曝光，但已经发送的 Email 无法召回。Filter 首次公开收藏前必须看到这项说明。

公共网站跳转使用当前公开资格校验；内容退出公共表面后，公开 Content ID 跳转立即失效。已发送 Email 使用与 `EmailDeliveryItem + account_id` 绑定的签名跳转 token：内容后来转私密时，只有登录为原收件账号才能继续打开原文；危险链接阻断或权利人下架可覆盖该例外并拒绝跳转。这样历史 Email 仍可用，但不会留下永久公开、可枚举的重定向器。

## 12. 内容补全

### 12.1 长期保存

Attention 长期只保存：

- URL 和来源信息。
- 标题、作者、来源、发布时间、favicon 等可得元数据。
- 80–150 字的 AI 摘要。
- 标签和向量。
- Collection、可见性和事件账本。

### 12.2 不保存

- 原文正文。
- 原站图片或视频副本。
- 绕过登录、付费墙或访问控制获得的内容。
- 用户整段分享文案的长期副本。

正文如可合法访问，只能在隔离的临时任务中用于生成摘要、标签和向量，任务完成后立即丢弃。

### 12.3 AI 摘要

- 摘要明确标记为 AI 生成，与 Filter 收藏信号分开展示。
- 摘要不得声称 Filter 读过或赞同内容。
- 用户始终通过“查看原文”访问原站。
- 支持举报、隐藏和重新生成摘要。
- 无法生成时显示“暂时无法生成摘要”，不阻止内容出现。

## 13. 标签

AI 可按需创建标签，但创建前先匹配已有标签和别名。

Tag 至少包含：

- `canonical_name`
- `aliases`
- `type`
- `status`：candidate、active 或 merged

公开规则：

- 第一个公共 Content 命中新标签时，它是隐藏 candidate。
- 第二个不同的公共 Content 再次命中时，标签变为 active。
- 同一 Content 被多个 Filter 收藏不算第二次命中。
- 私密收藏不能激活或暴露公共标签。
- 标签是否可见只按当前满足公开存在条件的 Content 计算；公开 Content 全部撤回后，相关 ContentTag 立即停止展示和计数，必要时将不足两条支撑的标签降回 candidate。
- 管理员可合并别名或撤回错误标签。

标签只用于浏览和会员筛选；标签订阅不属于 V1。

## 14. 公开瀑布流与卡片

> 本节的卡片内容设计仍有效；游客访问范围已更新为“每个 Domain 当前公开流前 `N` 张”，详见 [`2026-08-04 设计`](./2026-08-04-attention-identity-membership-growth-design.md#21-产品即展示页)。

`/ai` 是 V1 唯一 Domain 页面，按第 11 节的公开时间倒序展示，不做推荐权重。

卡片展示：

- 系统生成的纯色或渐变背景，不搬运原站封面。
- 由 Attention 安全代理并缓存的来源 favicon；获取失败时使用生成的来源字母图标，浏览器不直连任意 favicon URL。
- 标题。
- 80–150 字 AI 摘要，或摘要不可用状态。
- 可得的作者、来源和发布时间。
- 已激活标签。
- 当前公开 Filter 头像。
- 人类眼睛：过滤明显机器人和预取后的原文跳转次数。
- AI 眼睛：MCP 检索返回次数。
- 明确的“查看原文”。

交互：

- 点击卡片或“查看原文”经 Attention 跳转记录后直达原文。
- 点击 Filter 头像进入其公开主页。
- 点击标签进入会员筛选结果。
- V1 不建立 Content 详情页。

当前权限以 2026-08-04 设计为准：Guest 与 Free 只能浏览每个 Domain 当前公开流前 `N` 张；Free 可以不限量私密收藏、云同步和使用基础 Hosted MCP；Member 解锁完整公开流、托管搜索/筛选/订阅、Email 与高级 MCP。

## 15. 每日 Email

- V1 只订阅整个 AI Domain，不区分对象或 Filter。
- 每天汇总一次，选择 `first_public_at` 落在本次窗口内、且发送前仍满足公开存在条件的 Content，去重后按时间排列。
- 同一 Content 无论被多少 Filter 收藏，只出现一次。
- 每个订阅账号对同一 Content 最多收到一次；重新公开或 canonical 合并不会重复发送。
- 当天没有新内容则不发送。
- 每张条目始终显示作者、来源和“查看原文”；缺失字段不伪造。
- 退订立即影响后续发送。
- 公开收藏随后撤回时，历史 Email 无法召回。

## 16. Agent、MCP 与个人知识库

> 本节的 Agent/MCP 业务边界仍可作为历史参考；当前接入方式为 OAuth + PKCE 优先、PAT 备用，Free 可使用基础 Hosted MCP，详见 [`2026-08-04 设计`](./2026-08-04-attention-identity-membership-growth-design.md#5-localcloud同步与-mcp)。

完整架构图和数据流见 [`docs/architecture.md`](../../architecture.md)。V1 MCP 不承诺基于原文全文回答。

### 16.1 Channel 与 Agent 边界

网页对话和微信对话只是不同 Channel。Channel Adapter 只负责渠道协议、Attention 账号绑定、消息幂等、统一消息封装和回复格式，不负责理解链接或实现收藏规则。

独立的 Attention AI Agent 服务统一负责：

- 对话上下文。
- 意图识别和任务规划。
- 链接、短链和平台分享消息解析。
- 调用受控 Web/Browser MCP 获取公开元数据。
- 调用 Attention MCP 完成收藏、搜索、找回、发现和提醒。

因此同一用户在网页或微信提出相同请求，应触发相同的 Agent 能力、MCP 工具和业务结果。链接解析发生在消息进入 Channel Adapter 之后，是 Agent 的能力，而不是微信或网页入口的能力。

### 16.2 Attention MCP 接口

首批工具命名空间：

- `content.collect`：收藏一个链接或 Agent 已解析的内容。
- `content.search`：搜索公共 Domain 或当前账号的收藏。
- `content.get`：获取单条内容的元数据、摘要和原文链接。
- `feed.list`：读取当前账号可访问的 Domain 发现流。
- `collection.list`：读取当前账号自己的收藏。

公共 Domain 和个人收藏必须显式区分 Scope，不得静默混合。私密 Collection 在搜索索引、缓存、日志和权限层都必须按账号隔离。

AI 检索计数由 MCP Server 在 Content 实际进入有效结果时内部产生。客户端不能调用公开工具主动增加计数。

### 16.3 外部 Agent 与 API Key

Codex、Claude Code 和其他 MCP Client 可使用用户在 Attention 账号中生成的 API Key 调用同一套 MCP 工具。

- 一个账号可创建多个命名 Key。
- 原始 Key 只展示一次，服务端只保存哈希、前缀、名称和权限。
- Key 支持独立吊销、轮换、Scope 与限流。
- MCP 鉴权层从 Key 推导账号；客户端不能提交或覆盖任意 `account_id`。
- 记录 Key ID、客户端、工具、时间、请求 ID 和结果状态，但默认不长期保存原始 query 或外部 Agent 对话。
- 客户端重试按账号、客户端和请求 ID 幂等，不重复收藏或增加 AI 检索计数。

### 16.4 CLI 与 Skill

为会员的 AI 提供 CLI、Skill 和 MCP 配置，引导 Agent 调用上述接口。能力重点是“找回我收藏过的某篇内容”“把当前链接收藏到 Attention”和“从公共 AI Domain 找相关来源”，而不是复制原文或代替原站阅读。

## 17. 人类与 AI 事件

卡片上两类数字分别记录，不合并成一个模糊热度：

- `outbound_click`：用户通过 Attention 跳转到原文，并过滤已知 Email 安全扫描器、机器人和浏览器预取。界面称“原文跳转”，不宣称实际阅读人数。
- `mcp_retrieval`：一条公共 Content 被有效 MCP 请求返回。

事件规则：

- 一次 MCP 请求中，同一 Content 最多记一次。
- MCP 客户端重试使用相同 `request_id` 幂等去重，唯一命名空间为 `account_id + client_id + request_id + content_id`，不能全局信任客户端给出的 ID。
- 私人收藏检索只产生私人审计事件，不增加公共卡片的 AI 数字。
- “被检索到”只表示进入结果，不表示 AI 最终引用、用户阅读或内容被采纳。
- 记录调用者会员层级、接口、请求 ID 和时间，便于未来调整规则。
- MCP 按账号和客户端限流；默认不长期保存原始 query，避免把用户问题写入日志或贡献账本。

未来若启用贡献分配，可从原始事件重新计算；V1 不展示收益、不结算，也不按点击直接分钱。

## 18. 首位 Filter 与未来归因

虽然 V1 不支付，仍保留可回算的公开收藏顺序：

- 当前最早的有效公开 Filter 是首位。
- 未来如采用 80/20，首位占 80%，其余当前有效公开 Filter 平分 20%。
- 首位转私密或被移除后，下一位补上。
- 内容和计数不因第一位退出而消失，只要仍有其他公开 Filter。
- 归因顺序不影响卡片内容、排序和当前产品权限。

## 19. 数据模型

> 本节的 Content/Collection 模型仍有效；旧 `Account.wechat_binding`、单一 `Entitlement.member_enabled` 和 API Key-only 模型已废弃。当前身份、grant、subscription、referral、redemption、points、ChannelIdentity 与 OAuth 模型见 [`2026-08-04 设计`](./2026-08-04-attention-identity-membership-growth-design.md#10-建议数据模型)。

### 19.1 Account

- id
- wechat_binding
- stable_handle
- status

### 19.2 Entitlement

- account_id
- member_enabled
- source
- starts_at
- ends_at

### 19.3 FilterProfile

- account_id
- display_name
- avatar
- invited_at
- active

### 19.4 Domain

- id
- slug
- name
- active

### 19.5 InputAttempt

- id
- channel
- account_id
- channel_message_id
- input_hmac
- parser_version
- candidate_count
- safe_selected_url
- unsafe_candidate_fingerprint
- redirect_chain
- selection_token_digest
- selection_expires_at
- selection_consumed_at
- source_adapter
- status
- error_code
- received_at

数据库唯一约束：`channel + account_id + channel_message_id`。渠道重试必须命中同一 InputAttempt；Web 的 `channel_message_id` 使用服务端签发或客户端持有的幂等键。

### 19.6 ContentLink

- id
- content_id
- input_attempt_id
- safe_selected_url
- resolved_url
- normalized_url
- 脱敏 redirect_chain
- source_adapter
- adapter_version
- observed_canonical_url
- canonical_trust_status
- observed_at
- resolution_status
- safety_status

ContentLink 保存每次安全 URL 观察，避免多人通过不同短链提交时相互覆盖。危险 URL 不创建 ContentLink，也不以明文持久化。每次因合并或拆分重挂 ContentLink 时，另写 assignment audit，记录 old_content_id、new_content_id、原因、规则版本、操作者和时间，不覆盖历史归属。

### 19.7 Content

- id
- outbound_url
- normalized_url
- canonical_url
- dedupe_key
- content_status：active 或 merged
- merged_into_content_id
- first_public_at
- visibility_version
- source
- content_type
- title
- author
- published_at
- cached_favicon_asset_id
- ai_summary
- summary_status
- embedding
- enrichment_status
- public_safety_status：allowed 或 blocked
- takedown_status：none 或 removed
- restriction_reason_code
- restricted_at
- restricted_by

数据库对 `dedupe_key` 建唯一约束。

Content 的安全阻断、权利人下架、解除限制及操作者写入不可变 ContentRestrictionAudit；不能只覆盖当前字段。

### 19.8 ContentAlias / ContentMergeAudit

canonical 合并后不删除旧 Content：

- 旧 Content 设为 `content_status = merged` 并写入 `merged_into_content_id`。
- ContentAlias 保存 alias_content_id、primary_content_id、alias_dedupe_key、merge_audit_id、active、created_at 和 disabled_at。
- ContentMergeAudit 保存合并前引用快照、规则/适配器版本、操作者、时间和拆分记录。
- 新请求命中旧 dedupe_key 时必须沿 active alias 路由到主 Content。
- 拆分时停用 alias、恢复旧 Content 为 active，并按审计快照恢复引用。

### 19.9 Collection

- id
- account_id
- content_id
- domain_id
- visibility
- collected_at
- public_since
- source_channel
- collection_status：active 或 deleted
- filter_revoked_at
- moderation_status：clear 或 blocked

唯一约束：`account_id + content_id`。

状态转换和有效公开资格以第 11.1 节的状态机为唯一依据。

### 19.10 Tag / ContentTag / PrivateCollectionIndex

- Tag：公共标签的规范名、别名、类型、状态。
- ContentTag：为合法公开处理的 Content 保存公共标签关系，包括模型置信度、审核状态和当前公开资格；Content 变为仅私密后不得继续展示或参与标签激活。
- PrivateCollectionIndex：按 account_id 隔离保存私人收藏的向量和私人标签，不写入全局 ContentTag，也不能激活公共标签。

### 19.11 DomainSubscription

- account_id
- domain_id
- email_enabled
- subscribed_at

### 19.12 EventLedger

- id
- event_type
- content_id
- account_id 或匿名会话 ID
- request_id
- scope
- occurred_at

### 19.13 EmailDelivery

- account_id
- domain_id
- window_start
- window_end
- content_ids
- status
- sent_at

发送前按 Content 当前 `visibility_version` 和公开存在条件再次校验；已撤回的内容不得因旧任务快照继续发送。

每个条目另存 EmailDeliveryItem，包含 account_id、content_id 和签名跳转 token 的摘要。token 不直接暴露可枚举 Content ID；内容撤回后需验证原收件账号，安全阻断或权利人下架后统一失效。

### 19.14 ApiCredential

- id
- account_id
- name
- key_prefix
- key_hash
- key_version
- scopes
- client_id
- status：active 或 revoked
- created_at
- last_used_at
- expires_at
- revoked_at

原始 Key 只在创建时返回一次，不进入数据库、日志、异常追踪或备份。`account_id` 由 MCP 鉴权层从 Key 推导，客户端请求不能覆盖。每个 Key 可独立吊销和轮换，调用通过 `account_id + client_id + request_id` 执行幂等与审计。

## 20. 隐私、安全与内容治理

- 所有标题、作者、摘要、标签和分享文本都按不可信输入处理并转义，防止 XSS。
- 微信消息 ID 和 Web 幂等键防止渠道重试制造重复 Collection。
- 私密收藏必须在查询、索引、缓存、统计和管理后台五层隔离，不能只靠前端隐藏。
- 每次 Collection 可见性、Filter 资格、管理员危险链接屏蔽、权利人下架、Content 安全状态、canonical 合并或拆分发生变化，都递增相关 Content 的 `visibility_version` 并主动失效公开缓存；瀑布流、MCP 和搜索返回前再次校验源数据，Email 在真正发送前再次校验。
- 公开页面始终标明原作者、来源与原文链接；拿不到的信息留空，不由模型编造。
- 不展示原站全文，不使用 iframe 提供站内阅读，不绕过访问限制。
- 提供举报、危险链接阻断、摘要隐藏和权利人投诉/下架流程。
- 下架只停止 Attention 后续展示，不声称能删除原站内容或召回历史 Email。
- 被移除的 Filter 不再贡献新的公开曝光；其私人收藏和必要审计记录按政策保留。
- Filter 被移除时，其公开 Collection 写入 `filter_revoked_at` 并立即退出全部公共表面；重新邀请后不得自动恢复。管理员 moderation block 独立存在，只有管理员能解除。

### 20.1 账号删除与私人数据生命周期

- 账号删除请求立即撤销该账号全部公开 Collection；同一 Content 若仍有其他有效公开 Filter 则继续存在，并由下一位补上归因。
- 微信绑定、会员权益、Email 订阅、私人 Collection、私人标签、向量和个人 MCP 索引进入删除队列，主存储在 30 天内清除；备份到期后不恢复这些记录。
- Filter 公开主页和稳定网名立即下线；必要的安全审计默认保留 90 天，只有明确的法律或安全保全才可延长，并记录原因和访问者。
- EventLedger 中与删除账号关联的身份字段去标识化；不需要身份的聚合计数可以保留，但不能反向恢复账号。
- 普通管理后台不得浏览私人收藏、私人 query 或私人索引。例外访问必须采用最小权限的安全支持流程，记录理由、操作者和时间。

## 21. 关键指标

首个收藏工具切片关注：

- 按来源和输入形态统计的 URL 提取成功率。
- 短链安全解析成功率。
- 从收到消息到首次回执的 P50/P95 延迟。
- 自动处理率与 `ambiguous` 比例。
- 重复提交的幂等命中率。
- 元数据、摘要和标签各自的异步补全成功率。
- 公开/私密判断错误与安全阻断误报。

完整 V1 再关注：

- 公开 Content 数量和持续有效率。
- 过滤后的原文跳转量。
- 公共 MCP 检索返回量。
- 个人收藏 MCP 的活跃账号数。
- Email 打开与原文跳转。

这些指标用于判断功能质量，不在 V1 中驱动推荐排序或收益分配。

## 22. 验收矩阵

### 22.1 多来源识别

- 抖音直链可识别为 douyin 并保存真实目标。
- 抖音整段分享文案可提取短链并保存真实目标。
- 小红书直链可识别为 xiaohongshu。
- 小红书整段分享文案可忽略模板文字并提取内容链接。
- 微信公众号直链可识别为公众号文章。
- 微信链接卡片可从结构化 URL 建立收藏。
- 普通网页直链和含单个 URL 的文本可由 generic_web 处理。
- 平台元数据抓取失败时，安全有效的链接仍收藏成功。

### 22.2 歧义与安全

- 多个不同的高可信内容链接不会被悄悄全部公开，而会要求选择。
- `ambiguous` 不创建 Content/Collection；选择 token 绑定账号、24 小时失效且只能消费一次。
- 无 URL、损坏 URL、非 HTTP(S) URL 返回明确错误。
- 私网、localhost、云元数据、DNS 重绑定和危险重定向被阻断。
- 含明显 token 或临时签名的链接不会进入公共流或抓取器，也不会建立 Content/Collection 或明文审计记录。
- 原始分享文案不会长期出现在数据库或日志中。

### 22.3 去重和幂等

- 同一微信消息重试只生成一次 InputAttempt 结果。
- 同一用户重复收藏只保留一条 Collection。
- Filter 重复发送已私密收藏时，Collection 仍保持私密。
- 已删除 Collection 再次提交时进入新的收藏周期，并按当前角色规则恢复；历史周期仍可审计。
- 两个并发请求提交相同 `dedupe_key` 时，数据库中只产生一条 Content。
- 不同用户收藏相同 canonical URL 共享 Content、各有 Collection。
- 翻译、转载和相似标题默认保持不同 Content。
- canonical 合并可查看记录并可拆分。
- 请求命中已合并 Content 的旧 dedupe_key 时会沿 ContentAlias 返回主 Content；拆分后可恢复旧归属。
- 同一账号存在公开/私密冲突时只创建 merge candidate，不自动 canonical 合并。

### 22.4 可见性

- Filter 微信与 Web 收藏默认公开，普通会员默认私密。
- Filter 可从回执和 Web 改为私密。
- 私密转公开生成新的 `public_since`。
- 最后一个公开 Filter 退出后，内容从后续公共入口消失。
- 私密内容不会激活公共标签或增加公共 AI 眼睛。
- Filter 被移除后，其旧公开 Collection 立即失效；重新邀请不会自动恢复。
- Filter 无法通过重发或切换公开状态绕过管理员 moderation block。
- Filter 主页只显示本人当前有效公开 Collection。
- 首位 Filter 退出但第二位仍公开时，Content 的瀑布流位置不变化。

### 22.5 后续表面

- 瀑布流严格按不可变的 `Content.first_public_at` 倒序。
- Email 对 Content 去重且无新增时不发送。
- Content 转私密后公共跳转立即失效；历史 Email 仅允许原收件账号通过签名投递链接继续访问，安全下架则一律阻断。
- `search_public_domain` 与 `search_my_collection` 范围硬隔离。
- 过滤后的原文跳转和 MCP 返回分别计数，并对重试幂等。
- 可见性、安全、下架及合并状态变化后，旧缓存、MCP 结果和待发送 Email 均不能继续暴露 Content。
- Content 被安全阻断或权利人下架后，不再满足任何公共资格，并保留不可变限制审计。

### 22.6 删除与私人数据

- 删除账号立即撤销公开资格并触发下一位 Filter 补位。
- 私人收藏、私人索引、微信绑定和订阅进入 30 天内删除流程。
- 事件身份被去标识化，安全审计按 90 天默认期限处理。
- 普通管理员无法浏览私人收藏或私人 MCP 数据。

## 23. 交付顺序

在本设计确认后，按以下顺序规划实现：

1. 账号、会员权益、Filter、Content、ContentLink、Collection 和 InputAttempt 基础模型。
2. Attention MCP 的账号上下文、核心工具契约和内部鉴权边界。
3. 独立 Attention Agent、统一 Message Envelope、链接解析能力和受控 Web/Browser MCP。
4. Web 对话 Adapter、Web 收藏界面和“我的收藏”。
5. 异步元数据、摘要、标签与失败降级。
6. AI 瀑布流和原文跳转、MCP 检索计数，完成 Web 纵向切片。
7. 微信官方 Adapter、账号绑定、消息幂等与统一回执。
8. OAuth + PKCE 优先的外部 Agent MCP 接入、PAT/API Key 备用路径、CLI 与 Skill。
9. Email。

第一阶段以“不同来源都能稳定收藏、不会误公开、不会因抓取失败丢链接，并能在我的收藏和最小公开流中找回”为完成标准。
