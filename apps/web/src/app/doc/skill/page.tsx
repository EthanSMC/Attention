import type { Metadata } from "next";

import { AgentSkillDocument } from "../../../components/agent-skill-document";
import { projectAgentConnections } from "../../../server/agent-connection-projection";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  description: "Attention Agent 共用的 Skill 文档。",
  title: "Attention Skill",
};

function publicOrigin(): string {
  return process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/u, "") ?? "http://127.0.0.1:3000";
}

export default function AttentionSkillPage() {
  const origin = publicOrigin();
  const mcpUrl = process.env.ATTENTION_MCP_PUBLIC_URL ?? `${origin}/mcp`;
  const connections = projectAgentConnections({ mcpUrl, origin });
  const canonical = connections.find((connection) => connection.id !== "workbuddy" && connection.skillUrl);
  const workbuddy = connections.find((connection) => connection.id === "workbuddy");

  return (
    <AgentSkillDocument
      agentLinks={connections.map(({ displayName, id }) => ({ displayName, id }))}
      canonicalSha256={canonical?.skillSha256 ?? null}
      canonicalUrl={canonical?.skillUrl ?? null}
      workbuddySha256={workbuddy?.skillSha256 ?? null}
      workbuddyUrl={workbuddy?.skillUrl ?? null}
    />
  );
}
