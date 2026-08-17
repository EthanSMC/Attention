import { apiKeyScopes } from "@attention/auth";
import type { AttentionDatabase } from "@attention/db";
import { describe, expect, it } from "vitest";

import { loadConnectionOverview } from "./account";

function connectionDatabase(input: {
  oauth?: object[];
  pats: object[];
  runtimes?: object[];
}): AttentionDatabase {
  let queryIndex = 0;
  return {
    select() {
      queryIndex += 1;
      if (queryIndex === 1) {
        return {
          from() {
            return {
              innerJoin() {
                return {
                  where() {
                    return { orderBy: async () => input.oauth ?? [] };
                  },
                };
              },
            };
          },
        };
      }
      if (queryIndex === 3) {
        return {
          from() {
            return {
              leftJoin() {
                return {
                  where() {
                    return { orderBy: async () => input.runtimes ?? [] };
                  },
                };
              },
            };
          },
        };
      }
      return {
        from() {
          return {
            where() {
              return { orderBy: async () => input.pats };
            },
          };
        },
      };
    },
  } as unknown as AttentionDatabase;
}

function apiKey(scopes: string[]) {
  return {
    createdAt: new Date("2026-08-07T00:00:00.000Z"),
    expiresAt: null,
    id: crypto.randomUUID(),
    keyPrefix: "att_pat_example",
    lastUsedAt: null,
    name: "Local Agent",
    scopes,
    status: "active" as const,
  };
}

describe("loadConnectionOverview API Key scope truth", () => {
  it("keeps stored scopes and marks a legacy narrow-scope Key for rotation", async () => {
    const result = await loadConnectionOverview(
      connectionDatabase({ pats: [apiKey(["collection:read"])] }),
      crypto.randomUUID(),
    );

    expect(result.pats[0]).toMatchObject({
      needsRotation: true,
      scopes: ["collection:read"],
    });
  });

  it("recognizes a newly created full-scope Key as current", async () => {
    const result = await loadConnectionOverview(
      connectionDatabase({ pats: [apiKey([...apiKeyScopes])] }),
      crypto.randomUUID(),
    );

    expect(result.pats[0]).toMatchObject({
      needsRotation: false,
      scopes: apiKeyScopes,
    });
  });
});

describe("loadConnectionOverview Agent OAuth projection", () => {
  it("groups MCP, Sync, and Runtime connections by audience and client", async () => {
    const result = await loadConnectionOverview(
      connectionDatabase({
        oauth: [
          {
            audience: "attention-mcp",
            clientName: "Codex",
            deviceName: null,
            id: "10000000-0000-4000-8000-000000000001",
            kind: "mcp",
            label: "工作 MacBook",
            lastAuthorizedAt: new Date("2026-08-11T10:00:00.000Z"),
            lastUsedAt: new Date("2026-08-11T10:30:00.000Z"),
            scopes: ["collection:read", "collection:write"],
          },
          {
            audience: "attention-mcp",
            clientName: " Codex ",
            deviceName: null,
            id: "10000000-0000-4000-8000-000000000002",
            kind: "mcp",
            label: "家里 Mac mini",
            lastAuthorizedAt: new Date("2026-08-10T10:00:00.000Z"),
            lastUsedAt: null,
            scopes: ["collection:read"],
          },
          {
            audience: "attention-mcp",
            clientName: "Ｃｏｄｅｘ",
            deviceName: null,
            id: "10000000-0000-4000-8000-000000000003",
            kind: "mcp",
            label: "测试容器",
            lastAuthorizedAt: new Date("2026-08-09T10:00:00.000Z"),
            lastUsedAt: new Date("2026-08-09T11:00:00.000Z"),
            scopes: ["profile:read"],
          },
          {
            audience: "attention-sync",
            clientName: "Codex",
            deviceName: null,
            id: "10000000-0000-4000-8000-000000000004",
            kind: "mcp",
            label: "Codex Sync",
            lastAuthorizedAt: new Date("2026-08-11T08:00:00.000Z"),
            lastUsedAt: null,
            scopes: ["sync:read", "sync:write"],
          },
          {
            audience: "attention-channel-runtime",
            clientName: "Attention Local Channel Runtime",
            deviceName: "Ethan MacBook Pro",
            id: "20000000-0000-4000-8000-000000000001",
            kind: "runtime",
            label: "Ethan MacBook Pro",
            lastAuthorizedAt: new Date("2026-08-11T09:00:00.000Z"),
            lastUsedAt: new Date("2026-08-11T09:30:00.000Z"),
            scopes: ["runtime:heartbeat"],
          },
          {
            audience: "attention-channel-runtime",
            clientName: "Attention Local Channel Runtime",
            deviceName: "Studio Mac",
            id: "20000000-0000-4000-8000-000000000002",
            kind: "runtime",
            label: "Studio Mac",
            lastAuthorizedAt: new Date("2026-08-10T09:00:00.000Z"),
            lastUsedAt: null,
            scopes: ["runtime:register"],
          },
        ],
        pats: [],
        runtimes: [
          {
            agentIntegrationId: "codex",
            bindingLastSeenAt: new Date("2026-08-11T10:40:00.000Z"),
            bindingStatus: "healthy",
            deviceName: "Ethan MacBook Pro",
            installationId: "30000000-0000-4000-8000-000000000001",
            installationLastSeenAt: new Date("2026-08-11T10:39:00.000Z"),
            installationStatus: "active",
            runtimeCheckpoint: {
              bridge_status: "online",
              codex_phase: "healthy",
              ilink_status: "connected",
              last_error_code: null,
              last_healthy_at: "2026-08-11T10:39:00.000Z",
              last_successful_message_at: "2026-08-11T10:35:00.000Z",
              pending_inbound: 0,
              pending_outbound: 0,
            },
          },
        ],
      }),
      crypto.randomUUID(),
    );

    expect(result.agentOAuthConnections).toEqual([
      {
        audience: "attention-mcp",
        clientName: "Codex",
        connections: [
          {
            deviceName: null,
            id: "10000000-0000-4000-8000-000000000001",
            label: "工作 MacBook",
            lastAuthorizedAt: new Date("2026-08-11T10:00:00.000Z"),
            lastUsedAt: new Date("2026-08-11T10:30:00.000Z"),
            scopes: ["collection:read", "collection:write"],
          },
          {
            deviceName: null,
            id: "10000000-0000-4000-8000-000000000002",
            label: "家里 Mac mini",
            lastAuthorizedAt: new Date("2026-08-10T10:00:00.000Z"),
            lastUsedAt: null,
            scopes: ["collection:read"],
          },
          {
            deviceName: null,
            id: "10000000-0000-4000-8000-000000000003",
            label: "测试容器",
            lastAuthorizedAt: new Date("2026-08-09T10:00:00.000Z"),
            lastUsedAt: new Date("2026-08-09T11:00:00.000Z"),
            scopes: ["profile:read"],
          },
        ],
      },
      {
        audience: "attention-sync",
        clientName: "Codex",
        connections: [
          {
            deviceName: null,
            id: "10000000-0000-4000-8000-000000000004",
            label: "Codex Sync",
            lastAuthorizedAt: new Date("2026-08-11T08:00:00.000Z"),
            lastUsedAt: null,
            scopes: ["sync:read", "sync:write"],
          },
        ],
      },
      {
        audience: "attention-channel-runtime",
        clientName: "Attention Local Channel Runtime",
        connections: [
          {
            deviceName: "Ethan MacBook Pro",
            id: "20000000-0000-4000-8000-000000000001",
            label: "Ethan MacBook Pro",
            lastAuthorizedAt: new Date("2026-08-11T09:00:00.000Z"),
            lastUsedAt: new Date("2026-08-11T09:30:00.000Z"),
            scopes: ["runtime:heartbeat"],
          },
          {
            deviceName: "Studio Mac",
            id: "20000000-0000-4000-8000-000000000002",
            label: "Studio Mac",
            lastAuthorizedAt: new Date("2026-08-10T09:00:00.000Z"),
            lastUsedAt: null,
            scopes: ["runtime:register"],
          },
        ],
      },
    ]);
    expect(result.localChannelRuntimes).toHaveLength(1);
    expect(result.localChannelRuntimes[0]).toMatchObject({
      deviceName: "Ethan MacBook Pro",
      status: "online",
    });
    expect(JSON.stringify(result.agentOAuthConnections)).not.toMatch(
      /installation|clientId|token|hash/u,
    );
  });
});

describe("loadConnectionOverview local Channel runtime projection", () => {
  it("projects an account-owned healthy runtime without exposing opaque identifiers", async () => {
    const result = await loadConnectionOverview(
      connectionDatabase({
        pats: [],
        runtimes: [
          {
            agentIntegrationId: "codex",
            bindingLastSeenAt: new Date("2026-08-10T10:01:00.000Z"),
            bindingStatus: "healthy",
            deviceName: "Ethan's MacBook Pro",
            installationId: "57015b93-86c6-46b7-928c-dceddebc2c83",
            installationLastSeenAt: new Date("2026-08-10T10:00:00.000Z"),
            installationStatus: "active",
            runtimeCheckpoint: {
              bridge_status: "online",
              codex_phase: "healthy",
              ilink_status: "connected",
              last_error_code: null,
              last_healthy_at: "2026-08-10T10:00:00.000Z",
              last_successful_message_at: "2026-08-10T09:59:00.000Z",
              pending_inbound: 2,
              pending_outbound: 1,
            },
          },
        ],
      }),
      crypto.randomUUID(),
    );

    expect(result.localChannelRuntimes).toEqual([
      {
        deviceName: "Ethan's MacBook Pro",
        hostName: "Codex",
        lastSeenAt: new Date("2026-08-10T10:01:00.000Z"),
        lastSuccessfulMessageAt: new Date("2026-08-10T09:59:00.000Z"),
        pendingInbound: 2,
        pendingOutbound: 1,
        status: "online",
      },
    ]);
    expect(JSON.stringify(result.localChannelRuntimes)).not.toMatch(
      /57015b93|thread|message_ref|fingerprint|token/u,
    );
  });

  it("maps degraded, stale, and terminal runtime evidence conservatively", async () => {
    const result = await loadConnectionOverview(
      connectionDatabase({
        pats: [],
        runtimes: [
          {
            agentIntegrationId: "claude-code",
            bindingLastSeenAt: null,
            bindingStatus: "healthy",
            deviceName: "Studio Mac",
            installationId: "11111111-1111-4111-8111-111111111111",
            installationLastSeenAt: null,
            installationStatus: "degraded",
            runtimeCheckpoint: {
              bridge_status: "degraded",
              codex_phase: "degraded_runtime",
              ilink_status: "reconnecting",
              last_error_code: "runtime_unavailable",
              last_healthy_at: null,
              last_successful_message_at: null,
              pending_inbound: 0,
              pending_outbound: 0,
            },
          },
          {
            agentIntegrationId: "codex",
            bindingLastSeenAt: null,
            bindingStatus: "stale",
            deviceName: "Old Mac",
            installationId: "22222222-2222-4222-8222-222222222222",
            installationLastSeenAt: null,
            installationStatus: "stale",
            runtimeCheckpoint: null,
          },
          {
            agentIntegrationId: "codex",
            bindingLastSeenAt: null,
            bindingStatus: "disconnected",
            deviceName: "Offline Mac",
            installationId: "33333333-3333-4333-8333-333333333333",
            installationLastSeenAt: null,
            installationStatus: "disconnected",
            runtimeCheckpoint: null,
          },
        ],
      }),
      crypto.randomUUID(),
    );

    expect(result.localChannelRuntimes.map((runtime) => runtime.status)).toEqual([
      "degraded",
      "stale",
      "offline",
    ]);
  });
});
