import type { Metadata } from "next";

import { AgentPageContent } from "../../components/agent-page-content";
import { PageIntro } from "../../components/page-intro";
import { loadConnectionOverview } from "../../server/account";
import { buildAgentConnectionPrompt } from "../../server/agent-connection-prompt";
import { projectAgentConnections } from "../../server/agent-connection-projection";
import { getWebDatabase } from "../../server/db";
import { getPagePrincipal } from "../../server/session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  description: "把 Attention 接入你正在使用的本地 Agent。",
  title: "Agent",
};

function publicOrigin(): string {
  return process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/u, "") ?? "http://127.0.0.1:3000";
}

export default async function AgentPage() {
  const origin = publicOrigin();
  const agentDocumentationUrl = `${origin}/doc`;
  const mcpUrl = process.env.ATTENTION_MCP_PUBLIC_URL ?? `${origin}/mcp`;
  const supportedAgents = projectAgentConnections({ mcpUrl, origin }).map(
    ({ displayName }) => displayName,
  );
  const principal = await getPagePrincipal();
  const connectionOverview = principal
    ? await loadConnectionOverview(getWebDatabase(), principal.accountId)
    : null;

  return (
    <div className="page-shell page-shell--agent page-shell--primary">
      <PageIntro
        description={<p>本地 Agent 负责运行，Attention 负责保存和整理。选择你的方式，几步完成接入。</p>}
        eyebrow="Agent"
        title="让 AI 连接 Attention"
      />

      <AgentPageContent
        agentConnectionStatus={
          !principal
            ? "signed_out"
            : connectionOverview?.mcpOAuthConnections.length
              ? "connected"
              : "not_connected"
        }
        agentConnectionPrompt={buildAgentConnectionPrompt(agentDocumentationUrl)}
        agentDocumentationUrl={agentDocumentationUrl}
        bridgeConnectionStatus={
          !principal
            ? "signed_out"
            : connectionOverview?.localChannelRuntimes.some(
                  (runtime) => runtime.status === "online",
                )
              ? "online"
              : connectionOverview?.localChannelRuntimes.length
                ? "needs_attention"
                : "not_configured"
        }
        supportedAgents={supportedAgents}
        wechatBindingStatus={connectionOverview?.wechatBindingStatus ?? "signed_out"}
      />
    </div>
  );
}
