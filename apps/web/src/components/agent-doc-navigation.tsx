"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";

export interface AgentDocumentLink {
  displayName: string;
  id: string;
}

export function revealActiveDocumentLink(
  element: Pick<HTMLElement, "scrollIntoView">,
) {
  element.scrollIntoView({
    behavior: "instant",
    block: "nearest",
    inline: "center",
  });
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
  const activeLinkRef = useRef<HTMLAnchorElement | null>(null);

  useEffect(() => {
    if (activeLinkRef.current) revealActiveDocumentLink(activeLinkRef.current);
  }, [activeAgentId, activeSection]);

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
        <Link
          aria-current={activeAgentId || activeSection ? undefined : "page"}
          href="/doc"
          ref={!activeAgentId && !activeSection ? activeLinkRef : undefined}
        >
          概览
        </Link>
        <Link
          aria-current={activeSection === "skill" ? "page" : undefined}
          href="/doc/skill"
          ref={activeSection === "skill" ? activeLinkRef : undefined}
        >
          Attention Skill
        </Link>
        {agentLinks.map((agent) => (
          <Link
            aria-current={agent.id === activeAgentId ? "page" : undefined}
            href={`/doc/${agent.id}`}
            key={agent.id}
            ref={agent.id === activeAgentId ? activeLinkRef : undefined}
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
