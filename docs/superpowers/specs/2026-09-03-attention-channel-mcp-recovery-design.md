# Attention Channel MCP 恢复与降级设计

**状态：** 已确认
**日期：** 2026-09-03

## 1. 背景

Attention Channel 当前由本地 Bridge 接收 iLink / 微信消息，并在受限的 Codex
app-server 中运行用户自己的 Agent。Attention MCP 是独立的 Hosted MCP；Bridge
只允许该 Agent 使用 Attention MCP 和最小公开网页读取能力，不开放 Shell、文件写入
或任意本机控制。

现有实现将多个层次压缩成一个 Runtime `healthy` 状态：Codex app-server 初始化后，
只要 `mcpServerStatus/list` 返回的 MCP 名称恰好为 `attention`，就认为 Runtime
健康。它没有证明 Attention MCP 已完成 OAuth、工具已成功发现，或
`attention_get_my_account` 可以真实调用。启动阶段的账号验收虽能发现工具不可用，
但失败原因会被压缩成一个空结果，且不会反映到 Runtime 健康状态。

本地重试也存在两处缺口：只有完整的“重试”“重新连接”或 `/retry` 会被识别为控制
命令，“帮我重连一下”等自然表达会进入模型；控制器重启 Codex app-server 后不会给出
真实的 MCP 恢复结果。由此可能出现“Bridge 和 Codex 正常、微信仍可聊天，但
Attention MCP 不可用”，同时状态仍显示健康或模型声称自己不能重连。

## 2. 目标

1. 将 iLink、Codex、Attention MCP 和 Runtime Reporter 的状态分开表达；
2. Attention MCP 暂时故障或 OAuth 不可用时，普通对话仍然工作；
3. 可恢复的网络、进程和 Token 过期故障由 Bridge 自动恢复；
4. OAuth 缺失、撤销或不可刷新时停止无效重试，提示用户在电脑端重新授权；
5. 微信内的自然语言重试由 Bridge 确定性处理，不依赖模型自行操作 CLI；
6. 恢复期间保留 iLink 登录、消息队列、对话断点和安全隔离；
7. 不扩大 Agent 权限，不在后台打开浏览器，不记录或上报业务凭据。

## 3. 非目标

- 不让微信中的模型获得 Shell、CLI、浏览器或本机配置写权限；
- 不把 Attention MCP 改为服务端托管 Agent；
- 不改变 iLink 登录协议、消息格式或凭据本地保存原则；
- 不让 Runtime Reporter OAuth 代替 MCP OAuth；
- 不在本轮改变 Attention Core 的业务工具、权益或授权范围；
- 不自动发布 CLI、部署 Web 或推送远端分支。

## 4. 信任边界与组件

```text
微信 / iLink
      ↓
Channel Bridge
  ├─ 消息队列与幂等
  ├─ 本地控制命令解析
  └─ Recovery Supervisor
           ↓
    Codex app-server
      ├─ 普通对话
      └─ Attention MCP client
                ↓
        Hosted Attention MCP
```

### 4.1 Channel Bridge

Bridge 持有恢复控制权。它负责启动与关闭 Brain、运行 MCP 就绪探测、分类错误、安排
自动重试、持久化无敏感信息的检查点，并生成微信侧确定性状态回复。

### 4.2 Codex app-server

Codex app-server 继续运行在独立 Channel `CODEX_HOME` 中，只加载 Attention MCP。
它负责模型会话、MCP 客户端协议和已有凭据的正常刷新，但不能自行发起需要用户确认的
OAuth，也不能修改启动它的 Bridge。

### 4.3 Hosted Attention MCP

Hosted MCP 是远端业务入口。服务在线只代表端点可访问；本地客户端仍需正确配置、
有效凭据、成功的协议初始化和真实工具调用，才可以标记为可用。

### 4.4 Runtime Reporter

Reporter 继续是可选的独立控制面客户端。Reporter 不可用不能否定 iLink、Codex 或
MCP 的真实状态；MCP 不可用也不能伪造微信离线。

## 5. 状态模型

现有 `runtimeState.phase` 继续表示 Codex/Brain 生命周期，以保持本地状态和 Reporter
协议兼容。新增独立的本地 `attentionMcp` 检查点，不再用 Brain 的 `healthy` 推导 MCP
业务可用性。

### 5.1 分层状态

| 组件 | 状态 |
|---|---|
| iLink | `connected`、`signed_out`、`upstream_error` |
| Codex | `starting`、`ready`、`restarting`、`auth_required`、`failed`、`stopped` |
| Attention MCP | `unknown`、`checking`、`ready`、`reconnecting`、`auth_required`、`unreachable`、`tool_error` |
| Reporter | `disabled`、`healthy`、`degraded` |

### 5.2 MCP 检查点

```ts
interface AttentionMcpCheckpoint {
  status:
    | "unknown"
    | "checking"
    | "ready"
    | "reconnecting"
    | "auth_required"
    | "unreachable"
    | "tool_error";
  lastErrorCode: string | null;
  lastCheckedAt: string | null;
  lastReadyAt: string | null;
  retryAttempt: number;
  nextRetryAt: string | null;
}
```

该对象只保存稳定错误码与时间，不保存 Access Token、Refresh Token、HTTP 响应正文、
账号资料或微信内容。旧版 `state.json` 缺少该字段时规范化为 `unknown`，不得破坏现有
登录与队列。

### 5.3 对外表达

`attention channel status` 和微信“状态”分别展示：

- 微信登录；
- Codex Runtime；
- Attention MCP；
- 本地待处理与待发送队列；
- Reporter（仅在启用时）。

允许出现“微信已连接、Codex 正常、Attention MCP 需要重新授权、Reporter 未启用”。
该组合是准确的分层状态，不应被合并成“全部健康”或“账号离线”。

## 6. MCP 就绪探测

每次 Codex app-server 首次启动或明确重启后，执行以下探测：

1. 调用 `mcpServerStatus/list`，验证 MCP 列表恰好只有 `attention`；
2. 读取可用的 MCP 初始化和认证状态，但任何“未知”状态都不能单独证明成功；
3. 在不附着到用户 Channel thread 的一次性预检会话中，真实调用
   `attention_get_my_account`；
4. Codex 适配器必须观察到 `mcpToolCall` 的 `completed` 事件，并解析合法的工具
   返回，才将 MCP 标记为 `ready`；
5. 工具未出现、调用失败、返回结构非法或模型只输出成功文本，都不能通过验收；
6. 预检完成后丢弃一次性会话，不写入用户聊天历史。

当前通过模型输出 `ATTENTION_ACCOUNT_OK` 标记验收的逻辑应改为结构化工具证据。成功
结果可以在本机用于显示已连接账号，但不得写入诊断日志或 Reporter。

## 7. 错误分类

错误必须按发生边界分类，不能用一个正则把所有 401 都归为 Codex 登录失败。

| 错误码 | 含义 | 恢复策略 |
|---|---|---|
| `codex_auth_required` | Codex 自身登录不可用 | 停止 Brain 重试，提示电脑端登录 Codex |
| `mcp_auth_required` | Attention MCP 凭据缺失、撤销或不可刷新 | 保持聊天，停止 MCP 自动重试，提示重新授权 |
| `mcp_token_refresh_failed` | Refresh Token 被拒绝或 `invalid_grant` | 转为 `mcp_auth_required` |
| `mcp_server_unreachable` | DNS、连接、超时或暂时性 5xx | 自动退避重连 |
| `mcp_protocol_failed` | 初始化、工具发现或协议响应非法 | 有界重试后进入 `tool_error` |
| `mcp_account_probe_failed` | 工具可见但账号实测失败 | 按底层认证、网络或工具错误继续细分 |
| `codex_runtime_crashed` | app-server 进程退出 | 重启 app-server，保留 iLink 和本地状态 |
| `codex_mcp_isolation_failed` | 加载了缺失或额外 MCP | Fail closed，不接受业务 turn |

MCP 工具事件中的 401 属于 `mcp_auth_required`；app-server 自身 RPC 在创建 thread 或
turn 前返回的 Codex 登录错误才属于 `codex_auth_required`。

## 8. 自动恢复

Recovery Supervisor 在 Bridge 内运行，所有恢复动作使用 single-flight，同一时间最多
存在一个重连任务。

### 8.1 暂时性故障

网络超时、连接断开、DNS 故障和可重试 5xx 使用有界指数退避：

```text
1 秒 → 3 秒 → 10 秒 → 30 秒 → 60 秒
```

达到 60 秒后维持该上限，不忙循环。每次尝试都重新初始化客户端并执行真实账号预检；
成功后清零计数并更新 `lastReadyAt`。

### 8.2 Token 过期

如果 MCP 客户端存在有效 Refresh Token，由 Codex MCP 客户端执行标准刷新，然后立即
重跑预检。刷新成功不需要用户操作；刷新被授权服务器拒绝时进入 `auth_required`，不再
自动循环。

### 8.3 Runtime 崩溃

Codex app-server 崩溃时，Bridge 关闭旧 RPC、启动新进程、验证 MCP 隔离并执行账号
预检。重启不得清除：

- iLink token 与 owner 绑定；
- 待处理和待发送消息；
- 已处理消息幂等环；
- 最近对话历史；
- 可恢复的 Codex thread ID。

### 8.4 OAuth 不可恢复

缺少凭据、授权被撤销或 `invalid_grant` 时，后台 Bridge 不打开浏览器，也不不断重启。
它继续接收消息并允许普通对话，等待用户在电脑端完成交互式授权。授权完成后，用户只需
在微信发送“重试”即可恢复 MCP，不需要重新扫码微信。

## 9. OAuth 配置一致性

实施阶段先使用临时 `CODEX_HOME` 验证当前 Codex 版本实际保存和查找 MCP OAuth
凭据的位置。验证只检查文件或安全存储的存在性、身份和行为，不读取或输出凭据内容。

最终必须满足以下不变量：

> `attention configure codex --apply --login` 授权的 MCP 客户端环境，与后台 Bridge
> 实际启动 Codex app-server 时使用的隔离环境一致。

优先采用 Codex 官方支持的、按 MCP server 隔离的凭据复用机制。若当前 Codex 版本
不支持安全复用，则安装流程必须明确完成 Channel 专用授权，并确保用户知道该授权服务于
微信 Channel。不能通过继承整个用户 `config.toml`、全部插件或其他 MCP 来解决凭据
问题。

安装流程仍以一次明确的业务 OAuth 为目标。若宿主限制导致交互式 Codex 和隔离 Channel
无法安全共享同一授权，实施前必须把该限制与额外授权体验作为兼容性决定报告，不能静默
要求用户重复登录。

API Key 继续作为不支持浏览器 OAuth 的兼容路径，不作为 Codex 默认路径。Runtime
Reporter 凭据不得用于 MCP。

## 10. 微信控制命令

控制命令在进入模型前解析。解析器执行 NFKC 规范化、首尾空格清理和句末标点清理，
并使用完整句匹配。

应识别：

- `重试`、`重试一下`、`再试一次`；
- `重新连接`、`重新连接一下`；
- `重连`、`帮我重连一下`；
- `/retry`。

不得拦截“帮我重试这段代码”“重新连接数据库应该怎么做”等普通对话。只有已绑定的
微信 owner 可以触发控制动作，并对连续手动重试设置冷却时间。

重试回复由 Bridge 根据真实结果生成：

1. 立即回复“正在重新连接 Attention MCP，微信登录不会中断。”；
2. 重启或重建 MCP/Codex 客户端并执行账号预检；
3. 成功后回复“Attention MCP 已恢复，可以继续收藏和查询。”；
4. OAuth 无效时回复电脑端重新授权命令；
5. 服务暂不可达时说明已进入自动重试，并给出下一次时间。

不能在恢复动作执行前把控制消息标记成“恢复成功”，也不能再由模型自由生成“我不能
操作 CLI”等控制结果。

## 11. MCP 降级时的消息行为

- 普通知识问答继续通过 Codex 处理；
- 需要 Attention 数据的请求可以尝试一次工具调用，但失败后不得猜测账号、收藏或权益；
- 工具失败时使用确定性降级提示，明确区分授权、服务暂不可达和工具异常；
- 需要云端业务且尚未完成的消息保留在本地队列，不因 MCP 故障被删除；
- MCP 恢复后可通过“继续”恢复持久化断点；
- Bridge 和 iLink 正常时，不得要求用户重新扫码微信来修复 MCP OAuth。

## 12. 安全与隐私

1. 模型不获得新的本机权限；
2. 重试只能触发预定义恢复动作，不能执行任意 CLI；
3. MCP 隔离验证失败继续 fail closed；
4. OAuth 浏览器只可在明确的交互式配置命令中打开；
5. 状态与日志不包含 Token、授权码、PKCE verifier、账号响应、微信消息或链接；
6. Reporter 若后续扩展 MCP 状态，只能上报稳定阶段、错误码和时间；
7. 自动重试有 single-flight、冷却和上限，防止消息触发资源耗尽。

## 13. 兼容性与迁移

- 新 MCP 检查点是本地状态的可选字段；旧状态自动规范化为 `unknown`；
- 现有 iLink、队列、Brain session 和 Reporter 字段保持兼容；
- 若 Reporter 合约暂不支持独立 MCP 状态，本轮先只在本地 CLI 和微信状态中展示，不向
  服务端发送未知字段；
- Claude Code 适配器保持现有行为，并通过共同的探测结果接口逐步对齐；Codex 的
  `mcpToolCall` 结构化证据不能被错误套用到不提供相同事件的宿主；
- 安装产物、仓库版本和自动升级元数据必须同步，发布决定留给实施验证后的单独步骤。

## 14. 测试

### 14.1 单元测试

- 自然语言重试的规范化、匹配和误拦截保护；
- MCP 状态转换、稳定错误码和旧状态迁移；
- Codex 认证错误与 Attention MCP 认证错误的来源区分；
- 工具名称存在但 OAuth 或真实调用失败时不得标记 `ready`；
- 手动重试 single-flight、冷却和结果文案；
- `状态`输出各层独立状态。

### 14.2 进程与协议测试

- 假 app-server 返回 401、`invalid_grant`、503、超时、协议错误和进程退出；
- Access Token 过期后刷新成功并重新通过预检；
- Runtime 崩溃后保留 iLink、队列和 thread 恢复信息；
- MCP 不可用时普通聊天仍能完成；
- 待处理业务消息在恢复后只执行一次。

### 14.3 真机验收

1. 正常 OAuth 下真实收藏成功；
2. 撤销 MCP OAuth 后微信仍能普通聊天；
3. “帮我重连一下”触发 Bridge 控制器而不是模型；
4. 授权无效时给出准确电脑端指引，不无限重启；
5. 重新授权后仅发送“重试”即可恢复，不重新扫码；
6. 网络暂时中断时自动恢复，队列和上下文不丢失；
7. `attention channel status` 与微信“状态”正确显示分层结果。

### 14.4 回归门槛

- CLI 针对性测试与全量测试；
- CLI 与 Web 类型检查；
- CLI 构建和安装产物同步检查；
- 版本号、安装产物和自动升级元数据一致性；
- 发布、推送和部署必须等待单独授权。

## 15. 验收标准

1. Hosted MCP 服务正常但本地 OAuth 不可用时，状态明确显示 `auth_required`；
2. MCP 不可用不影响普通微信对话；
3. 暂时性故障可以自动恢复，并有有界退避；
4. 微信自然语言重试触发真实恢复并返回真实结果；
5. OAuth 重新授权后不需要重启整个 Bridge 或重新扫码微信；
6. MCP 可用性的成功结论来自真实工具事件，不来自名称或模型文本；
7. 恢复过程不扩大权限、不泄露凭据、不丢失或重复处理消息；
8. 旧版本地状态和既有 Reporter 合约继续兼容。
