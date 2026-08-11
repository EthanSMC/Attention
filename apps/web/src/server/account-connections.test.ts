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
