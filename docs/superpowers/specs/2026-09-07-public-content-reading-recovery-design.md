# 公开内容读取与摘要恢复：Worker / Bridge 联合修复

日期：2026-09-07。状态：用户已批准联合修复范围；本书面设计待审阅，尚未进入实现。

## 1. 目标与范围

让已经收藏的公开链接获得可验证的正文读取、基于证据的摘要和可解释的恢复行为。保留现有 Worker 提取器修复，让 Bridge 不再仅依赖 Codex 原生网页读取工具；Hosted H2 复用同一公开读取合同，不将 H2 整体实现或上线计入本次交付。

本次只做本地代码、测试和候选安装产物验证。不合并 main、推送、发布、部署、改变线上配置、替用户重新授权、重启用户服务或批量重放真实收藏。后续执行这些操作需要明确授权。

本次不做登录态浏览器、Cookie 导入、验证码自动处理、付费内容读取、任意搜索、任意浏览器点击、用户端页面改版或数据库历史数据批量修复。

## 2. 已确认的依据

### 2.1 Bridge 失败记录

截图所对应的本地 Bridge 为 0.3.15，收藏及后续状态查询的 Attention MCP 调用有效。Codex 原生网页读取在初次执行、追问及三次自动重试中返回无法打开页面的 non-retryable error；没有成功取得正文，也没有摘要补全提交。

`apps/cli/src/channel/summary-retry.ts` 只收到 incomplete，并将失败统一记录为 enrichment_incomplete。`collection-reply-control.ts` 从 MCP 结果确认收藏和摘要状态，没有读取器结果合同。原生工具对这条 URL 的失败不能证明该文章已经删除、全球不可读或一定由微信反爬导致。

`prompt.ts` 与 `brains/codex.ts` 明确限制机器人只能使用 Attention MCP 和原生公开网页读取，禁止通用浏览器、shell、个人文件及其他 MCP。恢复能力必须由可信应用增加，不要求模型违反当前权限边界。

### 2.2 关联任务已完成的代码

任务「排查 fetch 信息不完整」（01a079db-e6a9-7b30-a051-845b4f252500）已经在当前工作区完成但尚未提交或部署：

- `apps/worker/src/document-extractor.ts` 及测试：JSON-LD / HTML 元信息、Readability 正文识别、去除导航后再截断。
- `apps/worker/src/production-handlers.ts` 及测试：拒绝目标站非 2xx 响应、无正文或简介时不调用模型。
- `apps/worker/package.json`、`pnpm-lock.yaml`、README 的相应依赖和说明。

该任务记录中有 114 项相关测试、Worker 构建、Node 24 类型检查与 ESLint 的成功结果。这些是既有修复的验证记录，不替代联合修改后的重新验收。无关 `.codex/` 保持原样，不纳入提交。

### 2.3 联合修复还需补齐

- 现有 Worker 修改不影响 Bridge 的原生读取路径。
- Worker 读取失败返回 null，丢失 429、超时、无配置等区别。
- 本次合成样例复现：HTTP 200 的验证提示正文仍会被提取为文章；HTTP 成功不等于获得文章证据。
- 仅有简介不等于已读到文章正文；不能把简介扩写后标成完整摘要。
- Worker 的 unavailable、任务重试耗尽与 Core 内容是否仍可补全必须分开；任何单个读取来源的失败都不能自动代表全局终态。

## 3. 选定方案

选择“统一读取结果合同 + 服务端受限读取工具 + 分环境接入”。只交付 Worker 提取修复虽然更小，但无法修复 Bridge 的已确认问题；开放机器人通用浏览器会扩大权限且难以复用，因此不采用这两种方式作为本次完整解决方案。

调用关系：

```text
Worker 已验证任务 ─────────────────┐
Bridge → Attention MCP → Core 归属校验 ├→ Fetcher 受限读取 → 证据分类 / 提取
Hosted H2 → task-scoped Gateway ───┘                    ↓
                                      静态 HTML → 必要时匿名 Browser Worker
                                                       ↓
                                   统一 ReadResult → 各自模型 / 重试 / 回复
```

共享的是提取实现、读取结果和恢复规则，不共享用户登录态、账号凭据或运行中浏览器。Bridge 继续使用本地 Codex 生成摘要，不以配置 Hosted 模型或支付 Hosted 模型费用为前提。新增读取服务不可用时，普通对话和已支持的收藏操作仍独立工作。

### 3.1 模块边界

| 模块 | 职责 |
| --- | --- |
| `packages/content-reader-contracts` | 无网络和浏览器依赖的结果 schema、错误分类和预算合同；可供 CLI、Worker、Web、H2 使用 |
| `packages/content-reader` | 保留并迁移现有提取器、元信息与正文来源标记、文档分类；不读取环境变量、不发请求、不执行网页脚本 |
| `apps/fetcher` | 复用现有 safeFetch、DNS 固定和 URL 校验；增加内部 `/v1/read`，管理静态读取、浏览器适配及有界预算 |
| 隔离 Browser Worker | 一次尝试一个匿名实例，通过受控出口读取公开页面；不与 Web / DB 同进程、不持有业务密钥 |
| Web Core / 工具 Registry | 校验账号和收藏，解析准确 source，调用内部读取器，并向 MCP / 同权限 Web API 输出合同 |
| CLI Bridge | 读取能力协商、可信工具事件解析、重试状态持久化、事实回复、会话重建 |

保持 `production-handlers.ts` 的提取器重导出，便于已有调用方与测试迁移。不要复制出第二份正文算法。Fetcher 原 `/v1/fetch` 保留，避免破坏链接解析和旧 Worker。

## 4. 受限读取入口

新增 MCP 工具 `attention_read_collection_source`，输入为 `collection_id`、`attempt_ref` 和既有 `client_context`，严格拒绝额外字段。模型不能提交 URL、HTTP headers、Cookie、账号 ID、浏览器 Profile、脚本或代理地址。

`attempt_ref` 为最多 128 字符的安全操作引用，仅用于归属内的有界去重和预算；它不是授权凭据。每次请求必须重新检查当前有效账号、Member/Filter 能力、collection:read scope、收藏归属、内容安全状态及 enrichment_action。工具只对拥有该读取权限的调用方可见。伪造或重用引用不能跨账号读取。

去重键包含 account、collection、attempt_ref 与服务端 source revision。并发相同请求只执行一次；不同来源版本不得复用旧结果。短期复用的正文仅在受限内存中保留最多 120 秒，每账号最多一个 12,000 字符结果；再次返回前重新鉴权。共享协调只保留执行占用与结果类别，不在共享数据库写正文；原执行实例退出后释放/过期占用，在预算内开启新读取，不冒充已完成响应。

- generate_summary：只读当次 Core 返回的准确 public_read_url。
- reuse_summary：返回 skipped，reason=already_ready；不访问外网、不调用模型。
- none、未归属、隐藏、删除或不符合安全条件：不访问外网；沿用 Core 对外的信息披露边界，不暴露其他账号内容是否存在。
- 读取结束、返回临时正文前重新检查归属、权限与内容资格；失效则丢弃正文。

对应 Web 入口为 `POST /api/collections/[collectionId]/source-read`，复用相同服务端逻辑、会话鉴权与现有 Origin / CSRF 检查，不新增用户导航入口。源 URL 获取逻辑不复制进两个 transport。

内部 Fetcher `/v1/read` 仅接受可信服务器凭据；Bridge 只持有已有 Attention OAuth 凭据，不下发 FETCHER_SHARED_SECRET。保护端点不得成为可匿名调用的任意 URL 抓取代理。

服务端按账号和并发限制外网读取。初始限制为每账号同时 1 次、每分钟最多 6 次请求，单条 attempt 同时最多 1 次读取；全局浏览器最多 2 个。限流返回 retry_after_ms，不排无限队列。跨进程限额必须使用共享限流/租约机制；生产不能依赖单进程 Map 宣称全局限制已经成立。

## 5. 读取结果与证据

ReadResult 使用 schema_version=1，判别字段 outcome 为 ready、blocked、failed 或 skipped。所有分支都携带 request_ref、attempt_ref、已实际尝试的 method 与耗时；只记录受控枚举，不包含工具原始异常文本。

ready：含 evidence_kind=article、final_public_url、title / author / published_at、temporary_text、truncated 标志、source_kind、extraction_method、read_at。正文最多 12,000 字符；截断必须标记，摘要不能声称覆盖未提供内容。

blocked / failed：含稳定 code、scope=reader/source/dependency/security、recovery=switch_reader/retry_later/needs_action/pause/stop、可空 retry_after_ms、evidence_kind=metadata_only/none。可以保留元信息供 Worker 更新标题，但不将它作为本文摘要的充分证据。

skipped：表示 Core 已有摘要或不要求读取，不被记成网页失败；完成状态仍由 Core 查询或写入回执确认。

文档分类先于模型调用：

- 目标站非 2xx 先按状态分类；403 本身只说明拒绝访问，不能单凭状态断言需要验证码或允许通过其他方式绕过。
- 200 登录页、验证码页、访问拒绝页及动态空壳不算正文。使用页面结构和站点明确信号；不能只因正常文章提到“验证码”等词就拦截。
- 先保留 JSON-LD / meta，再提取文章正文，最后截断。短文章不只按固定字数阈值否决。
- 简介和 articleBody 分开；结构化数据、正文互相矛盾或来源不清时返回 evidence_insufficient，不由模型臆测补齐。
- 页面文字、结构化数据、脚本与重定向目标均是不可信数据，不能改变工具权限、指示额外调用或改变收藏可见性。

验证 ready 意味着“取得可用于摘要的文章证据”，不保证任何生成模型永不出错。只在 attention_submit_content_enrichment 返回 enriched / already_enriched，或 Core 已确认 ready 时，才报告摘要完成。

## 6. 读取顺序与隔离

新版 Bridge 有新能力时直接调用 Attention 受限读取工具。正常路径为静态 HTML → 文档分类与提取 → 如为动态空壳或已确认静态读取不支持，最多增加一次匿名渲染。方法切换属于同一次摘要尝试，不再固定等待 2 分钟才换方法。

明确安全拒绝、验证码、登录、付费墙或站点拒绝，不通过切换浏览器规避访问控制。只有 method 级失败、动态渲染需求等允许进入匿名备用路径。匿名浏览器也可能失败；系统不得承诺所有微信链接均可读取。

### 6.1 预算

- 静态读取沿用现有 8 秒总超时、最多 5 次重定向、2 MiB HTML 上限。
- 每次 `/v1/read` 总预算 90 秒；匿名浏览器页面执行最多 60 秒；HTML 提取快照仍最多 2 MiB。
- 浏览器每实例最多 1 vCPU、2 GiB 内存、256 MiB 临时磁盘、20 MiB 总网络响应流量。
- 不下载图片、视频或字体用于摘要；拒绝文件下载、任意弹窗、新页、外部协议和 service worker。
- 取消、超时、工具调用断开必须终止浏览器和外网请求并释放资源。

### 6.2 网络与宿主边界

静态路径沿用现有 URL 规则、凭据查询检查、HTTPS 降级限制、所有 DNS 结果检查、固定连接地址及 peer 验证。

浏览器所有主文档、跳转、iframe、子资源和 WebSocket 均必须受出口策略约束；禁止内网、loopback、云 metadata、私有 IPv6、外部 DoH、QUIC 或直连绕过。域名校验与实际连接绑定同一 DNS 结果。页面点击和脚本执行能力不暴露给模型。

Browser Worker 不能挂用户目录、宿主 socket、业务环境变量、OAuth 密钥或数据库凭据；非 root、只读根文件系统、开启 Chromium sandbox、临时文件使用限额存储。仅创建 BrowserContext 或增加路由拦截不算完成进程/网络隔离。

本地实现需提供可验证的隔离启动和出口配置。真实匿名浏览器验收前必须通过私网子资源、DNS rebinding、重定向与直接出口负面测试。若运行环境无法提供该边界，返回 browser_backend_unavailable，保持静态模式；明确标记浏览器能力未验收，不以 fake adapter 通过冒充完整交付。

## 7. 错误分类与自动恢复

| code / 情况 | 动作 | 是否重新走相同方法 |
| --- | --- | --- |
| reader_unsupported / render_required | 有获准备用方法时立即切换；否则暂停说明缺少能力 | 同一次尝试不重复 |
| network_timeout / dns_failure / upstream_5xx / rate_limited | 按依赖预算退避，遵守 Retry-After | 条件允许且预算内可重试 |
| source_content_pending | 只有明确站点适配信号证明内容仍在生成时，使用内容重试预算 | 最多 3 次自动尝试 |
| login_required / verification_required / access_denied | needs_action 或解释性暂停；保存明确证据类别 | 不自动重复 |
| source_not_found / source_gone | 停止当前来源尝试，保留收藏 | 不自动重复 |
| unsafe_source / permission_revoked / content_ineligible | 停止，丢弃读到的数据 | 禁止重试 |
| evidence_insufficient | 先耗尽获准的不同读取方法，再暂停请求更充分的来源 | 不盲目重复 |
| unknown_reader_error | 保存 unknown，不猜原因；最多一次延迟重试后暂停 | 有界一次 |
| reader_not_configured / browser_backend_unavailable | 未配置直接解释性暂停；已配置服务失联才使用依赖预算恢复 | 不消耗内容重试次数 |

沿用内容自动尝试上限 3 次与 2 / 10 / 30 分钟间隔，但只对可能改善且有依据的内容暂态启用，不让所有 pending 都进入该分支。依赖恢复采用 Hosted 合同的 5 秒、30 秒、2 分钟、5 分钟间隔，最多初次加 4 次恢复调用且整个周期不超过 15 分钟；任一预算耗尽暂停。与已有 MCP / Codex 恢复主管协调，不能双重计时或多个循环同时执行。

source_content_pending 不能从页面的“Loading”字样或 Core 的 summary_status=pending 推断；没有明确站点协议证据就按 render_required 或 evidence_insufficient 处理。unknown 的单次延迟重试为 2 分钟，并计入已有恢复周期，不因错误类别变化刷新预算。

Bridge 增加可信 ReadAttemptControl，从受限读取工具的结构化响应采集 method、code、recovery 和 retry_after_ms；不得靠模型回复或错误文字正则猜状态。进入 summaryRetries 的仍只允许无正文、无 URL、无 Cookie 的摘要任务事实。

状态迁移应兼容现有 state.json：旧 enrichment_incomplete 视为 legacy_unknown，保持原有暂停/计时和次数，不因升级重置所有预算；下一次获准尝试取得新分类。新 schema 不覆盖旧文件造成降级不可读；升级前保留可恢复备份，回滚不得自动重新排全部任务。

用户查询状态只查询，不隐式再读取。明确“重试/补一下”才创建或提升原任务尝试；重复消息与手动/自动竞态使用既有幂等键和串行约束，先检查 Core 是否已经完成。机器人在此期间仍能响应普通对话。

## 8. Worker 与 Core 状态一致性

Worker 消费同一 ReadResult，不再把读取器所有异常变成 null，也不把错误页文字送入 AI。

- ready/article 才调用摘要模型；metadata_only 只更新获准元信息。
- 网络、限流、读取配置或单个读取器失败记录到 Job / attempt，不能直接将共享 Content 写成永久 unavailable。
- 暂停恢复不等于撤销收藏，也不自动写隐藏/删除/安全状态。
- 现有 Worker exhausted-job / stale-job 恢复路径同样要检查失败类别，不能通过兜底 SQL 把可恢复读取问题转成全局终态。
- 已 ready 或 hidden 的结果不能被迟到 Worker、超时任务或旧快照覆盖。重复摘要提交复用 Core 原有 conditional write / already_enriched 语义。

首次交付不批量修改历史 unavailable 行，也不重放真实队列。若验收发现必须修复历史数据，单独列出精确条件、影响数量和可回滚操作，等待授权。

## 9. 回复与数据保留

回复继续由 AI 根据事实组织，不固定业务话术。ReplyFacts 至少包含收藏已保存、摘要是否完成、当前阶段、实际尝试方式、失败类别、下一次时间以及用户可做的操作。

只有成功持久化调度后才能说“已安排”；只有开始执行且执行权有效时才能说“正在做”。读取器失败只能表述该方式未取得正文，不无依据地归因于微信或断言文章不可访问。取消和终态通知沿用可靠发送流程。

Attention 服务端不落盘 HTML、全文、浏览器截图或 Cookie；正文仅用于短期读取响应与当前模型调用，不写数据库、审计、报错、trace 或访问日志。流量与 token 日志只保留统计和脱敏类别。小型合成测试 fixture 可入库，真实页面全文不作为生产日志保存。

Codex 作为独立宿主可能将工具结果保存在本地会话记录中；不得宣称 Bridge 路径“正文绝不落盘”。需检查受支持的宿主保留配置并明确实际行为，不能偷偷删除用户会话记录。新的服务端读取也不改变已有模型供应商授权范围。

## 10. 兼容与候选产物

新能力通过工具清单 / capability manifest 协商，Registry、输入输出 schema、MCP / Web 权限与文档同时更新，不只在提示词里增加名称。MCP 工具合同从当前 1.6.0 做兼容性递增；旧工具输入输出保持有效。

- 新服务器 + 旧 CLI：旧工具继续工作，不能宣称旧 Bridge 已获得本修复。
- 新 CLI + 新服务器：启用受限读取工具，使用新分类和恢复。
- 新 CLI + 旧服务器：普通对话和收藏不被判为 MCP 全局失败；显式提示缺少新读取能力。允许保留已获准的旧原生读取，但不得让其 non-retryable 结果继续自动原路循环；无法得到可信具体原因时记录 unknown。
- 新 Web / Worker + 旧 Fetcher：识别 /v1/read 不存在，明确兼容模式只支持静态旧接口，依然执行新版提取和目标状态检查，不谎报浏览器可用。

新增工具会改变 ATTENTION_BRIDGE_PERMISSION_PROFILE_SHA256。版本、工具白名单、安装产物、manifest hash 和会话指纹必须一致；遵守现有 consent_required 路径，不修改 hash 或跳过确认以实现静默升级。当前用户对开发范围的同意不代表替所有安装用户接受新权限。

实现阶段在批准的本地候选版本中重建 CLI / Bridge 产物，验证版本和哈希；不在设计阶段提前占用版本号或更新线上 latest。权限已确认且升级切换成功后，重建旧受限会话，保留账号、收藏与重试记录，不要求重新扫码作为默认流程。

## 11. Hosted H2 边界

H0 / H1 工作树 `codex/hosted-agent-persistence` 保持独立，本次不以共享 reader 为由合并其数据库迁移。公共 reader 包不反向依赖 H1 内部存储和私有 Gateway。

H2 后续通过 task-scoped Gateway 适配 ReadResult 到已有 task stage、failureCode、needs_action、waiting_dependency 和预算逻辑；继续遵守 lease / fencing 和提交前权限复验。可增加合同 fixture 与适配说明，但不将 Fake Channel 或 fake reader 的测试称为 Hosted 实际运行验收。

## 12. 实施分组与验收

各组独立测试、审阅和提交，最后联合验收；分组是可审查边界，不要求把每组所有改动强行压成一个提交。

1. **提取与结果合同**：纳入并保留已完成 Worker 修复；共享提取模块、200 验证/登录页识别、metadata-only 标记、错误分类、Worker 非终态保护。
2. **受限读取能力**：Fetcher 静态 / 匿名渲染、网络隔离与预算、账号归属入口、MCP / Web 对等权限和 capability 协商。
3. **Bridge 接入与兼容**：可信读取事件、自动/人工恢复、事实回复、旧状态迁移、权限确认和会话重建、候选安装产物一致性。附 H2 适配合同。

### 必须通过的测试

- 保留关联任务 114 项覆盖，新增 JSON-LD、短文、元信息冲突、导航噪声与截断来源断言。
- 区分 403、404、410、429 + Retry-After、5xx、200 验证页、200 登录页、空壳、普通短文章；正常文章讨论验证码不误判。
- 缺正文不调用摘要模型；单个来源失败不永久关闭 Core 补全；ready / hidden 不被迟到任务覆盖。
- 动态空壳静态失败后真实匿名渲染成功；方法切换最多一次；取消、超时、限流、浏览器关闭后无遗留进程。
- URL / DNS rebinding、IPv4 / IPv6 私网、主文档与子资源跳转、HTTPS 降级、元数据地址、Cookie 和任意参数注入的负面测试。
- 跨账号收藏 ID、撤权、读取途中删除/隐藏、重放 attempt_ref、无 scope 调用，均不能得到正文或触发未授权外网请求。
- Bridge 读取器错误到持久化分类与实际下一步一致；只查询不再读取，重复催问不重复扣预算或收藏；无 MCP 时仍可普通对话。
- 升级前后四种服务端 / CLI / Fetcher 组合、旧 state.json、权限确认、安装文件哈希与会话重建。
- Worker / Fetcher / CLI / Web 相关回归、全工作区类型检查、受影响 lint、构建和安装产物合同测试；必要 DB 回归使用隔离测试数据库，不连线上数据库。

### 真实样例验收

使用用户这条公开微信文章、此前 MDN / GitHub 同份 HTML，以及一个可控动态文章 fixture。匿名读取真实 URL 的测试与合成 fixture 分开记录。真实样例只做读取与提取验证；端到端摘要写入使用合成账号/隔离数据库，未经单独授权不修改用户真实收藏或发送微信消息。

记录每层结果：最终 HTTP 状态、文档分类、提取来源、有效正文是否取得、摘要写入回执及恢复动作。不得用另一个可读 URL 替代失败的微信链接宣布成功；若平台仍拒绝，明确报告可控软件修复通过但该真实链接仍受限。

完成说明必须区分：代码和 fixture 已验证、匿名浏览器边界已验证、真实样例已读取、候选产物已验证、是否合并、是否发布部署。这些状态不能相互替代。

## 13. 设计自检与下一步门槛

本设计保留已有 Worker 修复，补足共同失败分类与受限读取，没有纳入私人登录态、完整 Hosted H2 或生产变更。取消、状态查询、读取、提交和通知的事实来源分离；所有恢复都有次数/时间/资源上限。

实现前由用户审阅本书面设计，尤其是：服务端受限读取而非开放本地浏览器、新工具权限指纹可能要求升级确认、真实浏览器隔离未通过时不得宣称完整交付。批准后按三个分组编写带失败测试和精确文件边界的实施计划，再开展实现。
