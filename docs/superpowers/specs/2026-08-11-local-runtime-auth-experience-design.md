# Attention 本地 Agent 鉴权与设备状态同步体验设计

状态：已确认

确认日期：2026-08-11

本设计服从 [`第一版范围`](../../first-release-scope.md)、
[`Web 与 MCP 能力等价交接`](../../handoffs/mcp-web-capability-parity.md) 和
[`本地 Agent 与微信 Channel 一期设计`](2026-08-07-local-agent-channel-runtime-design.md)。
它只重新划分本地 Agent、Attention MCP 和 Runtime Reporter 的鉴权边界与用户
体验，不改变 Attention Core 的账号权益、MCP 工具权限或 iLink 凭据本地保存
原则。

## 1. 问题与目标

当前底层已经允许本地 Bridge 在没有 Runtime OAuth 时继续运行，但安装流程会在
一次 `configure --apply --login` 中连续发起 MCP OAuth 和 Runtime OAuth；后者
失败还会让整个配置命令失败。设置页也把业务 OAuth、API Key 和设备运行状态放在
同一页面，用户很容易误以为 Runtime OAuth 是使用本地 Agent、微信或 Attention
MCP 的必选条件。

本设计的目标是：

1. 本地 Agent 和 iLink 可以在不启用 Runtime Reporter 的情况下工作；
2. 访问 Attention 云端 MCP 时，OAuth 为默认方式，API Key 为兼容方式；
3. Runtime Reporter 使用独立、可选的 Runtime OAuth；
4. MCP 连接与设备状态同步在命令、凭据、失败状态和 Web 设置中完全分离；
5. Skill 在必要接入全部成功后只推荐一次状态同步，并先获得用户明确同意。

## 2. 三条独立信任链

| 信任链 | 用户目的 | 凭据 | 是否必选 |
|---|---|---|---|
| 本地 Agent / iLink | 在用户设备上运行 Agent、收发微信消息 | Agent 宿主凭据和本地 iLink 凭据 | 使用对应宿主或微信时必选；不属于 Attention OAuth |
| Attention MCP | 收藏、读取、检索和更新 Attention 云端数据 | MCP OAuth，或不支持浏览器 OAuth 时使用 API Key | 只有访问 Attention 云端业务时必选 |
| Runtime Reporter | 在 Web 查看设备在线、断点、队列和微信绑定结果 | 独立 Runtime OAuth | 完全可选 |

“本地运行”不等于“完全离线”。本地 Agent 若调用 Hosted MCP，仍需要一个
Attention 云端业务凭据，但不强制使用 OAuth；API Key 也是有效的兼容凭据。
完全不访问 Attention 云端时可以没有 Attention OAuth，但当前第一版尚未提供本地
收藏数据库，因此不能把“本地保存并稍后同步”描述成已经交付的能力。

## 3. MCP OAuth 与 API Key

MCP OAuth 是交互式客户端的默认路径，适用于能够打开浏览器完成授权的 Codex、
Claude Code、OpenClaw、Hermes 等宿主。授权页展示业务权限，token 绑定
`attention-mcp` resource，可按客户端撤销和刷新，用户不需要复制长期秘密。

API Key 只用于不能可靠完成浏览器 OAuth 的 MCP 客户端、脚本、CI 或服务器任务。
Key 原文只展示一次，由用户手动保存、轮换和撤销；服务端继续按账号当前权益和该
Key 的存量 scope 上限计算实际能力。API Key 不得调用 Runtime API，也不得签发
其他凭据。

两种凭据只改变认证方式，不改变 Core 权限。Skill 和文档不得把 API Key 描述为
“高级连接”，也不得在支持 OAuth 的宿主上默认引导用户复制 Key。

## 4. Runtime Reporter

Runtime Reporter 是独立的本地控制面客户端，只申请：

- `runtime:register`；
- `runtime:heartbeat`；
- `channel:bind:report`；
- `channel:disconnect:report`。

Runtime token 绑定 `attention-channel-runtime` resource，不能调用 MCP；MCP token
和 API Key 也不能调用 Runtime。关闭或撤销设备状态同步不得停止本地 Bridge、
iLink 或 Agent。撤销 MCP 连接也不能伪造设备离线，只会让需要云端业务的收藏调用
失败。

Reporter 只上报设备名称、Agent 类型、运行阶段、稳定错误码、有限队列数量、最后
在线时间、最后成功时间和微信绑定结果。不得上报对话、收藏链接、联系人、iLink
凭据、Agent token、MCP token、Codex thread ID 或原始微信标识。

## 5. 首次 Agent 接入体验

用户进入“设置 → Agent 连接”，点击“复制给 AI”，把提示词发给本地 Agent：

1. Agent 识别宿主并安装 Attention Skill；
2. Agent 添加 Attention MCP；
3. 支持浏览器授权时，打开一次 MCP 授权页；不支持时再引导用户创建 API Key；
4. Agent 真实调用 `attention_get_my_account` 验收连接；
5. 验收成功后告知“Attention MCP 已连接，现在可以收藏和查询内容”。

这一流程不发起 Runtime OAuth，也不因为 Reporter 未配置而出现警告或失败状态。

## 6. 微信接入体验

用户要求 Agent 接入微信后：

1. Agent 启动本地 Attention Bridge；
2. 终端展示 iLink 二维码；
3. 用户扫码；
4. Bridge 完成本地登录后，微信立即可以对话和收藏。

微信扫码成功不依赖 Runtime OAuth。成功提示必须说明：“微信已经连接；当前运行
状态只保存在这台设备上。”

## 7. Skill 的可选推荐

只有在 MCP 验收和微信扫码都已成功后，Skill 才主动推荐一次“设备状态同步”。
推荐必须是非阻塞、可拒绝的，并使用以下语义：

> Attention MCP 和微信已经接入完成，现在可以正常收藏。
>
> 推荐再启用“设备状态同步”。启用后，可以在 Attention 网页查看本地 Agent、
> Bridge 和微信连接是否正常，以及最后在线、最后成功时间、待处理队列、故障断点
> 和微信设备绑定结果。
>
> Attention 不会同步对话内容、收藏链接、微信凭据、联系人或 Agent 会话 ID。
> 这是可选功能，不启用也不影响微信和收藏。要现在启用吗？

交互约束：

- 不自动打开浏览器，不自动申请 Runtime OAuth；
- 用户同意后才运行 `attention device sync enable`；
- 用户拒绝后正常结束，不显示“配置未完成”；
- 每个本地 installation 最多主动推荐一次；本地状态记录
  `offered / accepted / declined`，Bridge 或 Agent 重启后不得重新询问；
- 已启用的设备只验证状态，不重复询问；
- Runtime OAuth 失败只表示“设备状态同步未启用”，不能回滚或否定 MCP/微信成功。

Skill 内部文档可以使用“Runtime OAuth”，面向用户统一使用“设备状态同步”。

## 8. CLI 命令边界

命令职责拆分为：

```text
attention configure <host> --apply --login
└─ 安装 Skill、配置 MCP，并只完成 MCP OAuth

attention channel start <host> --background
└─ 启动本地 Bridge 与 iLink；不要求 Runtime OAuth

attention device sync enable
└─ 经用户确认后，单独完成 Runtime OAuth、设备注册和 Reporter 启动
```

`attention configure` 的结果不能包含 Runtime OAuth 子步骤。`channel start` 需要
云端 MCP 时应检查“有效的 MCP 凭据”，错误文案不能把 OAuth 写成唯一修复方式。
`device sync enable` 失败不得返回或改写 MCP 安装状态。

## 9. Web 设置结构

设置侧边栏拆成两个入口：

### 9.1 Agent 连接

- 复制给 AI；
- MCP OAuth 客户端和授权范围；
- MCP 连接验收；
- 重新授权和撤销；
- 默认折叠的 API Key 备用入口及 Key 轮换。

### 9.2 设备

- “未启用设备状态同步”的明确空状态；
- 已启用设备的 Agent、Bridge、iLink 和微信绑定状态；
- 最后在线、最后成功、队列和故障断点；
- 启用、重新授权、停止同步和移除设备；
- Reporter 隐私说明。

Runtime OAuth 客户端不能混入普通“MCP OAuth 连接”列表。服务端投影必须按
resource/audience 分类。没有 Reporter 证据时显示“未启用状态同步”，不能显示
“离线”；Reporter 中断时显示“状态同步中断”，不能据此断言微信已经离线。

## 10. 错误与撤销语义

| 事件 | 用户看到的结果 | 不受影响的能力 |
|---|---|---|
| MCP OAuth/API Key 无效 | Agent 尚未连接 Attention，提示重新连接 MCP | 本地 Agent 和 iLink 进程 |
| iLink 扫码失败 | 微信尚未连接，提示重新扫码 | 已连接的 MCP |
| Runtime OAuth 失败 | 设备状态同步未启用 | MCP、Bridge、微信和收藏 |
| Reporter 心跳中断 | 状态同步中断，保留最后已知断点 | 本地 Bridge 与微信实际运行 |
| 用户停止设备同步 | Web 不再更新设备状态 | MCP、Bridge 与微信 |
| 用户撤销 MCP | 云端业务调用失败并提示重新连接 | Reporter 对本地运行状态的有限上报 |

## 11. 验收标准

1. 没有 Runtime credential 时，MCP 验收、iLink 扫码和微信收藏仍可成功；
2. `configure --apply --login` 只出现一次业务 OAuth；
3. Runtime OAuth 失败不会让 configure 或 channel start 失败；
4. API Key 可以完成与其 scope/账号权益相符的 MCP 验收，但不能访问 Runtime；
5. Skill 只在 MCP 与微信成功后推荐一次状态同步，拒绝后不再继续；
6. 设备页可以区分“未启用”“在线”“状态同步中断”“离线/久未在线”；
7. Agent 连接页不显示 Runtime OAuth 客户端，设备页不显示业务 API Key；
8. 撤销 Runtime OAuth 后微信继续收发，撤销 MCP 后 Reporter 不伪造微信离线；
9. Reporter 上报中不存在消息、链接、凭据、联系人、thread ID 或原始微信标识。
