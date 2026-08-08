import Link from "next/link";

export interface AgentDocumentLink {
  displayName: string;
  id: string;
}

export function AgentDocNavigation({
  activeAgentId,
  activeSection,
  agentLinks,
}: {
  activeAgentId?: string;
  activeSection?: "skill";
  agentLinks: readonly AgentDocumentLink[];
}) {
  return (
    <aside className="agent-doc-sidebar">
      <Link className="agent-doc-brand" href="/doc">
        <span aria-hidden="true" className="signal-logo">
          <span className="signal-logo__human" />
          <span className="signal-logo__ai" />
        </span>
        <span>Attention 文档</span>
      </Link>
      <nav aria-label="Agent 接入文档">
        <p>目录</p>
        <Link aria-current={activeAgentId || activeSection ? undefined : "page"} href="/doc">
          概览
        </Link>
        <Link aria-current={activeSection === "skill" ? "page" : undefined} href="/doc/skill">
          Attention Skill
        </Link>
        {agentLinks.map((agent) => (
          <Link
            aria-current={agent.id === activeAgentId ? "page" : undefined}
            href={`/doc/${agent.id}`}
            key={agent.id}
          >
            {agent.displayName}
          </Link>
        ))}
      </nav>
      <Link className="agent-doc-sidebar__back" href="/account/connections">
        返回连接设置
      </Link>
    </aside>
  );
}
