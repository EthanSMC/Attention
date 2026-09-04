# Attention Bridge 自动更新与会话重建设计

**状态：** 已确认

**日期：** 2026-09-04

## 1. 背景

Attention Channel Bridge 已支持校验远端 CLI 产物、切换版本并由稳定 launcher
重启，也已将 iLink、Codex Runtime 与 Attention MCP 状态分层。但是当前实现仍有两个
相互叠加的缺口：

1. 后台 Bridge 只按持久化的 24 小时间隔检查更新。即使服务刚启动，也可能因为上次
   检查时间未过而继续运行旧版本；
2. 新 Bridge 进程会恢复旧 Codex thread ID。该 thread 可能由旧版本、旧 MCP 配置或旧
   工具清单创建，而启动账号预检使用的是另一个一次性新 thread。于是预检可以真实调用
   `attention_get_my_account` 并把 MCP 标记为 `ready`，业务 thread 却仍没有 Attention
   工具。

工具缺失时，模型可能只返回“工具未加载”的普通文本，并不产生 `mcpToolCall` 失败事件。
现有恢复监督器会把这段文字当成成功回复，无法自动进入 MCP 降级或重建流程。

## 2. 已确认决策

1. 后台 Bridge 每次启动后立即检查远端版本；运行中每 1 小时检查一次。
2. 更新检查和切换只在入站、出站队列均为空时执行。
3. 只有权限摘要兼容且不跨主版本的更新可以自动安装。
4. 权限摘要变化或跨主版本继续进入 `consent_required`，不得自动安装。
5. 兼容更新通过完整产物校验后，由现有 launcher 重启 Bridge。
6. Codex 业务会话与创建它的 Bridge 版本和权限摘要绑定。
7. 新进程发现已保存会话缺少版本身份，或版本/权限摘要不匹配时，废弃旧 thread ID；
   iLink 登录、消息队列、幂等记录和文本历史全部保留。
8. 新业务会话必须在当前产物与 MCP 配置下创建，并继续由真实
   `attention_get_my_account` 工具事件证明 MCP 可用。
9. 更新失败保留当前版本；候选启动失败由 launcher 回滚，不要求用户重新扫码微信。

## 3. 目标与非目标

### 3.1 目标

- 将安全兼容更新的发现时延缩短到启动时或最长 1 小时；
- 确保版本切换后不会恢复工具清单过期的 Codex 业务会话；
- 保持微信登录、待处理消息、发送回执、幂等和可重放历史的耐久性；
- 保持自动更新的来源、摘要、兼容性、候选身份与原子切换校验；
- 让 MCP `ready` 与实际业务会话能力一致，而不是只代表临时预检成功。

### 3.2 非目标

- 不让模型获得 Shell、CLI 或本机配置写权限；
- 不把普通模型文本解析成可信 MCP 错误；
- 不在有业务消息待处理时强制重启；
- 不自动接受新增权限或跨主版本升级；
- 不改变 iLink 登录协议、Attention Core 工具或 Hosted MCP API；
- 不在本轮推送、发布或部署产物。

## 4. 方案

采用“版本绑定的会话重建”。

### 4.1 更新调度

Bridge 进入服务循环并完成当前产物的启动验收后，将第一次更新检查设为立即到期。检查仍需
满足空闲门槛：`pendingInbound` 和 `pendingOutbound` 均为空。若启动时队列非空，先完成
已有工作，再在首次空闲迭代执行检查。

每次检查完成或失败后，下一次检查时间为检查开始时间加 1 小时。现有最长 1 小时的设备
jitter 会被移除；服务本身的不同启动时间已经能够分散请求。进程重启后不继承旧
`lastCheckAt` 来跳过启动检查。

检查失败保持当前版本和现有服务；记录稳定错误码并在下一检查周期重试。网络检查失败不影响
iLink、Codex 普通对话或当前 MCP 状态。

### 4.2 更新许可

继续使用现有 manifest、精确 origin、无重定向下载、Node 版本要求、字节数、SHA-256、
候选 `--bridge-update-probe` 与原子状态切换。

自动安装只允许现有 `bridgeUpdateDecision` 判定为兼容的更新。下列情况不得自动安装：

- manifest 的权限摘要与当前产物不同；
- 新版本跨语义化版本的 major；
- Node 运行时不满足要求；
- 来源、manifest、产物或候选身份校验失败。

权限或 major 变化保持 `consent_required`，由用户在本机明确确认后再进入另一个流程。

### 4.3 会话身份

持久化的 `BrainSession` 增加可选身份字段：

```ts
interface BrainSession {
  hostId: "codex" | "claude-code";
  sessionId: string;
  updatedAt: string;
  bridgeVersion?: string;
  permissionProfileSha256?: string;
}
```

字段保持可选以兼容旧 `state.json`。读取旧状态时不猜测创建版本；缺少任一身份字段的会话
被视为过期，但状态文件本身仍可正常加载。

创建或更新业务会话记录时，Bridge 写入当前 `ATTENTION_CLI_VERSION` 和当前权限摘要。
复用会话前必须同时满足：

- `hostId` 与当前宿主一致；
- `bridgeVersion` 与当前产物完全一致；
- `permissionProfileSha256` 与当前权限摘要完全一致。

任一条件不满足时，仅清除 `brainSession`，随后使用已有 `history` 构造 replay prompt 并创建
新 thread。

### 4.4 重建时机

会话兼容性在业务消息进入 `invokeWithFallback` 前确定性检查，不依赖模型判断。候选版本完成
launcher 重启后，第一次业务消息会在新进程中自动建立新 thread。

Bridge 启动账号预检仍使用一次性 thread，不写入 `brainSession` 或业务历史。预检成功证明
当前进程、当前 MCP 配置和当前账号可用；版本身份检查保证随后不会切回旧配置创建的 thread。

同版本、同权限摘要下的普通进程重启继续允许恢复 thread，以保留正常连续对话。只有版本、
权限身份变化或旧状态迁移触发重建。

### 4.5 保留与清除

重建时保留：

- iLink token、账号 owner 与 context token；
- 入站/出站耐久队列；
- 已处理消息幂等环；
- 本地文本历史；
- Attention MCP OAuth 与 Codex 登录；
- Runtime Reporter 安装和绑定信息。

重建时只清除：

- 旧 Codex/Claude 业务 `sessionId`；
- 与旧活动 turn 关联的瞬时断点。

不会删除 Attention 收藏，也不会要求重新扫码微信。

## 5. 端到端流程

```text
launcher 启动当前 Bridge 产物
  -> 启动 Codex Runtime 并验证 MCP 隔离
  -> 一次性 thread 真实调用 attention_get_my_account
  -> Bridge 开始接收 iLink 消息
  -> 空闲时立即检查远端 manifest
     -> 当前版本：一小时后再检查
     -> 权限/major 变化：consent_required，继续当前版本
     -> 兼容新版本：下载、校验、probe、stage
        -> 当前进程以约定退出码停止
        -> launcher 启动新版本
        -> 新版本完成 Runtime 启动，并执行 MCP 预检
        -> 收到下一条业务消息
        -> 旧 brainSession 身份不匹配，清除 thread ID
        -> 保留历史并创建新 thread
        -> 执行业务 MCP 调用
```

## 6. 错误与回滚

- 检查或下载失败：不退出当前进程，保留稳定错误码，下一小时重试；
- 候选探针失败：删除候选临时产物，不切换 current；
- 候选启动未在时限内标记健康：launcher 回滚 previous；
- 回滚后：当前运行版本与已保存会话身份不一致时同样重建业务会话；
- MCP 账号预检因授权或远端服务失败：候选 Bridge 仍可标记为已启动，微信普通对话继续，
  MCP 进入分层降级；版本健康不能与用户 OAuth 状态耦合；
- MCP 隔离或 app-server 协议初始化失败：候选未通过 Runtime 启动门，由 launcher 回滚；
- 队列繁忙：延迟检查和切换，直到入站与出站都为空；
- 状态写入失败：不得切换版本或丢弃现有 session，保留当前进程。

## 7. 状态与用户可见性

`attention channel status` 继续分别展示运行中的 Bridge 版本、远端最新版本、更新状态、
Codex Runtime 和 Attention MCP。升级完成后，运行版本必须来自新进程自身，不能只读取
manifest 推断。

本轮不新增日常微信通知，避免每次后台升级打扰用户。用户主动发送“状态”时可以看到当前
版本和 MCP 状态；若权限变化需要确认，本机状态命令必须明确显示 `consent_required`。

## 8. 测试

### 8.1 更新调度

- 服务启动后第一次空闲迭代立即检查，不受持久化 `lastCheckAt` 影响；
- 运行中未满 1 小时不重复检查，达到边界后检查；
- 运行中调度不再附加会把周期扩大到两小时的旧 jitter；
- 队列非空时不检查或切换，清空后立即执行已到期检查；
- 检查失败不停止 Bridge，并在下一周期重试。

### 8.2 会话迁移

- 同版本、同权限摘要恢复已有 session；
- 版本不同、权限摘要不同、缺失新字段或宿主不同均不恢复旧 session；
- 淘汰旧 session 后保留 history，并用 replay prompt 创建新 session；
- 新记录写入当前版本与权限摘要；
- 一次性账号预检永远不写入业务 session；
- 旧 `state.json` 可读取，并在下一业务 turn 自动迁移。

### 8.3 更新与回滚

- 兼容更新完成 stage 后以约定退出码重启；
- 新版本业务 turn 不恢复旧版本 session；
- 权限摘要变化和 major 更新保持 `consent_required`；
- 候选探针、启动或健康标记失败时回滚，iLink 和队列不丢失；
- MCP 工具在重建后的业务 session 中可真实调用。

### 8.4 回归门槛

- Bridge updater、managed launcher、pipeline、state 和 channel command 针对性测试；
- CLI 全量测试与类型检查；
- Web 对 CLI manifest/产物的兼容性测试；
- 生成单文件安装产物并执行同步检查；
- 版本号、manifest、源代码和产物一致；
- 完成真机 `/reset` 基线与自动版本重建验收后，才能声称问题修复。

## 9. 发布边界

实现需要新的 CLI/Bridge patch 版本，并同步公开 manifest 与单文件产物。代码提交、远端推送、
Web 部署和用户设备自动升级是不同步骤；实施验证完成不代表自动发布或部署。
