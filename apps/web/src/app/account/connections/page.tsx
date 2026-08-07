import type { Metadata } from "next";

import {
  ATTENTION_CAPABILITY_MANIFEST_PUBLIC_PATH,
  ATTENTION_MCP_TOOL_NAMES,
} from "@attention/contracts";

import { AccountSettingsShell } from "../../../components/account-settings-shell";
import { ConnectionManager } from "../../../components/connection-manager";
import { LoginModuleFallback } from "../../../components/login-module";
import { loadConnectionOverview } from "../../../server/account";
import { projectAgentConnections } from "../../../server/agent-connection-projection";
import { getWebDatabase } from "../../../server/db";
import { getPagePrincipal } from "../../../server/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "连接与授权" };

function publicOrigin(): string {
  return process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/u, "") ?? "http://127.0.0.1:3000";
}

export default async function ConnectionsPage() {
  const principal = await getPagePrincipal();
  if (!principal) {
    return <LoginModuleFallback returnTo="/account/connections" />;
  }
  const connections = await loadConnectionOverview(getWebDatabase(), principal.accountId);
  const origin = publicOrigin();
  const mcpUrl = process.env.ATTENTION_MCP_PUBLIC_URL ?? `${origin}/mcp`;
  return (
    <AccountSettingsShell
      active="connections"
      description="连接本地或第三方 Agent，管理 Attention Skill、OAuth 与 API Key。"
      isFilter={principal.isFilter}
      title="连接与授权"
    >
      <ConnectionManager
        agentConnections={projectAgentConnections({ mcpUrl, origin })}
        capabilityManifestUrl={`${origin}${ATTENTION_CAPABILITY_MANIFEST_PUBLIC_PATH}`}
        capabilityToolCount={ATTENTION_MCP_TOOL_NAMES.length}
        oauthConnections={connections.oauth.map((item) => ({ ...item, createdAt: item.createdAt.toISOString() }))}
        pats={connections.pats.map((item) => ({
          ...item,
          createdAt: item.createdAt.toISOString(),
          expiresAt: item.expiresAt?.toISOString() ?? null,
          lastUsedAt: item.lastUsedAt?.toISOString() ?? null,
        }))}
      />
    </AccountSettingsShell>
  );
}
