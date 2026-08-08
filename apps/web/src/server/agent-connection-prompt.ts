export function buildAgentConnectionPrompt(documentationUrl: string): string {
  const url = new URL(documentationUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Agent documentation URL must use HTTP or HTTPS");
  }

  return [
    "请帮我接入 Attention。",
    `先阅读公开文档：${url.toString()}`,
    "请识别你当前运行的 Agent 宿主和操作系统，只进入对应宿主的独立文档，按文档完成 Attention Skill、MCP 与 OAuth 配置。",
    "不要让我复制 OAuth token，也不要把 API Key 写进对话、代码仓库或日志；需要浏览器授权时，停下来提示我在 Attention 页面确认。",
    "完成后必须真实调用 attention_get_my_account。只有成功返回我的 Attention 账号信息才算接入完成；仅看到本地配置不算完成。",
  ].join("\n");
}
