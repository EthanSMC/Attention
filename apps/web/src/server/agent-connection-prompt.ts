export function buildAgentConnectionPrompt(documentationUrl: string): string {
  const url = new URL(documentationUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Agent documentation URL must use HTTP or HTTPS");
  }

  return [
    "请帮我接入 Attention。",
    `先阅读公开文档：${url.toString()}`,
    "请识别你当前运行的 Agent 宿主和操作系统，只进入对应宿主的独立文档，按文档完成 Attention CLI、Skill、MCP、OAuth 与微信接入配置。",
    "不要让我复制 OAuth token，也不要把 API Key 写进对话、代码仓库或日志；需要浏览器授权时，停下来提示我在 Attention 页面确认。",
    "先真实调用 attention_get_my_account，并把返回的展示名和 Attention ID 告诉我；只有成功返回我的 Attention 账号信息才可以继续微信接入，仅看到本地配置不算完成。",
    "如果对应宿主使用 Attention 本机桥，请用能够持续读取命令输出的终端会话运行文档中的 attention channel start ... --background 命令。二维码首次出现时立即停下来让我展开当前终端扫码，不要等待命令结束后再复述二维码；如果你无法实时展示终端输出，就停下来让我在自己的终端运行该命令。扫码后由 Attention 安装当前用户的后台服务。不要读取、复述或上传 iLink 凭据。若宿主由自身管理微信渠道，严格按该宿主文档完成。",
    "扫码成功后，引导我在微信里发送一条真实链接。必须等 Agent 调用 Attention MCP 成功，并让我在 Attention 的“我的收藏”里看到这条内容，才可以宣布整个接入完成。",
  ].join("\n");
}
