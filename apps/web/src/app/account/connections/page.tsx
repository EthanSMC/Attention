import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { ConnectionManager } from "../../../components/connection-manager";
import { PageIntro } from "../../../components/page-intro";
import { loadConnectionOverview } from "../../../server/account";
import { getWebDatabase } from "../../../server/db";
import { getPagePrincipal } from "../../../server/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "连接与授权" };

function publicOrigin(): string {
  return process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/u, "") ?? "http://127.0.0.1:3000";
}

export default async function ConnectionsPage() {
  const principal = await getPagePrincipal();
  if (!principal) redirect("/auth?return_to=%2Faccount%2Fconnections");
  const connections = await loadConnectionOverview(getWebDatabase(), principal.accountId);
  const origin = publicOrigin();
  return (
    <div className="page-shell page-shell--form">
      <PageIntro
        description={<p>OAuth 优先；API Key 只是高级备用。每种凭据独立吊销。</p>}
        eyebrow="我的 / 连接与授权"
        title="连接 Agent"
      />
      <ConnectionManager
        channels={connections.channels.map((item) => ({ ...item, boundAt: item.boundAt.toISOString(), revokedAt: item.revokedAt?.toISOString() ?? null }))}
        isMember={principal.isMember}
        mcpUrl={process.env.ATTENTION_MCP_PUBLIC_URL ?? `${origin}/mcp`}
        oauthConnections={connections.oauth.map((item) => ({ ...item, createdAt: item.createdAt.toISOString() }))}
        pats={connections.pats.map((item) => ({ ...item, createdAt: item.createdAt.toISOString(), expiresAt: item.expiresAt?.toISOString() ?? null }))}
        skillUrl={`${origin}/skills/attention/SKILL.md`}
      />
    </div>
  );
}
