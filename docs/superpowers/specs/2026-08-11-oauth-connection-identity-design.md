# OAuth 连接身份、设备名称与重复连接治理设计

状态：已确认

确认日期：2026-08-11

本设计补充
[`本地 Agent 鉴权与设备状态同步体验设计`](2026-08-11-local-runtime-auth-experience-design.md)。
它不改变 OAuth 权限、MCP 与 Runtime 的资源隔离，也不根据 IP 或硬件指纹识别设备。

## 1. 问题

当前动态客户端注册每次都会创建新的 `client_id`。重新执行 Codex MCP OAuth 或
Runtime OAuth 后，旧 refresh token 仍然有效；设置页又按 `client_id` 逐项展示，
因此同一名称会出现多次。刷新令牌轮换不是重复项的来源。

服务端目前只知道客户端名称、scope 和授权时间。普通 Codex/Claude Code 的 DCR
请求不携带设备名，网页也不能读取电脑名称，因此不能安全判断两个同名连接是否来自
同一台电脑。用 IP、User-Agent 或客户端名称自动合并会误伤同一网络内的其他设备。

## 2. 目标

1. 用户能区分业务 MCP 连接和可选的设备状态同步；
2. 能可靠取得设备名时自动显示设备名，不能取得时由用户命名；
3. refresh token 轮换不产生新的逻辑连接；
4. 同一 Attention installation 重新授权后只保留一个有效 Runtime 连接；
5. 普通 Codex/Claude Code 连接不得仅凭同名或 IP 被静默撤销；
6. 同一账号、同一 audience 下不允许存在两个同名的有效连接；
7. 历史重复项变得可理解、可展开、可逐个或批量撤销。

## 3. 连接模型

新增持久化的逻辑 `oauth_connection`，将“用户授权的一台设备/一个客户端用途”与
动态注册的 `oauth_client`、短期 access token 和轮换 refresh token 分开。

每个逻辑连接至少包含：

- `id`：服务端生成的 UUID；
- `account_id`；
- `client_id`：当前 DCR 客户端；
- `audience`：`attention-mcp` 或 `attention-channel-runtime`；
- `kind`：`mcp` 或 `runtime`；
- `label`：面向用户的连接名称；
- `normalized_label`：NFKC、去除首尾空白并大小写折叠后的唯一性键；
- `device_name`：可靠获得时保存的设备显示名，否则为空；
- `installation_key_hash`：可选，Attention 本地 installation 的稳定随机标识哈希；
- `status`、`created_at`、`last_authorized_at`、`last_used_at`、`revoked_at`。

authorization code、access token 和 refresh token 都引用 `connection_id`。刷新令牌
轮换继承同一个 `connection_id`，不会创建新的逻辑连接。

数据库对有效连接实施 `(account_id, audience, normalized_label)` 部分唯一约束。
已撤销连接不占用名称，用户以后可以重新使用该名称。唯一性最终由数据库约束保证，
不能只依赖页面校验。

## 4. 设备名来源

### 4.1 Attention CLI / Runtime

CLI 从操作系统读取友好设备名，清洗为 1–80 个可显示字符，并使用本地已经存在的
随机 installation ID。DCR 扩展字段携带：

- `attention_connection_kind=runtime`；
- `attention_installation_id=<opaque UUID>`；
- `attention_device_name=<sanitized display name>`。

服务端保存 installation ID 的哈希用于关联，不上传硬件序列号、MAC、磁盘 ID 或
其他硬件指纹。授权页默认显示“设备名 · Agent”，用户仍可修改展示名称。

同一账号、同一 audience、同一 installation 哈希再次授权时，服务端复用逻辑连接，
在新 token 成功签发后撤销该逻辑连接旧 `client_id` 下的 token。其他 installation
不受影响。

### 4.2 普通 Codex / Claude Code MCP OAuth

宿主没有提供稳定 installation 信息时，授权页显示“连接名称”输入框，默认值为
“Codex · 8月11日”或“Claude Code · 8月11日”。用户可以改成“办公室 MacBook”。

这种连接不会被自动判定为另一条同名连接的替代品。服务端不使用 IP、User-Agent、
redirect URI、同名客户端或相同 scope 推断设备身份。

用户提交的连接名称如果已经被当前账号、当前 audience 的有效连接使用，授权页必须
保留原请求并显示“该连接名称已存在，请换一个名称”。不得自动添加数字、日期或其他
后缀，也不得先签发 token 再让用户处理冲突。此时只提供两个出口：修改为唯一名称
后继续授权，或取消本次授权并按 OAuth 错误回调返回客户端。取消授权不得修改或撤销
任何已有连接。

## 5. 授权与重新授权

1. DCR 创建 public client，并保存可选的受限设备元数据；
2. 授权页展示客户端、resource、scope 和连接名称；
3. 用户确认后，服务端在事务中校验连接名称唯一性，随后创建或复用逻辑
   connection，并把 `connection_id` 写入 authorization code；
4. code exchange 成功后签发引用该 connection 的 token；
5. Runtime 稳定 installation 的重新授权在新 token 成功后撤销旧 token；
6. 普通 MCP 的重新授权只有在用户提供新的唯一名称后才创建新逻辑连接；除非未来
   宿主提供稳定 instance identity，否则不会自动替代既有连接。

授权失败或用户取消时，不创建连接，也不撤销旧 token。自动替换必须以新 token
已经成功签发为边界，避免把用户锁在账号之外。

## 6. 设置页

### 6.1 Agent 连接

只展示 `attention-mcp`：

- 顶层按客户端类型分组，例如“Codex · 5 个连接”；
- 展开后显示互不重复的连接名称、授权日期、最近使用时间和 scope 摘要；
- 支持逐个撤销；
- 支持“撤销这个客户端的全部连接”，操作前明确显示数量并二次确认；
- “重新连接”不会承诺自动替代未知设备上的旧连接。

### 6.2 设备

Runtime OAuth 不再出现在“OAuth 连接”列表。设备页以 installation 为主显示设备名、
Agent、最后在线、断点和状态同步授权。移除设备时同时撤销该 installation 的 Runtime
连接；停止状态同步不影响 MCP、Bridge 或 iLink。

### 6.3 历史数据

迁移为每个现存的 `(account_id, client_id, audience)` 创建一个逻辑连接。每组最早的
连接保留原客户端名称；其余历史同名项使用“客户端名 · 授权日期时间 · client ID
短前缀”生成确定且唯一的迁移名称。这个规则只用于无法交互的历史数据迁移，新授权
发生冲突时仍必须要求用户改名。历史 MCP 连接显示为“未确认设备”，按客户端类型
折叠；不会自动撤销。历史 Runtime token 不混入 MCP 列表，已有 installation 能关联
时显示在设备页。

## 7. 撤销语义

- 逐个撤销以 `connection_id` 为边界，撤销其全部 access/refresh token；
- 批量撤销仅作用于当前账号、当前 audience 和用户确认的客户端分组；
- 删除一个 DCR client 不得影响其他账号；
- 撤销 Runtime connection 不得撤销 MCP connection，反之亦然；
- 服务端接口不接受调用方提供的 account ID，账号始终来自网站 Session。

## 8. 安全与隐私

- 设备名称是展示元数据，不参与认证或授权决策；
- installation ID 是本地生成的随机标识，不是硬件指纹；服务端仅保存其哈希；
- 相同 IP、User-Agent、客户端名称或 scope 不能作为自动替换依据；
- connection label 进行 NFKC、长度和控制字符校验；
- 新授权的同名冲突必须要求用户改名，禁止静默编号；
- 所有撤销均要求当前账号 Session，并限制在该账号的连接；
- Runtime 与 MCP 的 audience/scope 校验保持现有严格隔离。

## 9. 视觉与交互约束

本功能必须延续当前 Attention 正式站和设置页的设计规范，不创建第二套视觉语言：

- 页面底色、内容宽度、留白节奏、字体、圆角、边框和阴影沿用现有设置页 token；
- OAuth 客户端分组复用现有 `connection-card` 与凭据列表结构；
- 展开/收起、逐个撤销和批量撤销使用现有 button 层级，不使用新的高饱和品牌色；
- 连接名称输入框沿用现有表单控件尺寸、focus ring 和错误文案样式；
- 同名错误显示在输入框附近，不能只用 toast，也不能清空用户已经输入的名称；
- 同名错误态同时保留“取消授权”入口，取消后沿用现有 OAuth cancel 回调和页面样式；
- 批量撤销使用现有 modal 规范，明确客户端名称和连接数量，危险动作使用现有危险态；
- 桌面端遵循当前左侧设置导航，移动端遵循现有底部/窄屏布局，不增加第三套导航；
- 长 scope 默认摘要展示，详细 scope 可展开，避免重新出现截图中大段重复文本；
- 不因为新增设备名而改变“Agent 连接”和“设备”两个设置入口的既定信息架构。

视觉验收同时覆盖桌面和 390px 窄屏，页面不得产生文档级横向滚动；内部表格或列表
只有在确有必要时允许局部滚动。

## 10. 验收标准

1. refresh token 连续轮换后设置页仍只有一个逻辑连接；
2. 同一 Runtime installation 重新授权后只有新 token 有效；
3. 两个不同 installation 使用相同设备名不会互相撤销；
4. 普通 Codex OAuth 可在授权页命名，名称在设置页展示；
5. 输入已存在的连接名称时不会签发授权码，页面要求用户改名；
6. 同名错误态可以取消授权，取消后客户端收到标准拒绝结果且已有连接不变；
7. 并发提交同名连接时最多一个成功，另一个返回可恢复的名称冲突；
8. Codex 连接按客户端类型折叠，展开后名称互不重复且可逐个撤销；
9. “撤销全部”只撤销当前账号、MCP audience 下该分组的连接；
10. Runtime OAuth 不出现在 MCP OAuth 列表，设备页能显示可靠的设备名；
11. 历史重复项不丢失、不被静默撤销，并获得确定且唯一的迁移名称；
12. 数据库和日志中不存在硬件序列号、MAC、原始 iLink 标识或 OAuth token 原文。
