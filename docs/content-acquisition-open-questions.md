# 内容采集与 AI 预处理：待设计议题

状态：待单独讨论，尚未形成最终架构决策

记录日期：2026-08-04

第一期范围以 [`docs/first-release-scope.md`](./first-release-scope.md) 为准：用户自己的 Agent 负责需要浏览器/页面理解的深度读取，Attention Fetcher 只做隔离的确定性 URL 与元数据处理；官方 Hosted Agent、托管 Browser/Fetcher 编排和 Hosted Channel 都是后续议题。

本文只记录当前实现事实、已确认的产品边界和仍需讨论的问题。本文不是实现规格，也不表示现有正则解析方案已经满足 Attention 的多平台采集要求。

## 1. 已确认的产品边界

- 用户提交一个明确链接后，云端可以读取该链接所指向的公开内容。
- 浏览范围只服务于完成这个链接的采集，不离开目标主动搜索或探索其他内容。
- 允许为了显露公开内容进行有限、无副作用的操作，例如安全跳转、关闭弹窗、展开全文、有限滚动和分页。
- 第一期不使用用户或平台登录态，不保存 Cookie，不绕过验证码、登录墙或付费墙，也不执行点赞、关注、评论、发布、购买等外部副作用动作。
- Attention 不保存原文；原始 HTML 和浏览器页面内容只可作为受限、临时的处理输入。长期保存范围仍是链接、必要元数据和 AI 派生信息。
- 抓取或处理失败时仍保留原始链接，并可显示“暂时无法生成摘要”；不能因为当前无法读取就判定链接失效。

## 2. 当前实现事实

### 2.1 Fetcher

当前 `apps/fetcher` 是一个隔离的静态 HTTP Fetcher，提供两个模式：

- `resolve`：返回最终 URL、跳转链、状态码和 Content-Type，不读取页面正文。
- `metadata`：只接受 HTML，下载受大小和时间限制的静态 HTML，并返回临时页面 body。

Fetcher 已实现逐跳 URL/DNS/IP 检查、IP pinning、HTTPS 降级保护、重定向限制、响应大小限制和超时控制。它不会执行 JavaScript，也没有 DOM、点击、滚动、截图或登录态能力。

### 2.2 当前页面解析

Worker 中的 `extractDocument()` 不是 AI 解析器，也不是完整的正文抽取器。它目前通过规则和正则：

- 读取少量常见 Meta 字段、`title`、作者、描述和发布时间；
- 删除 `script`、`style` 等内容和 HTML 标签；
- 将剩余可见文字压平并截取最多 12,000 字符。

当前测试只覆盖人工构造的简单 HTML，没有真实的小红书、抖音、公众号或其他平台页面 Fixture，因此现有测试不能证明多平台实际可用性。动态渲染、脚本状态、折叠内容、图片文字、视频字幕及复杂正文结构都可能无法获取。

### 2.3 当前 AI 能力

AI Provider 是可选能力。只有内容具备 Member 权益且配置了 `ATTENTION_AI_MODEL` 时，Summary Job 才会将规则提取出的临时文本交给 OpenAI-compatible Provider，生成摘要和标签。

当前 AI 不负责：

- 判断网页是否已经完整获取；
- 选择正文区域；
- 从动态页面恢复内容；
- 结构化识别内容类型、核心对象或页面组成；
- 决定是否调用浏览器或执行何种页面操作。

默认没有配置模型时，AI Provider 不启用，摘要状态为 `unavailable`，只可能留下规则生成的 fallback tags。

## 3. 尚未封口的问题

### 3.1 如何判断“采集结果已经足够”

需要定义可测试的 Sufficiency Contract，而不是仅用“Fetch 成功”或“有一些文字”判断完成。后续至少要讨论：

- 不同内容类型的必需字段：标题、作者、发布时间、正文、封面、视频信息等；
- 正文长度、文本密度、重复率、占位文案、登录提示和挑战页的识别；
- 字段的来源与置信度：分享消息、HTTP Meta、静态 DOM、渲染 DOM、平台 Recipe、AI 推断；
- 通用阈值与平台专用阈值的边界；
- `sufficient`、`partial`、`ambiguous`、`login_required`、`challenge`、`unsupported`、`failed` 等状态；
- AI 能否参与判断，以及 AI 判断只能作为信号还是可以决定升级到 Browser；
- 摘要、标签和公开展示分别需要达到什么证据门槛。

### 3.2 完整采集链路如何分层和降级

需要单独比较并确认类似下面的候选链路：

```text
分享消息自带信息
→ URL resolve / 静态 Fetcher
→ 正规 HTML/DOM 解析
→ 平台 Source Recipe
→ 匿名 Browser Worker 渲染与有限操作
→ Sufficiency 判断
→ AI Content Processor
→ 持久化必要元数据与派生信息
```

仍需明确：

- 哪一层成功后可以短路，哪一层失败后必须升级；
- Browser 是只做平台 Recipe，还是也允许受限的通用启发式操作；
- AI Content Processor 的输入、输出 Schema 和事实依据；
- 多候选内容、短链接跳转和最终 canonical URL 的处理；
- 超时、重试、缓存、幂等、成本预算和平台熔断规则；
- 异步处理期间，Web 与用户自己的 Agent 如何回执和更新状态；企业微信客服属于后续 Hosted Channel 议题。

### 3.3 Fetcher 的逻辑调用方与工具边界

已确认的长期原则是：Agent 是网页采集的逻辑规划者。第一期这个 Agent 是用户自己的本地 Agent；未来 Hosted Agent 上线后再由官方 Runtime 承担同一职责。Agent 根据 Skill 自主决定何时读取公开网页、何时升级 Browser、何时停止或向用户澄清。

同时需要保持以下边界：

- Agent 调用受控的 Runtime 网页工具，不直接获得 Fetcher 地址、共享密钥、任意 HTTP、JavaScript 或底层浏览器权限；
- Fetcher 与 Browser Worker 仍是受控执行后端，负责 SSRF、跳转、动作、网络和预算硬限制；
- 第三方 Agent 使用自己的 Browser/Search，并通过公开 Attention MCP 调用 Core 收藏与检索工具；第一阶段不向第三方开放 Attention 托管的 Fetcher/Browser；
- 官方 Agent 与第三方 Agent 对收藏、去重、权限、可见性和贡献使用相同的 Attention Core Tool Contract；Runtime 网页能力不属于 Core 业务接口；
- Skill 负责默认工作流和工具组合，Core 与执行器负责不可绕过的安全和业务规则。

尚未确认的是 Runtime 网页工具内部的 Sufficiency、Fetcher/Browser 升级策略、开源实现与自研实现选择，以及异步执行和 Agent 控制循环之间的具体合同。

## 4. 后续独立设计需要产出的结果

下一次讨论应形成一份独立、可实现的 Content Acquisition 设计，至少包括：

1. 采集输入、阶段状态和最终结果 Schema；
2. Sufficiency Contract 及真实平台 Fixture/Golden Test 方案；
3. Fetcher、DOM Parser、Source Recipe、Browser Worker、AI Processor 的职责边界；
4. 用户 Agent（以及未来 Hosted Agent）、Collector、MCP、Worker 与采集编排器之间的调用关系；
5. 异步回执、错误分类、重试、幂等、缓存和成本策略；
6. SSRF、Prompt Injection、浏览器沙盒和无登录态边界；
7. 小红书、抖音、微信公众号和普通网页的后续深度采集验收标准。

在上述设计完成前，不应把当前正则解析的成功等同于“内容已完整采集”，也不应把现有 Fetcher HTTP 合同直接固化成 Agent Tool Contract。
