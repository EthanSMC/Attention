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

### Codex / Claude Code 常驻 Runtime 附加门槛

以下项目只在公开 CLI manifest 已切换到常驻候选产物后执行，不得用
设计文档代替发布证据：

1. Codex 在同一 Bridge 生命周期只有一个 `codex app-server`，连续两轮复用
   同一 thread；Claude Code 只有一个 `claude -p` stream-json 进程，连续两轮
   复用同一 session。结束宿主进程后，两者都优先恢复原 ID。
2. Codex 的隔离 `CODEX_HOME` 只加载 Attention MCP；初始化后的
   `mcpServerStatus/list` 必须恰好只有 `attention`，否则拒绝 turn。
   Claude Code 必须使用 strict MCP config、空 built-in tool set 和与 Codex
   相同的 6 个 Attention Channel 工具。
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
