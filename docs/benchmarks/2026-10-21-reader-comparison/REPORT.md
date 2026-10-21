# 网页读取对照：Attention、Agent-Reach/Jina、Firecrawl

日期：2026-10-21（Asia/Shanghai）。状态：Attention 与既有 Agent-Reach/Jina 已完成；Firecrawl 等待免费账户连接。

## 测试范围

同一组 5 个公开链接：Python 官方介绍、MDN Using Fetch、Attention 原有公众号文章、另一篇由公开播客引用的公众号文章，以及 example.com 短页对照。完整 URL 见 [samples.json](./samples.json)。每个有效测试条件、每个样本各运行一次，未使用付费 API、真实业务数据库或模型 API，没有改生产代码或系统网络配置。

Attention 使用当前工作区的 `readDocument`、`safeFetch` 与 Readability 提取器，browser 后端为 null。既有方案位于独立 checkout，使用真实 `readAgentReachSource`、生产 Docker 执行器、固定 Agent-Reach 1.5.0 镜像和匿名 Jina；未合入当前工作区。这是本地实现对照，不是线上 Attention 服务验收。

## 原配置结果与网络对照

两条本地链路原配置均为 **5/5 在获取目标正文之前被拦截**，原因是本机 DNS 返回 `198.18.*` 假 IP；Attention 为 `failed/unsafe_source`，Agent-Reach 为 `blocked/unsafe_source`，其 worker 报 `upstream_policy_blocked`。这不能用于评判网页提取能力。

为获得有效样本，额外运行了两种独立网络诊断变体：

- Attention：只在测试进程注入 Cloudflare HTTPS DNS 解析器。原公网地址检查、连接地址固定及核验、TLS、重定向策略、超时、提取器均保留。
- Agent-Reach：只为本轮临时 Docker 容器追加 `--dns=1.1.1.1`；先确认 Jina 域名解析为公网地址。原镜像、代码、审计检查和清理流程保留。

没有修改 macOS DNS、代理配置、生产配置或原接入方案的代码。下表是这两种诊断网络条件下的结果，不能冒充原配置直接运行的表现。

## 正文结果

| 样本 | Attention（进程公网 DNS） | Agent-Reach/Jina（容器公网 DNS） | 内容核对 |
| --- | --- | --- | --- |
| Python 官方介绍 | `ready`，0.767 秒，505 字符 | `ready`，4.181 秒，12,000 字符，截断 | Attention 主要是降级提示和最新新闻，缺少四个主体板块，属于不完整结果。Jina 保留了四个板块，但主要内容约到第 7,914 字符才开始，导航占用了大量窗口。 |
| MDN Using Fetch | `ready`，0.688 秒，12,000 字符，截断 | `ready`，3.832 秒，12,000 字符，截断 | Attention 保留多处代码示例，已覆盖到 Handling the response。Jina 原始结果缺少检查的多处代码示例，适配后的 12,000 字符尚未覆盖 Canceling a request / Handling the response；Markdown 链接占用较多窗口。两者都不能称为完整文章。 |
| 公众号样本 A（原有样本） | `verification_required`，1.643 秒，无正文 | `evidence_insufficient`，4.133 秒，无正文 | Jina 原始返回为 312 字符的 CAPTCHA/环境异常提示；没有取得文章。Attention 的失败分类更准确。 |
| 公众号样本 B（公开引用） | `verification_required`，0.421 秒，无正文 | `evidence_insufficient`，4.607 秒，无正文 | 同样仅取得验证页，没有取得文章。 |
| example.com 短页对照 | `browser_backend_unavailable`，0.374 秒，无文章正文 | `evidence_insufficient`，1.305 秒，无文章正文 | 这是短页对照，不是长文章失败样本。两者都未将其作为可摘要文章交付；Attention 将其导向未配置的浏览器回退。 |

字符长度使用各实现返回的长度字段；Attention 是清理后的文本，Jina 是 Markdown，不能把长度直接当成信息量。Python 含 emoji，JavaScript UTF-16 长度与 Python Unicode code point 长度略有不同。

## Firecrawl 当前状态

对 Python 样本发起了一次匿名 `/v2/scrape` 请求，1.047 秒返回 HTTP 403。服务端明确表示当前出口被识别为 VPN/代理，匿名模式不可用，需要免费账户 API key。

没有使用账户 key，没有付费调用，也没有取得 Firecrawl 正文；因此暂时不能比较 Firecrawl 抓取成功率或内容质量，也不能声称已消耗或核验账户免费 credits。用户已表示会连接 Firecrawl，等待连接后用同一组样本补测，并核对调用前后额度。其余样本没有继续匿名重试。

## 当前可以得出的判断

1. 当前本机网络配置会同时阻塞 Attention 和 Agent-Reach；换供应商前需要区分这类运行环境问题。
2. Jina 对 Python 页面保留的主体内容更多，但导航噪声很大；在 MDN 技术文章样本上，现有 Attention 的代码保留和有限窗口利用更好，不能据此认定 Jina 普遍更优。
3. 两条链路都未取得这两篇公众号文章。Jina 返回验证页后被现有适配器分类为“正文不足”，丢失了更明确的验证原因。
4. `ready` 仅表示通过了当前规则，不代表抓到了完整、正确的文章。Python 样本展示了需要核对内容的原因。

这是单次、小样本对照。两种诊断变体的 DNS/运行环境不同，Jina 可能使用服务缓存，计时包含各自调用和适配成本；这些数字不构成稳定速度排名或总体成功率。Firecrawl 尚未完成前不作三者选型结论。

## 证据

- [代码指纹、方法与 Firecrawl 阻塞记录](./methodology.json)
- [Attention 原配置](./attention-results.json) / [公网 DNS 对照](./attention-public-dns-results.json)
- [Agent-Reach 原配置](./jina-results.json) / [公网 DNS 对照](./jina-public-dns-results.json)
- [内容标记检查](./quality-checks.json)
- [本机 DNS 观测](./dns.json) / [Attention 公网解析响应](./public-dns-evidence.json) / [Jina 容器公网 DNS 预检查](./jina-public-dns-preflight.json)

持久报告仅保存 URL、状态、耗时、结构指标、散列和检查结论，不保存第三方文章正文。本轮临时 Docker 启动前无其他容器，结束确认空容器清单后已停止。
