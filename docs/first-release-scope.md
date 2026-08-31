# Attention 第一版范围

状态：当前产品与工程决策的统一口径

确认日期：2026-08-27

这份文档优先于早期产品草案、长期架构图和实验性 Channel 设计。其他文档可以继续保留历史背景，但凡涉及“第一期 / 一期 / V1”的范围，都必须与本页一致。

> 测试期权益口径：当前 staging / 首发测试阶段，验证码注册账号默认授予 Member entitlement，以完整验证 Member 路径。Free / Member / Filter 数据模型、订阅和权益交互均继续保留；首发不做默认权益切换开关。安全、合规、反滥用与服务稳定性所需的登录、权限、速率和风险控制继续保留。

## 一句话

第一版是一个“人筛选，AI 整理”的收藏与公开发现产品：用户可以在 Web 上注册、收藏、管理和浏览内容，也可以把自己的 Agent 接入 Attention Skill + MCP。Attention 不托管 Agent、模型或微信消息渠道；微信由用户自己的本地 Agent / iLink 运行时承载。

## 第一版必须交付

### Web 产品

- `/ai`：公开发现页，以 AI Domain 为一期默认 Domain；游客只看服务端配置的前 `N` 张，默认 `20`，已注册 Member 可看完整公开流。
- `/account`：我的页面，收藏与公开/私密状态在同一处管理；收藏卡片与发现卡片使用同一信息结构。
- `/login` / 登录模块：邮箱验证码登录与注册；验证码验证成功后默认创建 Member；之后可以设置密码并切换密码登录。
- Member：Member 可不限量收藏、保存私密收藏并同步到云端，同时解锁完整公开流以及当前已交付的 AI 检索、筛选、订阅等能力；测试期所有新注册账号默认获得该权益，游客不创建账号、不保存收藏。
- Free entitlement 保留为历史/显式撤销后的兼容状态，不是首发新注册账号的默认结果。
- `/membership`、`/membership/checkout`：继续展示并确认 Member 订阅；自主注册用户首次绑定真实订阅时按账号规则获得三个月体验。支付供应商接入仍通过 provider-neutral billing adapter，不把未联调的供应商写成已上线。
- `/account/digests`、`/account/rewards`：Member/Filter 的 Domain 日报订阅，以及 Consumer 邀请、Filter 年卡兑换和续费积分等已确定的权益账本入口。
- Filter：公开供给资格；新收藏默认公开，历史本地收藏首次同步仍强制私密。
- 公开收藏默认展示作者、来源和“查看原文”；摘要失败时保留链接并显示“暂时无法生成摘要”。
- `/doc`：无需登录的独立 Agent 接入文档站；每个 Agent 有独立 URL 和左侧目录。
- `/agent`：独立展示本地 Agent 接入提示词与配置流程，并保留云端 Agent 的“开发中”卡片。
- `/account/connections`：管理 OAuth 授权状态和 API Key，不展示托管 Channel 面板或复杂安装命令。
- 独立管理端：复用 Attention 现有域名，但不嵌入现有用户站点导航或账户页，也不提供任何用户端跳转或可发现入口；管理员仅能直接访问独立地址，并经服务端白名单校验。它复用同一套账号、权益与审计后端。首版提供 `/admin/users` 用户权限管理页，支持按邮箱、昵称和当前权益查询全部用户，查看账号与权益状态，将指定用户设置为 Member 或 Filter，撤销 Filter，并填写变更原因。

### Agent、MCP 与授权

- Attention Core 是唯一业务真相；Web、MCP 和同步都经过同一套身份、权益、去重、可见性和审计规则。
- 公开 Attention Skill 与 Hosted MCP 同步交付，Skill 与 MCP Contract 必须版本绑定。
- OAuth Authorization Code + PKCE 是首选；API Key 是不支持浏览器 OAuth 时的备用凭据，原文只展示一次。
- 首版接入文档覆盖 OpenClaw、Hermes、Codex、Claude Code 和 WorkBuddy；Codex 与 Claude 的 Desktop 只承诺交互式 Skill/MCP，不把 Desktop 显示成微信已连接。
- 用户自己的 Agent 可以在本地承载 iLink / 微信；iLink token、会话和媒体密钥留在用户设备。Attention 只提供公开 Skill、Hosted MCP、授权和 Local Channel Runtime 所需的基础协议，不托管模型或消息会话。
- Local Channel Runtime 的安装、注册、心跳、配对和审计接口属于基础设施；Web 首版不展示 Hosted Channel 或虚假的微信连接状态。

### 收藏与内容处理

- 支持普通网页、抖音、小红书和微信公众号文章等来源的链接/分享文本识别。
- 多候选先返回候选，用户确认前不创建收藏。
- 原文仍保存在外部平台；Attention 保存链接、必要元数据、摘要、标签、状态和贡献/使用信号。
- 当前 Fetcher 是隔离的确定性 URL/元数据处理服务，不是开放给第三方 Agent 的通用浏览器接口；网页深度读取和浏览器自动化由用户自己的 Agent 完成。
- 抓取、解析或摘要失败不能删除已接受的收藏，也不能把失败伪装成成功。

## 第一版明确不做

- Attention 官方 Hosted Agent Runtime。
- Attention 托管的企业微信客服、公众号或其他 Hosted Channel 主入口。
- 将原文全文、外部平台 Cookie、iLink token 或浏览器状态上传到 Attention。
- 面向第三方 Agent 的通用云端 Browser/Fetcher 或登录态网页操作。
- 用 MCP 绕过 Web 公开流上限、会员权益或 Filter 公开资格。
- 学生认证权益；这是后续 grant，不创建新账号类型。
- 通过 Web 展示“微信已绑定 / 已连接”而没有本地 Reporter 的真实证据。

## 口径规则

1. “Agent 接入”指用户自己的 Agent 接入 Attention，不等于 Attention 托管 Agent。
2. “微信支持”指本地 Agent / iLink 能按宿主能力工作，不等于 Attention 提供企业微信或公众号客服入口。
3. “MCP 能力一致”指适合由 Agent 执行的业务动作共享 Core 和实时权益；登录、OAuth、API Key、付款和本地运行时生命周期仍是独立协议或 Web-only 控制面。
4. 早期文档中的 Hosted Agent、Hosted Channel、网页对话和官方 Fetcher 编排均为长期方向，不能写成第一版已交付能力。

## 测试期权益管理

1. **默认 Member**：新注册账号直接授予 Member；首发不提供切换默认权益的开关。
2. **管理员访问**：`/admin/users` 只允许服务端环境变量白名单中的管理员邮箱对应账号访问；前端隐藏不作为安全控制，所有读写接口必须在服务端二次校验。
3. **全用户查询与权益调整**：管理员可按邮箱、昵称和当前权益检索全部用户；可将指定用户设为 Member 或 Filter，并撤销 Filter。首版不支持批量修改、管理员互相授权或通过页面创建管理员。
4. **审计**：每次权益调整必须记录操作者、目标账号、变更前后状态、原因、时间与授予来源；调整遵循既有权益账本的撤销和到期语义。

## 相关文档

- [`docs/architecture.md`](./architecture.md)：当前与长期架构边界。
- [`docs/handoffs/mcp-web-capability-parity.md`](./handoffs/mcp-web-capability-parity.md)：Web/MCP 能力等价与安全例外。
- [`docs/superpowers/specs/2026-08-07-local-agent-channel-runtime-design.md`](./superpowers/specs/2026-08-07-local-agent-channel-runtime-design.md)：本地 Agent、iLink 与 Runtime 基础设施。
- [`docs/local-agent-wechat-device-acceptance.md`](./local-agent-wechat-device-acceptance.md)：Codex / Claude Code 的真机微信首版验收清单。
- [`docs/superpowers/specs/2026-08-04-attention-identity-membership-growth-design.md`](./superpowers/specs/2026-08-04-attention-identity-membership-growth-design.md)：账号、权益和增长机制。
