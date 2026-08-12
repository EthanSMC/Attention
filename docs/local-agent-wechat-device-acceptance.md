# Local Agent + 微信真机验收

状态：第一版发布门槛。自动化测试不能替代本页的手机与真实 Agent 验收。

## 范围

分别用 `codex` 和 `claude-code` 完整执行一次。两者必须使用同一个公开
Attention CLI、Skill、MCP Contract 和 OAuth，不允许用开发仓库源码或手工注入
token 绕过用户路径。

## 干净设备起点

1. 宿主 CLI 已安装，版本满足公开 manifest；没有 Attention MCP、Skill、OAuth
   或 `~/.attention/channel/` 历史状态。
2. 从 `/doc` 复制唯一提示词给 Agent。Agent 必须自行阅读对应宿主文档，下载公开
   CLI 与 Skill，并校验 manifest 声明的 SHA-256。
3. OAuth 在浏览器中由用户确认。聊天、命令输出、日志和仓库中均不得出现 OAuth
   token、API Key 或 iLink token。

## 接入验收

1. Agent 真实调用 `attention_get_my_account`，显示当前展示名、Attention ID、
   Member/Filter 权限；只看到 MCP 配置不算通过。
2. Agent 运行：

   ```text
   attention channel start <codex|claude-code> --origin <Attention 地址> --background
   ```

3. 终端展示二维码并停下等待用户。扫码确认后，命令明确报告用户级后台桥已启用。
4. 关闭启动终端并重新登录桌面会话，微信消息仍能被接收；不得依赖 root 服务。
5. `attention channel status --json` 只展示登录布尔值、后台配置状态、脱敏账号前缀、
   运行阶段、时间、稳定错误码与队列计数；不出现 token、Codex thread/session ID、
   message ID、URL、回复、完整微信身份或消息正文。

## 内容矩阵

依次从同一个微信会话发送，并在每一步同时核对微信回执和 Web“我的收藏”：

| 输入 | 通过标准 |
| --- | --- |
| 普通 HTTPS 链接 | 可选收到简短“正在收藏…”，并必须收到最终结果；Web 出现同一收藏 |
| 小红书直链 | 识别为小红书来源，不把分享模板当 URL |
| 小红书完整分享文案（含短链、Emoji、话题） | 提取候选并保存用户确认的目标 |
| 抖音直链 | 识别为抖音来源 |
| 抖音完整分享文案 | 提取短链/候选，不保存营销下载页 |
| 微信公众号文章链接 | 保留公众号原文链接 |
| 微信引用/链接卡片 | 从 `ref_msg.title` 与嵌套 `message_item` 得到标题和链接 |
| 同一条消息含两个有效链接 | 返回候选；用户选择前不得创建收藏 |
| 重复发送已经收藏的链接 | 不创建重复项，并保留原有公开/私密状态 |
| 非文本图片 | 明确说明当前只处理文字/链接，不伪装成功 |

Filter 新收藏默认公开，Member 新收藏默认私密；用户在消息中明确指定公开/私密时
必须覆盖默认值。最终成功必须来自 Attention MCP 的真实结果，而不是 Agent 自述。

## 会话、故障与无损要求

1. 收藏后追问“刚才那篇讲了什么”，应续接同一宿主会话。
2. 发送 `/reset` 后应建立新会话；伪造/失效 session 应自动降级为受限历史回放。
3. Agent 正在处理时中断进程，再启动后台桥：已经持久化的入站消息仍会继续处理。
4. 回执发送失败后恢复网络：待发送回执必须重试，`client_id` 保持稳定，不重复发送
   已确认回执。
5. 一次积压超过 5 条时，全部消息最终都处理；5 只是单轮批量上限，不是丢弃上限。
6. iLink 登录过期时，后台服务停止且不在无人值守状态弹二维码；用户重新运行同一
   `--background` 命令扫码后恢复。
7. 第二个桥实例必须被本地锁拒绝；崩溃留下的旧锁必须可自动恢复。

## 本地 Agent 补全共享摘要

以下验收分别用 `codex` 和 `claude-code` 执行。使用两个 Attention 账号和两个此前
没有被 Attention 收藏过的公开测试页面；不要用已存在摘要的链接冒充首次补全。
页面应包含一段可人工核对、但不会出现在其他页面中的事实，以判断摘要是否真的
来自原文。宿主没有提供可观察的公开网页读取证据时，记录为“读取不可观察”，不得
仅凭 Agent 自述判定公开页面读取成功。

### 首次补全与第二账号复用

1. 账号 A 从指定微信收藏会话发送测试链接。首次调用必须是
   `attention_collect_content`，成功结果包含同一 `content_id`、
   `summary_status=pending` 和 `enrichment_action=generate_summary`。
2. 只有在收到 `generate_summary` 后，宿主才可用最小公开网页读取能力读取该链接。
   不得使用 Shell、本地文件、登录态浏览器、Cookie 或其他 MCP。Agent 基于公开原文
   生成不超过 2,000 字符的摘要和 1–8 个标签，并调用
   `attention_submit_content_enrichment`。返回必须是 `enriched`，Web 卡片随后显示
   “AI 摘要可用”、同一摘要与标签。
3. 账号 B（先用 Member，再用 Filter 复验）收藏同一链接。Collect 结果必须是
   `summary_status=ready` 和 `enrichment_action=reuse_summary`；本轮不得读取网页，
   也不得调用补全工具。Web 复用账号 A 生成的摘要和标签。Member 的卡片仍为私密，
   Filter 的卡片仍按 Filter 规则公开；摘要来源不得改变卡片可见范围。

### 并发首写、读取失败与遗留修复

1. 为另一个从未收藏过的公开链接准备账号 A/B，两边在五秒内同时发送。若两边均
   收到 `generate_summary`，允许两边各自读取并提交；提交结果必须恰好包含一个
   `enriched`，另一个为 `already_enriched`。后提交者不得覆盖先写入的共享摘要或标签。
2. 发送一个可由 Attention 保存、但宿主公开网页工具无法读取的链接。收藏必须保留；
   Agent 不得猜测摘要或上传整页内容，也不得把读取失败说成收藏失败。Web 卡片显示
   中性的“摘要待补全”，不显示警告图标或错误色。之后同一链接被可读取的本地 Agent
   收藏时，仍可收到 `generate_summary` 并完成补全。
3. 部署迁移后抽查历史 `summary_status=unavailable|failed`、无摘要且仍安全可见的
   Content：应已变为 `pending` 并显示“摘要待补全”。真正终态不可用、隐藏、不安全、
   已下架或审核中的 Content 不得被迁移或本地 Agent 补写。

### Codex / Claude Code 对等与隐私证据

两种宿主各保存一份脱敏验收表，逐项记录 collect 的 `enrichment_action`、补全结果、
Web 卡片状态和宿主公开网页工具的可观察调用记录。两者必须满足同一顺序与边界：

```text
collect → generate_summary → public read → submit enrichment
collect → reuse_summary → stop (no public read, no submit)
```

验收完成后检查后台服务日志；命令只检查日志，不检查本地加密/权限隔离的会话状态：

```bash
(
set -euo pipefail

export E2E_TEST_URL='本次公开测试链接'
export E2E_PAGE_SENTINEL='原文中的独特短句'
export E2E_SUMMARY_SENTINEL='摘要中的独特短句'
export E2E_TAG_SENTINEL='本次独特标签'

# 从仓库根目录运行。脚本启用 `set -euo pipefail`；日志不存在、不可读、
# journalctl 失败或命中任一哨兵都会以非零状态退出，不会被当成“无泄漏”。
case "$(uname -s)" in
  Darwin) ./scripts/check-channel-enrichment-log-privacy.sh macos ;;
  Linux) ./scripts/check-channel-enrichment-log-privacy.sh linux ;;
  *) echo 'FAIL: unsupported acceptance platform' >&2; exit 1 ;;
esac
)
```

服务端 MCP 审计只允许出现账号、工具名、结果状态、稳定错误码、时间与 Content ID；
不得出现原始 URL、原文、摘要或标签。`attention channel status --json` 仍须满足前述
脱敏边界。任何一项只在 Codex 或只在 Claude Code 通过，都不算完成。

### Codex / Claude Code 常驻 Runtime 附加门槛

以下项目只在公开 CLI manifest 已切换到常驻候选产物后执行，不得用
设计文档代替发布证据：

1. Codex 在同一 Bridge 生命周期只有一个 `codex app-server`，连续两轮复用
   同一 thread；Claude Code 只有一个 `claude -p` stream-json 进程，连续两轮
   复用同一 session。结束宿主进程后，两者都优先恢复原 ID。
2. Codex 的隔离 `CODEX_HOME` 只加载 Attention MCP；初始化后的
   `mcpServerStatus/list` 必须恰好只有 `attention`，否则拒绝 turn。
   Claude Code 必须使用 strict MCP config，内置工具只允许 `WebFetch` 和
   `WebSearch`，并使用与 Codex 相同的 7 个 Attention Channel MCP 工具；
   Chrome、Shell、本地文件和其他 MCP 必须全部拒绝。
3. 杀死宿主 Runtime 但保持 Bridge 在线：精确的“状态”命令立即本地回复，
   普通消息安全排队；重启后优先恢复原 thread。
4. 伪造失效 thread/session ID 后，Bridge 回放本地最近 20 轮
   user/assistant 对话创建新会话，后续问题仍能正确使用上下文。
5. 普通聊天不发送通用“收到，正在处理”；只有已识别的收藏链接可给
   简短进度回执。
6. 整台设备或 Bridge 离线后，微信不得出现伪造的云端回复；设备恢复后
   再从本地队列与断点继续。
7. 两个宿主的 Runtime Reporter 服务端记录都只含脱敏状态、时间、错误码
   与队列数；不含 iLink/Codex/MCP token、thread/message ID、聊天、URL、
   回复、联系人或原始微信标识。Web 只能显示最后心跳与最后断点。

## 退出与证据

运行 `attention channel logout` 后：用户级后台服务被撤销、iLink 本地状态被删除、
宿主 MCP/OAuth 不受影响。随后重启桌面会话，微信消息不得再触发 Agent。

每个宿主保留以下脱敏证据：CLI 版本与 artifact SHA、`attention_get_my_account`
成功结果、上述矩阵的收藏 ID/可见性、`status --json`、重启后后台接收、失败恢复和
logout 后停止。任何证据都不得包含 token、完整微信内部 ID 或完整私人消息正文。
