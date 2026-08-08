import type { Metadata } from "next";
import Link from "next/link";

import { AgentDocNavigation } from "../../components/agent-doc-navigation";
import { projectAgentConnections } from "../../server/agent-connection-projection";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  description: "把 Attention Skill 和 MCP 接入你正在使用的 Agent。",
  title: "Agent 接入文档",
};

function publicOrigin(): string {
  return process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/u, "") ?? "http://127.0.0.1:3000";
}

export default function AgentDocumentationIndexPage() {
  const origin = publicOrigin();
  const mcpUrl = process.env.ATTENTION_MCP_PUBLIC_URL ?? `${origin}/mcp`;
  const agentConnections = projectAgentConnections({ mcpUrl, origin });
  const agentLinks = agentConnections.map(({ displayName, id }) => ({ displayName, id }));

  return (
    <div className="agent-doc-layout">
      <AgentDocNavigation agentLinks={agentLinks} />
      <article className="agent-doc-index">
        <section className="agent-doc-index__hero">
          <p>Attention 文档</p>
          <h1>Agent 接入</h1>
          <p>Skill 只有一套；选择正在使用的 Agent，按对应文档完成加载、MCP 和授权。</p>
        </section>
        <section aria-labelledby="agent-doc-list-title" className="agent-doc-index__list">
          <h2 id="agent-doc-list-title">接入文档</h2>
          <div>
            {agentConnections.map((agent, index) => (
              <Link href={`/doc/${agent.id}`} key={agent.id}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <div><strong>{agent.displayName}</strong><small>{agent.status.label}</small></div>
                <span aria-hidden="true">↗</span>
              </Link>
            ))}
          </div>
        </section>
      </article>
    </div>
  );
}
