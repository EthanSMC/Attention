# Attention 云端 Agent 可执行推进设计

状态：待用户审阅；不改变现有第一版范围和生产行为

日期：2026-08-25

## 1. 结论

云端 Agent 可以进入受门控的验证阶段，但当前不能进入真实用户开发或生产接入。
最先要通过的不是模型或 Browser 验证，而是企业微信“微信客服”（下文简称
`wxkf`）G0：用真实企业、真实客服账号和真实微信测试用户证明加密回调、消息拉取、
会话状态与异步回复形成可恢复的闭环。

推荐新增一条独立的 Hosted Agent 控制面：

```text
wxkf Channel Adapter
  -> Durable Wakeup / Pull Cursor / Inbox
  -> Account Binding
  -> Per-account Task Lane
  -> Agent Orchestrator
  -> Pi Agent Core（仅 agent loop）
  -> 每任务隔离 Browser Worker
  -> Credential/Profile Broker + KMS-backed Vault
  -> Attention Core Gateway / 现有 Hosted MCP 业务语义
  -> Durable Outbox
  -> wxkf send_msg
```

现有微信公众号 Adapter 不是 wxkf Adapter，现有 `jobs` 也不是云端 Agent 工作流引擎。
可以复用已有的 URL 安全、Core 收藏语义、RLS、幂等、Worker lease 和本地耐久队列经验，
但不能直接把旧 Adapter 接回 `410 Gone` 的 Channel 路由，也不能把 Browser/Pi 塞进现有
内容 Worker。

本文件只定义设计、验证顺序和验收门。下一步在用户批准后再写逐文件实施计划。

## 2. 已确认的产品边界

### 2.1 用户入口

- 入口只有同一个企业微信“微信客服”一对一会话。
- 只有已绑定 Attention 账号的用户可以创建任务。
- 未绑定用户只收到绑定入口；不创建任务、不保留待执行任务，绑定后需要重新发送链接。
- Web 只提供账号绑定、Agent 配置、登录态/Profile 与安全管理，不提供对话界面。
- 同一 Attention `account_id` 的任务严格串行；同一账号绑定多个入口时仍共用一条 lane。
- 不同账号在全局容量和平台限流内并行。

### 2.2 首版任务

- 接受一条消息中的一个 `http`/`https` 公众号文章或公开网页链接。
- Agent 打开页面、读取正文、生成有依据的中文摘要并保存为该账号的收藏。
- 多链接、无链接、文件、图片、语音、小程序、支付、发帖、评论和站内私信不进入任务。
- 多链接返回“请一次发送一个链接”，不让模型选择。
- 页面读取或摘要失败不能伪造成功；安全 URL 一旦被 Core 接受，收藏仍可保留为待整理或
  “暂时无法生成摘要”。
- 推荐云端 Agent 创建的收藏首版始终为私密；是否允许 Filter 默认公开列为用户决策。

### 2.3 Browser 动作

首版硬允许集只有：

1. 导航到经过 URL 策略检查的地址；
2. 读取受限 DOM/可访问性快照和页面文本；
3. 关闭遮挡阅读的弹窗；
4. 展开全文；
5. 有界滚动、翻页；
6. 在明确标识为搜索框的控件中搜索。

禁止表单提交（搜索除外）、任意 JavaScript、上传、下载、点赞、关注、评论、发布、购买、
发送消息、修改账号、调用 shell、读写文件和访问浏览器存储。策略由工具实现强制，不能靠
system prompt。

## 3. 现有仓库审阅

### 3.1 可以复用

| 现有能力 | 复用方式 |
| --- | --- |
| `apps/fetcher` | 继续承担 URL/DNS/IP/跳转/凭证参数安全检查；它不替代 Browser Worker |
| `packages/collector` | 复用 URL 候选识别、公众号文章/普通网页适配和确定性规范化 |
| `apps/web/src/server/collection-service.ts` | 继续作为收藏、去重、可见性和异步内容处理的业务真相 |
| `attention-tool-registry` / Hosted MCP | 复用业务工具语义；云端 Agent 通过内部 Core Adapter 调用，不复制业务逻辑 |
| PostgreSQL RLS 与 runtime roles | 为新控制面增加更窄的新 role；仍禁止常驻服务使用 migration owner |
| `jobs` 的 `SKIP LOCKED`、lease、重试与幂等模式 | 作为实现参考，不扩展原表承担 Agent workflow |
| 本地 Channel durable inbox/outbox | 复用“成功发送前不删 outbox、稳定消息 ID、崩溃恢复”的语义，不复用本地文件存储 |
| `channel_identities` 的 HMAC 思路 | 可迁移为 wxkf 绑定索引，但必须重新定义主体键和 Web 绑定流程 |

### 3.2 不能直接复用

| 现状 | 原因 |
| --- | --- |
| `apps/wechat-adapter` | 面向微信公众号回调和公众号客服消息，不是 wxkf 的 `kf_msg_or_event -> sync_msg -> kf/send_msg` 协议 |
| `/api/channels/*` | 当前稳定返回 `410 Gone`，绑定页也已删除；不能直接复活 |
| `apps/worker` | 只支持内容 metadata/summary 任务；没有 account lane、workflow fence、Browser 或 outbox |
| 静态 Fetcher/规则正文提取 | 不执行 JavaScript、点击、展开或登录，不能证明动态页面正文充分 |
| Local Channel Runtime | 用户设备持有 iLink 凭据；它的信任和部署边界与 Hosted Channel 不同 |
| Compose | 是单机基线，不提供 Browser 沙箱、KMS、独立网络域或高可用队列 |

仓库当前没有 Pi Agent Core 依赖。上游项目已把核心包描述为可嵌入的 agent loop；接入前需
固定准确的包 namespace、版本、许可证快照和错误语义，并通过本地 Adapter 隔离上游变化。

## 4. 方案比较

### A. 独立 Hosted Agent 控制面（推荐）

新建逻辑独立的 Channel Adapter、Workflow/Outbox、Orchestrator、Browser 与 Profile
边界；首期 durability 使用 PostgreSQL，Browser 必须进程/容器隔离。

优点是信任边界清楚，能满足 per-account 串行、KMS Profile、崩溃恢复与渐进发布；同时可
复用现有 Core。代价是要增加新 schema、runtime role、服务和运维面。

### B. 扩展现有微信 Adapter + Worker

短期文件少，但 wxkf 协议、用户队列、Browser 密钥和原内容 Worker 会耦合在一起；现有
Adapter 还会诱导实现继续依赖错误的公众号协议。仅允许复用低层测试资产，不采用此方案。

### C. 托管 Workflow/Browser 服务

使用 Temporal/云队列和托管远程 Browser 可以减少自建调度工作，但会扩大页面内容与 Profile
交给第三方的范围，也增加数据驻留、供应商退出和成本风险。它保留为容量或运维不足时的
替代方案，必须满足相同的工具、密钥和租户隔离合同。

## 5. 核心服务边界

### 5.1 wxkf Channel Adapter

负责：

- wxkf 自建应用 access token、回调 Token、EncodingAESKey 和 API 调用；
- GET 回调验证、POST 验签/解密和快速应答；
- `kf_msg_or_event` wakeup 合并、`sync_msg` cursor 拉取；
- wxkf `msgid` 去重、消息规范化、渠道身份解析；
- service state 检查/变更、发送预算和 outbox 投递；
- 把 raw `external_userid`、`open_kfid` 和渠道 secret 隔离在渠道域内。

不负责：网页读取、模型调用、收藏业务、Profile 选择或 account_id 推断。

### 5.2 Durable Workflow Store

负责 inbox、task、account lane、lease/fence、outbox 和恢复。首版采用 PostgreSQL 独立表与
独立 runtime role；不会把 URL、Cookie、模型输入或 Vault 密钥放进通用 `jobs.payload`。

### 5.3 Agent Orchestrator

负责确定性状态机、预算、超时、重试、Pi 生命周期、工具装配、取消和 Core 调用。它从已验证
的绑定记录取得 account_id；Pi 与模型不能提交或改写 account_id。

### 5.4 Pi Agent Core Runner

每个任务创建一个新的 Agent 实例，只承担模型-工具循环和事件流。它不拥有多租户 session、
队列、授权、Profile、持久化、重试或 outbox；不加载 Pi coding-agent 的 shell/文件工具。

Pi Runner 只拿到短期 task capability 和下列窄工具：

- `page.navigate`
- `page.read`
- `page.expand`
- `page.next`
- `page.search`
- `task.submit_grounded_result`

模型供应商密钥由 Model Gateway 持有，不进入 Pi 进程环境。

### 5.5 Browser Worker

每个 task/profile attempt 一个全新隔离实例。它没有数据库、wxkf、模型、KMS 或 Vault 凭据；
只接受签名的有时限动作。网络只允许目标站点及加载页面所需的受控子资源，所有顶层跳转重新
经过 URL policy。任务结束后销毁实例和临时磁盘。

### 5.6 Credential/Profile Broker + Vault

Broker 是唯一可将 Profile 解封装到 Browser Worker 的服务。Profile blob 使用每个 Profile
独立 DEK 加密，DEK 由 KMS KEK envelope 加密；数据库只保存 vault ref、owner scope、平台、
key version 和状态。

选择顺序由 Broker 的确定性策略控制，不由模型控制：

```text
anonymous
-> Attention 平台共享只读 Profile
-> 用户在隔离远程 Browser 亲自登录
-> 用户独享加密 Profile
```

每一步使用新的 Browser Worker。共享和用户 Profile 不能加载到同一实例，不能复制 Cookie、
Local Storage、认证头或 DOM session；共享 Profile 也不能作为用户 Profile 的基底。

### 5.7 Attention Core Gateway

Gateway 把 task capability 转成现有 Core/Tool Registry 的认证账号上下文。它不向 Pi 暴露
Bearer token、数据库凭据或 account_id 参数。收藏、去重、可见性和 enrichment 原子性继续
由现有 Core 保证。

### 5.8 Web 管理面

只增加：wxkf 绑定/解绑确认、云端 Agent 开关、Profile 列表/撤销/删除、远程登录入口、
安全活动和 kill switch。不会增加聊天记录、输入框或 Agent conversation 页面。

## 6. 关键数据模型

以下是逻辑表，不是本轮 migration：

| 记录 | 关键字段与约束 |
| --- | --- |
| `wxkf_pull_cursors` | 每 `(corp, open_kfid)` 一行；`next_cursor`、lease、last_success_at；单写者 CAS |
| `channel_inbox_messages` | `(provider, corp, open_kfid, msgid)` 唯一；provider 顺序号、origin、类型、短期加密 raw payload、规范化状态 |
| `hosted_channel_bindings` | HMAC(`corp + open_kfid + external_userid`) 唯一映射 account_id；原始 ID 不进日志 |
| `cloud_agent_account_lanes` | account_id 主键、next sequence、active task、lease、fence generation |
| `cloud_agent_tasks` | inbox ID/account ID/account sequence 唯一；状态、取消、预算、credential mode、Core collection/content ID、稳定错误码 |
| `channel_outbox_messages` | task/reply kind 唯一；稳定 provider msgid、加密目标/正文、预算归属、attempt、accepted/failure 状态 |
| `browser_profiles` | shared/user 互斥 owner 约束、platform、vault ref、KMS version、revocation/deletion state |
| `hosted_agent_security_events` | 只存稳定事件码、HMAC 指纹、耗时、版本和决策；不存页面正文、URL query、消息或 token |

### 6.1 每账号串行

Dispatcher 只在一个事务里 claim 可用 lane 和最早 account sequence task。长任务使用 lease +
heartbeat；每次 Browser/Profile/Core 副作用前必须携带 fence generation 并确认仍是当前 lease。
旧 worker 即使在 lease 丢失后恢复，也不能再保存、发消息或归还 Profile。

Core 收藏与 outbox 都使用由 `task_id` 派生的稳定幂等键。系统承诺内部 exactly-once effect，
不承诺 wxkf 外部网络天然 exactly-once；外部不确定性在 G0 单独验证。

## 7. 不可破坏的安全与数据不变量

1. 模型、页面内容、MCP/tool output 都是不可信输入。
2. Pi/模型永远看不到 Cookie、Local Storage、认证头、Profile blob、KMS/Vault key、wxkf
   secret、Core bearer、数据库凭据或任意管理身份。
3. Browser Worker、Pi Runner、Channel Adapter 和 Core 使用不同进程身份、网络域和 runtime role。
4. account_id 只来自服务端绑定；回调、URL、模型、MCP 参数都不能指定 acting account。
5. 未绑定消息不创建 task，也不在绑定后自动继续原链接。
6. 同一 account_id 最多一个具有有效 fence 的运行任务；不同账号才可并行。
7. 每个 profile attempt 都是新 Browser；共享与用户 Profile 永不混用。
8. Browser 工具 fail closed；未知动作、未知页面控件或跨域导航一律拒绝。
9. 页面文本中的“忽略规则”“读取 Cookie”“调用其他工具”等内容只作为正文，不改变权限。
10. Core 已接受的收藏不会因模型、Browser 或回复失败而被删除；摘要失败保持明确状态。
11. `send_msg errcode=0` 只记为 `accepted_by_wecom`，没有官方送达成功事件时不写 `delivered`。
12. raw 回调 body 不落库；拉取到的 raw message KMS 加密，规范化后尽快删除且最长保留 24 小时。
13. 默认不保存完整 DOM、截图、Pi conversation 或 chain-of-thought；长期只保留 Core 结果和
    脱敏运行元数据。
14. outbox 正文加密，终态后最多保留 7 天；provider ID 仅以必要密文和 HMAC 索引保存。
15. 解绑立刻禁止新任务和 Profile 使用；正在运行任务在下一个 fence 点停止。

## 8. G0：wxkf 完整渠道验证与设计

G0 必须从零实现独立 harness，不能导入旧 Adapter 的 endpoint、配置名或消息假设。可以在独立
单元测试中复用已验证的 AES/signature 原语，但真实回调仍需用 wxkf 官方参数和 CorpID
`receiveid` 重新验收。

### 8.1 官方证据、待实测证据与替代方案

| 项目 | 已获官方文档证据 | G0 必须取得的实测证据 | 不通过时替代方案 |
| --- | --- | --- | --- |
| 准入与权限 | 企业需在企业微信使用微信客服并开启 API；自建应用需列入“可调用接口的应用”，客服账号需指定为 API 管理，接待人员在应用可见范围；API 接管后原生接待规则暂不生效 | 目标企业主体、应用、secret、open_kfid、可见范围和 API 管理开关真实可用；未验证主体是否触发 send fail type 8 | 不接真实用户；继续现有本地 Agent/iLink，或等待企业资质/权限，不回退到公众号假实现 |
| access token | 每应用独立 secret；token 常规 7200 秒、需缓存、可能提前失效，不能给前端 | 失效刷新、并发 single-flight、错误码、IP/可信域限制 | Channel Adapter 熔断；不把 secret 分发给其他服务 |
| 加密回调 | URL/Token/43 位 EncodingAESKey；GET 验证需验签、解密并 1 秒内回明文；POST 为签名 + Encrypt，5 秒超时会断开并最多重试 3 次，官方不保证 100% 回调 | 真实 GET 验证、真实 POST `kf_msg_or_event`、CorpID receiveid、篡改/重放/时钟偏移、重复回调、快速 ack | 只保留低频 cursor reconciliation；若回调不能稳定通过则 G0 失败 |
| 事件语义与去重 | 回调只有 `kf_msg_or_event`、10 分钟 token 与 open_kfid，是拉取 wakeup，不含业务正文 | 相同 wakeup 是否重复、token 唯一性、平台重试形态 | wakeup 只做可重复触发；按 HMAC(corp/open_kfid/token) 合并，最终按拉取 msgid 去重 |
| 消息拉取 | `sync_msg` 每个请求指定 open_kfid；cursor 初次可空，返回 next_cursor/has_more；token 10 分钟有效且可省略但频率更严；最多读近 3 天；has_more=1 时 msg_list 可为空；官方强烈建议持久化 cursor | cursor 是否仅对 open_kfid 有效、批内/跨页顺序、两用户交错、token 过期、不带 token 的实际限频、callback 丢失后追平、崩溃点重放 | 每 open_kfid 单独 cursor/单写者；callback-driven + 按实测额度低频 reconciliation；无法在 3 天内可靠追平则阻断上线 |
| 会话与绑定 | 业务消息包含 open_kfid、external_userid、msgid；service state API 也用 open_kfid + external_userid | external_userid 在同一客服账号重复会话中的稳定性；不同 open_kfid 是否变化；绑定冲突和解绑后重绑 | 身份键固定为 HMAC(corp + open_kfid + external_userid)，不依赖昵称/unionid；每入口单独绑定 |
| 消息类型/任务入口 | sync_msg 支持 text/link；`origin=3` 是微信客户，`origin=5` 是企业接待人员；send_msg 发送的消息不会被 sync_msg 再读出 | 微信分享公众号文章实际落为 text 还是 link、短链形态、同一分享是否拆消息 | v1 同时解析 origin=3 的 text/link；其他类型稳定拒绝，不让 Agent 猜 |
| 会话状态 | 0 未处理、1 智能助手、2 接待池、3 人工、4 结束/未开始；send_msg 只允许 0/1 | 首次上行后的状态、0->1->4 流程、状态事件、人工接入/后台操作漂移 | 使用专属 API 客服账号；发现 2/3 时暂停 Agent 发送并告警，必要时维持 0/1 最小流程 |
| 异步发送窗口 | 用户上行后 48 小时内最多发送 5 条；文本最多 2048 字节；可指定不超过 32 字节且账号内唯一的 msgid | 多次用户上行如何刷新预算、ack+final 两条是否稳定、窗口边界、长度/Unicode 截断 | 默认最多一条 ack + 一条 final；预算不足只保 final；过窗结果等用户下次上行后再发 |
| 发送成功语义 | send_msg `errcode=0` 不代表最终成功；需读取 `msg_send_fail`。fail type 包含过 48h、会话关闭、超 5 条、主体未验证、用户拒收、安全限制等 | 成功后失败事件关联、失败事件延迟、客户端自定义 msgid、POST 超时后的重复调用语义 | outbox 只记 accepted；策略类失败终止不盲重试；若稳定 msgid 不能消除歧义，未知结果不自动重发 |
| outbox 重试 | 官方允许客户端指定唯一 msgid，但没有在文档中承诺网络歧义下 exactly-once | 连接超时、5xx、token 失效、重复 msgid、进程在发送前后崩溃 | 仅 transport/可重试 errcode 在窗口内指数退避；重复/未知结果进入人工或下次上行补发，不制造双消息 |
| 用户取消 | 官方会拉取用户撤回事件 `user_recall_msg`，包含 recall_msgid | queued/running/completed 三个阶段撤回；精确文本“取消”与任务对应关系 | recall 或“取消”只取消未产生 Core effect 的任务；已收藏则明确告知，不静默删除 |
| 解绑 | wxkf 不提供 Attention 账号绑定语义；这是 Attention 自有安全流程 | Web session 确认、冲突绑定、重放 token、解绑时 lane/Profile fence、生效延迟 | 微信“解绑”只返回一次性 Web 确认链接，不在聊天里直接解绑；安全异常可由管理员 kill switch |
| 可观测性 | 官方说明回调可能丢失，且应异步处理并额外对齐业务数据 | cursor lag、回调延迟、has_more drain、inbox/outbox backlog、state drift、失败码与隐私日志 | 自动 reconciliation、熔断、暂停新任务、只保留结果；不能观测时 fail closed |

### 8.2 G0 harness 范围

G0 harness 只能连接内部测试客服账号和测试微信用户，使用独立 callback path、数据库 schema、
secret 和部署环境；不调用 Attention Core、不启动 Pi、不打开外部网页。

它需要实现：

1. 独立 wxkf 配置与 access token cache；
2. GET/POST 加密回调端点；
3. wakeup 合并和每 open_kfid cursor puller；
4. raw fixture 捕获前的字段白名单与脱敏；
5. inbox `msgid` 去重和 cursor/insert 同事务提交；
6. 简单 echo/固定文本 outbox，使用稳定 provider msgid；
7. service state 查询/受控转换；
8. binding fake（测试 external_userid -> fake account），验证未绑定不投递；
9. 故障注入：回调超时、Adapter 重启、cursor 写前/写后崩溃、send 超时、token 失效；
10. 脱敏证据导出和一键禁用开关。

### 8.3 cursor、顺序与事务设计

- 每 `(corp_id, open_kfid)` 最多一个 pull lease。
- callback token 只是加速授权，不作为消息幂等键或顺序键。
- 读 cursor -> 调 sync_msg -> 插入所有新 msgid -> 更新 next_cursor 必须形成可恢复步骤；数据库提交
  前崩溃会重拉并由 msgid 唯一键吸收，提交后才推进。
- 即使 `msg_list=[]`，只要 `has_more=1` 也继续并保存 next_cursor。
- 官方文档没有承诺 msgid 可排序，也没有明确跨页时序。G0 前保持 API 数组/cursor 顺序，写入
  `provider_sequence`；同账号任务再按入库 sequence 排队，不按 msgid 字典序。
- 多个 open_kfid 可并行拉取；同一 account_id 的 task 最终仍在 account lane 汇合串行。
- token 过期后使用不带 token 的 reconciliation 频率必须由 G0 实测确定，不能在代码里猜额度。

### 8.4 outbox 状态机

```text
pending
-> leased
-> request_unknown | api_rejected | accepted_by_wecom
-> provider_failed | delivery_assumed
```

- `accepted_by_wecom` 不是 delivered。
- provider `msg_send_fail` 用 `fail_msgid` 关联 outbox。
- transport 失败在 48 小时窗口、发送预算和 attempt 上限内重试。
- `fail_type` 4/5/6/8/10/11/12/13 默认终态，不重复轰炸用户。
- 没有官方成功送达事件；G0 后可把超过失败观察窗且无失败事件的记录记为
  `delivery_assumed`，用户文案和指标仍不得称“已送达”。
- 一条任务最多预留两条消息：accepted ack 与 final。容量/预算紧张时跳过 ack。

### 8.5 会话、取消与解绑

- 专属 Agent 客服账号不得同时用于普通人工接待。
- 收到 origin=3 的合法消息后查询/确认 state 0 或 1；状态 2/3 视为 drift，暂停 Agent reply。
- 是否把每个任务置 1、完成后置 4 由 G0 真机结果决定；在此之前不固化状态转换。
- `user_recall_msg` 或精确“取消/取消任务”映射到该账号最新 non-terminal task。
- queued task 直接取消；running task 发 abort 并在 fence 点停止；Core 已提交后不自动删除收藏。
- 精确“解绑”只签发短期 Web confirmation。Web 当前已登录账号确认后，撤销 binding、提升 lane
  fence、取消未提交任务、停止 Profile 使用；Profile 保留还是删除由用户在 Web 选择。

### 8.6 G0 验收门

全部满足才进入 G1：

1. 有一个真实企业主体、自建应用、专属 API 管理客服账号、HTTPS callback 和两个内部微信测试用户。
2. 官方 GET 验证成功；真实 POST 可验签解密；错误签名、篡改密文、错误 receiveid 和重放策略
   按预期拒绝；回调不等待拉取或任务。
3. 20 条交错的 text/link 消息覆盖两个测试用户；注入重复 callback、Adapter 重启和 cursor
   提交前后崩溃后，inbox 每个官方 msgid 恰好一条，无丢失，cursor 能追平。
4. 真实验证 token 10 分钟过期、无 token reconciliation、`has_more` 逻辑和 per-open_kfid cursor。
5. 实测并记录批内/跨页顺序；若平台不给保证，account lane 使用 provider_sequence 而非时间猜测。
6. state 0/1 的发送成功；state 2/3/4 的行为和恢复有证据；后台误操作能触发 drift 告警。
7. ack + final 在窗口/预算内工作；自定义 msgid、重复 send、网络歧义和至少一种
   `msg_send_fail` 被正确归类，不产生已知双发。
8. 未绑定用户没有 task；绑定、冲突、解绑和撤回/取消都通过测试。
9. access token 提前失效、callback 暂停、sync_msg 失败、send_msg 失败都有有限重试、熔断和恢复。
10. 日志/trace/指标扫描不含 secret、token、cursor、完整 external_userid、完整 URL query、原始消息或回复正文。
11. 产出脱敏 evidence bundle、官方配置清单、错误码表、恢复 runbook 和 go/no-go 结论。

当前 G0 状态：官方文档证据已取得；真实平台证据尚未取得。缺少真实企业 wxkf 测试资产时，
不能把 G0 标记为通过。

## 9. 端到端任务流

1. wxkf callback 验签/解密，durable 记录 wakeup 后立即 ack。
2. puller 按 open_kfid cursor 拉消息，按 msgid 去重并原子推进 cursor。
3. origin/type allowlist 过滤；raw message 规范化为一个安全 URL 或稳定拒绝。
4. Binding Service 用渠道 HMAC 查 account_id。未绑定只创建一次性 bind intent 并发送绑定链接。
5. 已绑定消息创建 account-local sequence task；Dispatcher 按 lane claim。
6. Core 先用现有 Collector/Fetcher 做 URL 安全与确定性收藏，使用 task 幂等键。
7. Credential Broker 启动 anonymous attempt；如页面不足，按策略启动全新的 shared/user attempt。
8. Pi 只对受限 page tools 规划读取，提交带证据的正文/摘要候选；Orchestrator 校验 schema、来源和预算。
9. Core Gateway 提交第一份 grounded enrichment；并发已存在摘要时复用现有结果。
10. Orchestrator 生成固定模板回复，避免模型把隐藏指令或敏感数据带回渠道。
11. outbox 在窗口/预算内发送；provider failure 事件异步修正状态。
12. lane 释放并 claim 该账号下一任务；其他账号不受阻塞。

## 10. 首版范围与明确不做

### 10.1 首版交付

- 一个专属 wxkf 客服账号；
- 已绑定账号的一条消息一个链接；
- 普通公开网页与微信公众号公开文章；
- 私密收藏、正文读取、grounded summary、明确失败状态；
- anonymous 和批准的共享只读 Profile；
- 受控内部用户的用户独享 Profile 登录试点；
- accepted/final 两段式异步回复；
- Web 绑定、Agent 开关、Profile 管理、安全活动和解绑；
- per-account serial、多账号并行、崩溃恢复、审计和 kill switches。

### 10.2 不做

- Web 对话、群聊、普通员工外部联系人私聊 Bot；
- 多轮闲聊、开放式研究、多个链接自动选择；
- 写网页、任意表单、交易、社交互动；
- 绕过验证码、付费墙、风控或平台条款；
- 模型自主选择/导出 Profile；
- 向第三方 Agent 开放云 Browser；
- 将 wxkf conversation、DOM、截图或 Pi session 作为长期记忆；
- 对外宣称 exactly-once delivery 或“已送达”。

## 11. 阶段顺序与验收门

### G0 — wxkf 可行性与渠道合同

执行第 8 节独立 harness。验收门即 8.6；失败时不开发真实 Channel 产品链路。

### G1 — 离线合同与威胁模型

交付版本化 envelope/task/tool/outbox schema、data-flow threat model、runtime role/network matrix、
Pi Adapter、Browser action policy、Profile state machine 和 fixture corpus。

门：所有 unknown 字段 fail closed；prompt injection fixture 无法触发禁用工具；任何 tool schema
中没有 account_id/credential/profile ID；安全评审批准。

### G2 — Fake Channel 单用户纵切

用 Fake Channel + anonymous Browser 跑通一个链接：durable inbox -> lane -> Pi -> Browser ->
Core 私密收藏 -> outbox。继续使用现有 Core，不接 wxkf。

门：Worker/Pi/Browser 任一点崩溃后可恢复；同 task 不重复收藏/摘要/回复；读取失败保留收藏；
任务结束无 Browser 残留。

### G3 — 多租户 durability 与并发

增加 account lane、lease/fence、容量预算、backpressure 和可观测性。

门：账号 A 的 A1/A2 严格顺序，账号 B 可与 A1 并行；lease 丢失的旧 worker 不能产生副作用；
压力下只排队/拒绝，不跨租户；日志隐私扫描通过。

### G4 — Profile Broker 与远程登录

先交付 anonymous/shared，再以 feature flag 交付用户 Profile。远程登录与任务 Browser 分离，
只有用户在 Web session 中交互。

门：凭据顺序固定；shared/user 负面混用测试通过；模型看不到 Cookie/storage/header；跨账号
Profile 读取失败；撤销/删除/KMS rotation/worker crash 有证据。没有合格 KMS 时只允许 anonymous。

### G5 — 内部 wxkf pilot

把通过 G0 的 Adapter 接到通过 G4 的 workflow，只允许 allowlist 内部账号和专属 open_kfid。

门：真实公开网页/公众号 fixture 达到约定成功率；无重复收藏/回复；outbox failure 可恢复；
state drift、Profile 异常、模型异常和 Browser 风控都能单独熔断。

### G6 — 受限发布

完成隐私/平台条款/模型供应商审查、容量与成本预算、告警值班、备份恢复、数据删除、事故演练、
逐级 rollout 和一键停用。

门：安全与运营 owner 共同签字；先小 allowlist，再按指标扩大；任一硬指标恶化自动回退到
“只接收绑定/状态消息，不执行网页任务”。

## 12. 风险与替代方案

| 风险 | 处理 | 替代方案 |
| --- | --- | --- |
| 企业无 wxkf API 资质/主体未验证 | G0 直接 no-go | 保持本地 Agent/iLink；不把公众号或员工私聊伪装成 wxkf |
| callback 丢失/token 过期 | cursor reconciliation + 3 天恢复窗 | 若无 token 限频不足以追平，阻断上线 |
| 发送网络歧义/无成功回执 | 稳定 msgid、outbox unknown、失败事件关联 | unknown 不自动重发；用户下次上行补发结果或使用用户同意的邮件通知 |
| 48h/5 条预算不足 | 最多 ack+final，预算紧张只发 final | 结果保留，下次用户上行后发送；不绕过平台限制 |
| API 账号被人工接管 | 专属 open_kfid + state drift 告警 | 暂停 Agent，交人工或另建专属客服账号 |
| 动态页面/反自动化 | anonymous -> shared -> user Profile 分级 | 官方内容 API、用户自己本地 Agent，或标记 unsupported |
| Prompt injection | 工具级 allowlist、无 secret、固定 Core 参数 | 高风险站点使用确定性抓取/解析，不启用 Agent loop |
| Pi 上游变更 | 版本固定、本地 Adapter、stop/error 合同测试 | deterministic orchestrator + 单次模型摘要；不让 Pi 成为持久化真相 |
| KMS/Vault 未就绪 | 禁止用户 Profile | 仅 anonymous；共享 Profile 也需独立 secret 管理与授权 |
| PostgreSQL workflow 到达容量上限 | 先用指标证明瓶颈 | 保持合同迁移到 Temporal/托管队列，不改变 Pi/Core/Browser 边界 |
| 共享 Profile 违反平台条款 | 上线前逐平台授权审查 | anonymous + 用户独享 Profile，或只支持官方 API |

## 13. 需要用户决定

以下决定会改变实施路径，应在逐文件计划前确认：

1. **wxkf 资产 owner**：谁提供并管理真实企业主体、自建应用、专属 open_kfid、回调域名、
   secret 与两个测试微信账号？这是启动 G0 的前置条件。
2. **收藏可见性**：是否同意云端 Agent 首版对所有账号（包括 Filter）一律创建私密收藏？推荐同意。
3. **绑定语义**：是否同意未绑定消息不保留任务，绑定成功后必须重新发送？推荐同意。
4. **Profile 发布顺序**：是否同意首个内部 pilot 先 anonymous/shared，用户独享 Profile 必须等
   KMS、远程登录与跨租户负面测试通过后再开？推荐同意。
5. **基础设施与数据驻留**：Browser 隔离、PostgreSQL、KMS/Vault、模型 Gateway 部署在哪个
   云与地区，由谁值班？
6. **模型供应商**：首选模型、数据保留/训练开关、地域与成本上限是什么？
7. **共享 Profile 合规 owner**：谁确认平台账号授权、使用条款、失效/风控处理和人工轮换？
8. **回复体验**：采用“收到任务 + 最终结果”两条，还是只发最终结果？推荐在预算足够时两条。
9. **数据 TTL**：是否接受 raw inbox 最长 24 小时、outbox 终态后最长 7 天、仅脱敏运行元数据
   保留 30 天的建议基线？

## 14. 官方证据索引

- [微信客服概述与 API 开启条件](https://developer.work.weixin.qq.com/document/path/94638)
- [企业微信回调配置、验签与加解密](https://developer.work.weixin.qq.com/document/path/90930)
- [获取 access_token](https://developer.work.weixin.qq.com/document/path/91039)
- [微信客服接收消息和事件 / sync_msg](https://developer.work.weixin.qq.com/document/path/94670)
- [微信客服会话状态](https://developer.work.weixin.qq.com/document/path/94669)
- [微信客服发送消息](https://developer.work.weixin.qq.com/document/path/94677)
- [发送欢迎语等事件响应消息](https://developer.work.weixin.qq.com/document/path/95122)
- [企业微信通用访问频率限制](https://developer.work.weixin.qq.com/document/path/90312)
- [Pi Agent Core 上游仓库](https://github.com/badlogic/pi-mono)

官方文档说明能力合同，不等于目标企业已经取得权限，也不证明平台在本项目故障模型下无丢失、
无重复或有序。第 8 节明确列出的真实平台证据仍是发布硬门。
