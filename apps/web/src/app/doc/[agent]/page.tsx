import type { Metadata } from "next";
import { notFound } from "next/navigation";

import {
  AGENT_INTEGRATION_IDS,
  ATTENTION_CAPABILITY_MANIFEST_PUBLIC_PATH,
  ATTENTION_MCP_TOOL_NAMES,
} from "@attention/contracts";

import { AgentInstallDocument } from "../../../components/agent-install-document";
import { projectAgentConnections } from "../../../server/agent-connection-projection";

function publicOrigin(): string {
  return process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/u, "") ?? "http://127.0.0.1:3000";
}

function connections() {
  const origin = publicOrigin();
  const mcpUrl = process.env.ATTENTION_MCP_PUBLIC_URL ?? `${origin}/mcp`;
  return { agents: projectAgentConnections({ mcpUrl, origin }), origin };
}

export function generateStaticParams() {
  return AGENT_INTEGRATION_IDS.map((agent) => ({ agent }));
}

export async function generateMetadata({ params }: { params: Promise<{ agent: string }> }): Promise<Metadata> {
  const { agent } = await params;
  const connection = connections().agents.find((item) => item.id === agent);
  return connection ? { title: `${connection.displayName} 接入` } : { title: "Agent 接入文档" };
}

export default async function AgentDocumentationPage({ params }: { params: Promise<{ agent: string }> }) {
  const { agent } = await params;
  const { agents, origin } = connections();
  const connection = agents.find((item) => item.id === agent);
  if (!connection) notFound();

  return (
    <AgentInstallDocument
      agentLinks={agents.map(({ displayName, id }) => ({ displayName, id }))}
      capabilityManifestUrl={`${origin}${ATTENTION_CAPABILITY_MANIFEST_PUBLIC_PATH}`}
      capabilityToolCount={ATTENTION_MCP_TOOL_NAMES.length}
      connection={connection}
    />
  );
}
