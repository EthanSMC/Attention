import type { Metadata } from "next";

import { AccountSettingsShell } from "../../../components/account-settings-shell";
import { ConnectionManager } from "../../../components/connection-manager";
import { LoginModuleFallback } from "../../../components/login-module";
import { loadConnectionOverview } from "../../../server/account";
import { getWebDatabase } from "../../../server/db";
import { getPagePrincipal } from "../../../server/session";
import { buildAgentConnectionPrompt } from "../../../server/agent-connection-prompt";
import {
  bridgeDeviceVersionView,
  publishedBridgeUpdate,
} from "../../../server/bridge-update-view";

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
  const agentDocumentationUrl = `${origin}/doc`;
  return (
    <AccountSettingsShell
      active="connections"
      description="连接本地或第三方 Agent，管理 Attention Skill、OAuth 与 API Key。"
      isFilter={principal.isFilter}
      title="连接与授权"
    >
      <ConnectionManager
        agentConnectionPrompt={buildAgentConnectionPrompt(agentDocumentationUrl)}
        agentDocumentationUrl={agentDocumentationUrl}
        localChannelRuntimes={connections.localChannelRuntimes.map((item) => ({
          ...item,
          lastSeenAt: item.lastSeenAt?.toISOString() ?? null,
          lastSuccessfulMessageAt:
            item.lastSuccessfulMessageAt?.toISOString() ?? null,
          version: bridgeDeviceVersionView({
            installedVersion: item.adapterVersion,
            latestVersion: publishedBridgeUpdate.latestVersion,
            minimumVersion: publishedBridgeUpdate.minimumVersion,
          }),
        }))}
        mcpOAuthConnections={connections.mcpOAuthConnections.map((group) => ({
          ...group,
          connections: group.connections.map((connection) => ({
            ...connection,
            lastAuthorizedAt: connection.lastAuthorizedAt.toISOString(),
            lastUsedAt: connection.lastUsedAt?.toISOString() ?? null,
          })),
        }))}
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
