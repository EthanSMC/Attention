# C1：Attention CLI 本机管理闭环

依据：已获书面认可的 `2026-09-10-attention-cli-mcp-boundaries-design.md` 和本机 Shell 子方案。
当前没有可用 writing-plans 技能，本文是替代的仓库实现计划。

1. **撤回旧方向**：先备份并移除仅本任务新增的 Bridge `management-*` AI 解释/措辞模块及连线；保留更新命令别名、只检查语义与回归测试，不动既有用户副本。
2. **CLI 本机协议**：新增 `attention channel update <status|check|request|cancel|defer> [--json]`。status 读受信任运行快照；其余只向固定本机目录提交严格结构请求。返回 submitted 不等于 Bridge 已处理或安装成功。既有 `attention channel status --json` 保留诊断入口。
3. **服务循环适配**：固定目录、绑定进程实例、TTL、幂等 ID、有界扫描；无路径/URL/确认权限输入。更新器仍是 journal 单写入者；CLI 不等待同一活动 Agent turn 内无法运行的 service tick，模型收到 submitted 后结束本轮，后续查状态或收进程结果。
4. **Codex 受限 Shell**：独立工作目录，仅该目录和控制请求目录可写。审批、凭据、安装产物和整个用户目录不可写；关闭通用 Shell 出网与提权。CLI 查询跳过自动联网检查。更新下载由已存在的更新器完成，模型通过真实 CLI 路径调用。
5. **权限/版本**：只改变 Codex 的 Shell 能力，Claude 保持原约束；同步权限契约及安装说明。新权限不能继续用已发布 0.3.17 的身份；不覆盖历史产物。旧版本不能解释权限变化时明确要求一次电脑端批准。
6. **先测后改与验证**：先测解析/离线/超时/重复请求/伪造实例/符号链接；真实 controller/CLI 闭环；Codex 参数及提示回归；实际宿主可执行 CLI 查询、不能写出允许目录或篡改 journal、不能出网。随后全量 CLI 测试、类型检查、构建与产物一致性。不能用参数断言代替真机沙箱验收。

本轮不改当前设备服务、不合并、不推送、不部署。若宿主不能兑现安全约束，保留可验证的 CLI 功能并明确报告阻塞，不放宽沙箱。

## 实施与验收记录（2026-09-10）

- 旧 Bridge AI 管理模块及计划已备份到 `/tmp/attention-superseded-management.G8APeS` 后撤回；保留精确原生命令兜底，不增加 Bridge AI 分类器或措辞模型。
- 已实现 `channel update status/check/request/cancel/defer`。本机命令跳过启动联网检查，不依赖 MCP/OAuth；严格 JSON、请求 ID、10 分钟有效期、进程实例/owner 绑定、64 项扫描与队列限制、24 小时回执保留。
- 固定目录权限及 no-follow/nonblocking 读取：符号链接、FIFO、过大文件和额外命令参数都不能进入升级器。只有既有 controller 写审批 journal，CLI 无 confirm/权限批准入口。崩溃重投由 journal 与持久回执去重。
- 已接入 service loop，包含同一批微信消息之间的处理点；避免提交后等整批 Agent 对话结束。请求提交不等于已接收或升级；正在检查、忙碌、限流、无操作、已切换不可撤销均有结构化结果。
- 后台 Codex 受限 Shell 使用独立 cwd、明确的 Node/CLI 绝对路径和两个写根。新建/恢复线程及每轮沙箱均设置边界；Claude、前台未管理会话不扩大权限。
- 权限描述升为 schema 3，候选 CLI 版本 0.3.18；安装描述同步。0.3.17 的包及指纹保持不变。新 Shell 权限不能由旧版自动解释或批准，需要电脑端一次明确批准/引导安装。

### 验证

- 最终候选的隔离全仓回归：**185 个测试文件通过，8 个跳过；1557 项通过，165 项按既有条件跳过**。导出当前 tracked 文件和本任务新文件，不包含用户 ` 2.*` 副本；使用原有依赖，不安装或清理 node_modules。允许测试专用 localhost/IPC，关闭 live Resend 测试。
- 原工作区全量运行曾被既有重复 Drizzle 快照和沙箱端口限制影响；没有删除或修改这些用户文件，隔离复验通过。
- CLI 与 Web 类型检查通过；CLI esbuild（Node 22.16 target）构建通过；CLI 包/manifest/权限 sidecar 与安装 manifest/template 的同步检查通过；`git diff --check` 通过。
- 实际 macOS Codex app-server：新建线程接受同一沙箱配置；最终 CLI 能查询快照、提交请求；工作区及 inbox 写入成功，审批日志、状态、回执、外部目录、额外临时路径写入和 TCP 网络均返回 EPERM。
- 空的新线程尚无 rollout，因此不把其恢复失败当成已完成真实会话恢复验收；resume 参数覆盖通过回归测试。尚未替换当前设备服务，**不宣称真实微信聊天或真实版本切换端到端通过**。

### 明确保留的限制

- 沙箱会拒绝 PID 的 signal-0 探测；此时 `online: null`、`runningVersion: null`，仅返回已观察版本和时间。仍可依据未过期快照提交，回执标记存活未确认；最终必须查看服务端本机回执，不能报告已执行。
- 本机控制依赖 POSIX 文件保证。macOS 已实测，Linux 待目标机验收；Windows 保持只读宿主并返回 `local_control_platform_unsupported`。目录写隔离不等于完整的秘密文件读取隔离。
- 本次不包含业务 CLI、OAuth 修复、Hosted Agent、全局 CLI 的微信内自升级或摘要读取上游问题修复。
- 未提交本轮实现、未合并/推送/发布/部署，也未改动当前设备的全局 CLI 或运行服务。下一步是代码交付审阅及经授权的设备切换、微信自然语言验收。
