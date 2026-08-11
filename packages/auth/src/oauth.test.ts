import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import {
  oauthAccessTokens,
  oauthAuthorizationCodes,
  oauthConnections,
  oauthRefreshTokens,
  type AttentionDatabase,
} from "@attention/db";

import { apiKeyScopes } from "./api-credentials";
import * as oauthModule from "./oauth";
import {
  createAuthorizationCode,
  exchangeAuthorizationCode,
  hashRuntimeInstallationId,
  oauthAudiences,
  oauthDefaultScopesByAudience,
  oauthScopesByAudience,
  registerPublicOAuthClient,
  resolveOAuthAccessToken,
  resolveOAuthClientAllowedScopes,
  resolveOAuthResource,
  rotateRefreshToken,
  validateAuthorizationRequest,
} from "./oauth";
import { hashOpaqueToken } from "./tokens";

const resources = {
  "attention-channel-runtime": "https://attention.example/api/runtime",
  "attention-mcp": "https://attention.example/mcp",
  "attention-sync": "https://attention.example/api/sync",
} as const;

const accountId = "10000000-0000-4000-8000-000000000001";
const otherAccountId = "10000000-0000-4000-8000-000000000009";
const clientId = "attention-test-client";
const verifier = "oauth-pkce-verifier-that-is-at-least-forty-three-characters-123";
const challenge = createHash("sha256").update(verifier).digest("base64url");
const now = new Date("2026-08-11T12:00:00.000Z");

describe("OAuth resource indicators", () => {
  it("maps canonical resource URIs to separate MCP and sync audiences", () => {
    expect(resolveOAuthResource("HTTPS://ATTENTION.EXAMPLE/mcp", resources)).toEqual({
      audience: "attention-mcp",
      resource: resources["attention-mcp"],
    });
    expect(resolveOAuthResource(resources["attention-sync"], resources)).toEqual({
      audience: "attention-sync",
      resource: resources["attention-sync"],
    });
    expect(
      resolveOAuthResource(resources["attention-channel-runtime"], resources),
    ).toEqual({
      audience: "attention-channel-runtime",
      resource: resources["attention-channel-runtime"],
    });
  });

  it("advertises only the exact control-plane scopes for the runtime audience", () => {
    const expectedRuntimeScopes = [
      "runtime:register",
      "runtime:heartbeat",
      "channel:bind:report",
      "channel:disconnect:report",
    ];

    expect(oauthAudiences).toContain("attention-channel-runtime");
    expect(oauthScopesByAudience["attention-channel-runtime"]).toEqual(
      expectedRuntimeScopes,
    );
    expect(oauthDefaultScopesByAudience["attention-channel-runtime"]).toEqual(
      expectedRuntimeScopes,
    );
  });

  it("requests the complete published MCP scope set on first connection", () => {
    expect(oauthDefaultScopesByAudience["attention-mcp"]).toEqual(
      oauthScopesByAudience["attention-mcp"],
    );
  });

  it.each([
    "",
    "attention.example/mcp",
    "https://attention.example/mcp#fragment",
    "http://attention.example/mcp",
    "https://attention.example/unknown",
  ])("rejects invalid or unknown resource %s", (resource) => {
    expect(() => resolveOAuthResource(resource, resources)).toThrowError(
      expect.objectContaining({ code: "invalid_target" }),
    );
  });

  it("allows loopback HTTP for local MCP development only", () => {
    const localResources = {
      "attention-channel-runtime": "http://localhost:3000/api/runtime",
      "attention-mcp": "http://127.0.0.1:3000/mcp",
      "attention-sync": "http://localhost:3000/api/sync",
    } as const;
    expect(resolveOAuthResource(localResources["attention-mcp"], localResources).audience)
      .toBe("attention-mcp");
  });

  it("rejects a request that mixes scopes from different resource audiences", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                active: true,
                allowedScopes: ["profile:read", "sync:read"],
                clientId: "attention-test-client",
                name: "Attention test client",
                redirectUris: ["http://127.0.0.1:43820/callback"],
              },
            ],
          }),
        }),
      }),
    } as unknown as AttentionDatabase;

    await expect(
      validateAuthorizationRequest(db, {
        clientId: "attention-test-client",
        codeChallenge: "a".repeat(43),
        codeChallengeMethod: "S256",
        redirectUri: "http://127.0.0.1:43820/callback",
        resource: resources["attention-mcp"],
        resources,
        responseType: "code",
        scope: "profile:read sync:read",
      }),
    ).rejects.toMatchObject({ code: "invalid_scope" });
  });

  it("narrows the exact authorization-server scope union for every MCP client", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                active: true,
                allowedScopes: [...oauthScopesByAudience["attention-mcp"]],
                clientId: "attention-test-client",
                name: "Generic MCP client",
                redirectUris: ["http://127.0.0.1:43820/callback"],
              },
            ],
          }),
        }),
      }),
    } as unknown as AttentionDatabase;

    const request = await validateAuthorizationRequest(db, {
      clientId: "attention-test-client",
      codeChallenge: "a".repeat(43),
      codeChallengeMethod: "S256",
      redirectUri: "http://127.0.0.1:43820/callback",
      resource: resources["attention-mcp"],
      resources,
      responseType: "code",
      scope:
        "profile:read collection:read collection:write digest:read digest:write moderation:write moderation:court:read moderation:court:vote sync:read sync:write public:read public:full ai:search subscription:read runtime:register runtime:heartbeat channel:bind:report channel:disconnect:report",
    });

    expect(request.scopes).toEqual(
      [...oauthScopesByAudience["attention-mcp"]].sort(),
    );
  });

  it("does not apply the MCP union fallback to the runtime resource", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                active: true,
                allowedScopes: [...oauthScopesByAudience["attention-channel-runtime"]],
                clientId: "attention-runtime-client",
                name: "Runtime client",
                redirectUris: ["http://127.0.0.1:43820/callback"],
              },
            ],
          }),
        }),
      }),
    } as unknown as AttentionDatabase;

    await expect(
      validateAuthorizationRequest(db, {
        clientId: "attention-runtime-client",
        codeChallenge: "a".repeat(43),
        codeChallengeMethod: "S256",
        redirectUri: "http://127.0.0.1:43820/callback",
        resource: resources["attention-channel-runtime"],
        resources,
        responseType: "code",
        scope:
          "profile:read collection:read collection:write digest:read digest:write moderation:write moderation:court:read moderation:court:vote sync:read sync:write public:read public:full ai:search subscription:read runtime:register runtime:heartbeat channel:bind:report channel:disconnect:report",
      }),
    ).rejects.toMatchObject({ code: "invalid_scope" });
  });
});

describe("OAuth dynamic client scope policy", () => {
  it("refuses to derive a Runtime installation identity from non-UUID input", () => {
    vi.stubEnv(
      "ATTENTION_HMAC_SECRET",
      "attention-registration-test-secret-at-least-32-characters",
    );
    try {
      expect(() => hashRuntimeInstallationId("hardware-serial-or-mac"))
        .toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("defaults omitted registration scope to legacy MCP and sync access only", () => {
    expect(resolveOAuthClientAllowedScopes()).toEqual([
      "profile:read",
      "collection:read",
      "collection:write",
      "digest:read",
      "digest:write",
      "moderation:write",
      "moderation:court:read",
      "moderation:court:vote",
      "sync:read",
      "sync:write",
      "public:read",
      "public:full",
      "ai:search",
      "subscription:read",
    ]);
  });

  it("canonicalizes an explicitly requested non-runtime scope ceiling", () => {
    expect(
      resolveOAuthClientAllowedScopes("sync:write collection:read sync:write"),
    ).toEqual(["collection:read", "sync:write"]);
  });

  it("accepts the complete runtime-only scope set in any order", () => {
    expect(
      resolveOAuthClientAllowedScopes(
        "runtime:heartbeat channel:disconnect:report runtime:register channel:bind:report",
      ),
    ).toEqual([
      "channel:bind:report",
      "channel:disconnect:report",
      "runtime:heartbeat",
      "runtime:register",
    ]);
  });

  it.each([
    "runtime:register",
    "runtime:register runtime:heartbeat channel:bind:report channel:disconnect:report sync:read",
  ])("rejects partial or mixed runtime registration scopes: %s", (scope) => {
    expect(() => resolveOAuthClientAllowedScopes(scope)).toThrowError(
      expect.objectContaining({ code: "invalid_scope" }),
    );
  });

  it("rejects an explicitly empty registration scope", () => {
    expect(() => resolveOAuthClientAllowedScopes("   ")).toThrowError(
      expect.objectContaining({ code: "invalid_scope" }),
    );
  });

  it("persists the canonical requested scope ceiling on the client", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const transaction = {
      execute: async () => undefined,
      insert: () => ({
        values: async (value: Record<string, unknown>) => {
          inserted.push(value);
        },
      }),
      select: () => ({
        from: () => ({
          where: async () => [{ value: 0 }],
        }),
      }),
    };
    const db = {
      transaction: async <T>(callback: (tx: typeof transaction) => Promise<T>) =>
        callback(transaction),
    } as unknown as AttentionDatabase;

    await registerPublicOAuthClient(db, {
      allowedScopes: ["collection:read", "sync:write"],
      name: "Runtime client",
      redirectUris: ["http://127.0.0.1:43820/callback"],
      requesterFingerprint: "a".repeat(64),
    });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.allowedScopes).toEqual([
      "collection:read",
      "sync:write",
    ]);
  });
});

describe("OAuth connection-aware authorization", () => {
  it("touches the resolved logical connection with the bounded token-audit cadence", async () => {
    const rawAccessToken = opaqueToken("connection-last-used-access-token");
    const connectionId = "20000000-0000-4000-8000-000000000002";
    const updates: Array<{
      condition: unknown;
      table: unknown;
      value: Record<string, unknown>;
    }> = [];
    const db = {
      select: () => {
        let table: unknown;
        const query = {
          from: (value: unknown) => {
            table = value;
            return query;
          },
          innerJoin: () => query,
          limit: async () => table === oauthAccessTokens
            ? [{
                accountId,
                audience: "attention-mcp",
                clientId,
                connectionId,
                expiresAt: new Date("2026-08-11T13:00:00.000Z"),
                id: "30000000-0000-4000-8000-000000000003",
                scopes: ["profile:read"],
                status: "active",
              }]
            : [],
          where: () => query,
        };
        return query;
      },
      update: (table: unknown) => ({
        set: (value: Record<string, unknown>) => ({
          where: async (condition: unknown) => {
            updates.push({ condition, table, value });
          },
        }),
      }),
    } as unknown as AttentionDatabase;

    await expect(resolveOAuthAccessToken(db, rawAccessToken, {
      audience: "attention-mcp",
      now,
    })).resolves.toMatchObject({ accountId, clientId, tokenId: expect.any(String) });

    const connectionUpdate = updates.find(({ table }) => table === oauthConnections);
    expect(connectionUpdate?.value).toEqual({ lastUsedAt: now, updatedAt: now });
    expect(sqlParameterDates(connectionUpdate?.condition)).toContainEqual(
      new Date("2026-08-11T11:55:00.000Z"),
    );
  });

  it("stores exact normalized create intent on the authorization code", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const db = {
      insert: () => ({
        values: async (value: Record<string, unknown>) => {
          inserted.push(value);
        },
      }),
    } as unknown as AttentionDatabase;

    await createAuthorizationCode(
      db,
      accountId,
      authorizationRequest(),
      { mode: "create", label: "  Office   MacBook  " },
      now,
    );

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      connectionId: null,
      connectionLabel: "Office MacBook",
      normalizedConnectionLabel: "office macbook",
      replacementConnectionId: null,
    });
  });

  it("creates one logical connection and binds both issued tokens to it", async () => {
    const code = opaqueToken("create-code");
    const db = new OAuthStateDatabase({
      authorizationCodes: [await authorizationCode(code, {
        connectionLabel: "Office MacBook",
        normalizedConnectionLabel: "office macbook",
      })],
    });

    const pair = await exchangeAuthorizationCode(db.database, exchangeInput(code));

    expect(db.state.connections).toHaveLength(1);
    expect(pair.connectionId).toBe(db.state.connections[0]?.id);
    expect(db.state.accessTokens).toHaveLength(1);
    expect(db.state.refreshTokens).toHaveLength(1);
    expect(db.state.accessTokens[0]?.connectionId).toBe(pair.connectionId);
    expect(db.state.refreshTokens[0]?.connectionId).toBe(pair.connectionId);
  });

  it("materializes an isolated imported connection for a legacy authorization code", async () => {
    const code = opaqueToken("legacy-create-code");
    const db = new OAuthStateDatabase({
      authorizationCodes: [await authorizationCode(code)],
    });

    const pair = await exchangeAuthorizationCode(db.database, exchangeInput(code));

    expect(db.state.connections).toHaveLength(1);
    expect(db.state.connections[0]).toMatchObject({
      accountId,
      audience: "attention-mcp",
      clientId,
      id: pair.connectionId,
      kind: "mcp",
      label: `Imported connection ${pair.connectionId}`,
      normalizedLabel: `imported connection ${pair.connectionId}`,
      revokedAt: null,
    });
    expect(db.state.authorizationCodes[0]).toMatchObject({
      connectionId: pair.connectionId,
      consumedAt: now,
    });
    expect(db.state.accessTokens[0]?.connectionId).toBe(pair.connectionId);
    expect(db.state.refreshTokens[0]?.connectionId).toBe(pair.connectionId);
  });

  it("refresh rotation carries the old logical connection ID unchanged", async () => {
    const connectionId = "20000000-0000-4000-8000-000000000002";
    const rawRefreshToken = opaqueToken("refresh-token");
    const db = new OAuthStateDatabase({
      connections: [connection({ id: connectionId })],
      refreshTokens: [{
        accountId,
        audience: "attention-mcp",
        clientId,
        connectionId,
        consumedAt: null,
        createdAt: new Date("2026-08-10T12:00:00.000Z"),
        expiresAt: new Date("2026-09-10T12:00:00.000Z"),
        id: "40000000-0000-4000-8000-000000000004",
        revokedAt: null,
        scopes: ["profile:read"],
        status: "active",
        tokenHash: await hashOpaqueToken(rawRefreshToken),
      }],
    });

    const pair = await rotateRefreshToken(db.database, {
      clientId,
      now,
      refreshToken: rawRefreshToken,
      resource: resources["attention-mcp"],
      resources,
    });

    expect(pair.connectionId).toBe(connectionId);
    expect(db.state.accessTokens[0]?.connectionId).toBe(connectionId);
    expect(db.state.refreshTokens.at(-1)?.connectionId).toBe(connectionId);
  });

  it("materializes and atomically links an imported connection for a legacy refresh token", async () => {
    const rawRefreshToken = opaqueToken("legacy-refresh-token");
    const legacyRefreshId = "40000000-0000-4000-8000-000000000004";
    const db = new OAuthStateDatabase({
      refreshTokens: [credential({
        connectionId: null,
        consumedAt: null,
        id: legacyRefreshId,
        tokenHash: await hashOpaqueToken(rawRefreshToken),
      })],
    });

    const pair = await rotateRefreshToken(db.database, {
      clientId,
      now,
      refreshToken: rawRefreshToken,
      resource: resources["attention-mcp"],
      resources,
    });

    expect(db.state.connections).toHaveLength(1);
    expect(db.state.connections[0]).toMatchObject({
      accountId,
      audience: "attention-mcp",
      clientId,
      id: pair.connectionId,
      kind: "mcp",
      label: `Imported connection ${pair.connectionId}`,
      normalizedLabel: `imported connection ${pair.connectionId}`,
    });
    expect(db.state.refreshTokens.find(({ id }) => id === legacyRefreshId)).toMatchObject({
      connectionId: pair.connectionId,
      consumedAt: now,
      revokedAt: now,
      status: "revoked",
    });
    expect(db.state.accessTokens[0]?.connectionId).toBe(pair.connectionId);
    expect(db.state.refreshTokens.at(-1)?.connectionId).toBe(pair.connectionId);
  });

  it("fails closed for a legacy Runtime code without trusted installation metadata", async () => {
    const code = opaqueToken("legacy-untrusted-runtime-code");
    const db = new OAuthStateDatabase({
      authorizationCodes: [await authorizationCode(code, {
        audience: "attention-channel-runtime",
        scopes: ["runtime:register"],
      })],
    });

    await expect(exchangeAuthorizationCode(db.database, {
      ...exchangeInput(code),
      resource: resources["attention-channel-runtime"],
    })).rejects.toMatchObject({ code: "invalid_grant" });
    expect(db.state.authorizationCodes[0]?.consumedAt).toBeNull();
    expect(db.state.connections).toHaveLength(0);
  });

  it("replaces the locked matching connection and its credentials atomically", async () => {
    const replacementConnectionId = "20000000-0000-4000-8000-000000000002";
    const code = opaqueToken("replacement-code");
    const db = new OAuthStateDatabase({
      accessTokens: [credential({ connectionId: replacementConnectionId })],
      authorizationCodes: [await authorizationCode(code, {
        connectionLabel: "Office MacBook",
        normalizedConnectionLabel: "office macbook",
        replacementConnectionId,
      })],
      connections: [connection({ id: replacementConnectionId })],
      refreshTokens: [credential({
        connectionId: replacementConnectionId,
        id: "40000000-0000-4000-8000-000000000004",
      })],
    });

    const pair = await exchangeAuthorizationCode(db.database, exchangeInput(code));

    const oldConnection = db.state.connections.find(({ id }) => id === replacementConnectionId);
    const newConnection = db.state.connections.find(({ id }) => id === pair.connectionId);
    expect(oldConnection?.revokedAt).toEqual(now);
    expect(newConnection).toMatchObject({
      accountId,
      audience: "attention-mcp",
      label: "Office MacBook",
      normalizedLabel: "office macbook",
      revokedAt: null,
    });
    expect(db.state.accessTokens.find(({ id }) => id === "30000000-0000-4000-8000-000000000003")?.status)
      .toBe("revoked");
    expect(db.state.refreshTokens.find(({ id }) => id === "40000000-0000-4000-8000-000000000004")?.status)
      .toBe("revoked");
  });

  it("rolls back replacement revocation when token insertion fails", async () => {
    const replacementConnectionId = "20000000-0000-4000-8000-000000000002";
    const code = opaqueToken("failed-replacement-code");
    const db = new OAuthStateDatabase({
      accessTokens: [credential({ connectionId: replacementConnectionId })],
      authorizationCodes: [await authorizationCode(code, {
        connectionLabel: "Office MacBook",
        normalizedConnectionLabel: "office macbook",
        replacementConnectionId,
      })],
      connections: [connection({ id: replacementConnectionId })],
      failRefreshTokenInsert: true,
      refreshTokens: [credential({
        connectionId: replacementConnectionId,
        id: "40000000-0000-4000-8000-000000000004",
      })],
    });

    await expect(
      exchangeAuthorizationCode(db.database, exchangeInput(code)),
    ).rejects.toThrowError("injected_refresh_insert_failure");

    expect(db.state.connections).toHaveLength(1);
    expect(db.state.connections[0]?.revokedAt).toBeNull();
    expect(db.state.accessTokens[0]?.status).toBe("active");
    expect(db.state.refreshTokens[0]?.status).toBe("active");
    expect(db.state.authorizationCodes[0]?.consumedAt).toBeNull();
  });

  it.each([
    ["another account", { accountId: otherAccountId }],
    ["another audience", { audience: "attention-sync" }],
    ["another normalized label", { normalizedLabel: "home macbook" }],
  ])("rejects replacement of %s", async (_case, replacementOverrides) => {
    const replacementConnectionId = "20000000-0000-4000-8000-000000000002";
    const code = opaqueToken(`invalid-replacement-${_case}`);
    const db = new OAuthStateDatabase({
      authorizationCodes: [await authorizationCode(code, {
        connectionLabel: "Office MacBook",
        normalizedConnectionLabel: "office macbook",
        replacementConnectionId,
      })],
      connections: [connection({
        id: replacementConnectionId,
        ...replacementOverrides,
      })],
    });

    await expect(
      exchangeAuthorizationCode(db.database, exchangeInput(code)),
    ).rejects.toMatchObject({ code: "invalid_grant" });
    expect(db.state.connections[0]?.revokedAt).toBeNull();
    expect(db.state.connections).toHaveLength(1);
  });

  it("allows only one of two concurrent same-name confirmations", async () => {
    const firstCode = opaqueToken("concurrent-create-one");
    const secondCode = opaqueToken("concurrent-create-two");
    const db = new OAuthStateDatabase({
      authorizationCodes: [
        await authorizationCode(firstCode, {
          connectionLabel: "Office MacBook",
          normalizedConnectionLabel: "office macbook",
        }),
        await authorizationCode(secondCode, {
          connectionLabel: "OFFICE MACBOOK",
          normalizedConnectionLabel: "office macbook",
        }),
      ],
    });

    const results = await Promise.allSettled([
      exchangeAuthorizationCode(db.database, exchangeInput(firstCode)),
      exchangeAuthorizationCode(db.database, exchangeInput(secondCode)),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({
      reason: { message: "oauth_connection_name_conflict" },
      status: "rejected",
    });
    expect(db.state.connections).toHaveLength(1);
    expect(db.state.accessTokens).toHaveLength(1);
    expect(db.state.refreshTokens).toHaveLength(1);
  });

  describe("atomic MCP connection snapshot revocation", () => {
    const firstConnectionId = "20000000-0000-4000-8000-000000000002";
    const secondConnectionId = "20000000-0000-4000-8000-000000000003";
    const thirdConnectionId = "20000000-0000-4000-8000-000000000004";

    function candidate() {
      const value = Reflect.get(oauthModule, "revokeMcpOAuthConnectionSnapshot") as
        | ((
            db: AttentionDatabase,
            input: {
              accountId: string;
              clientName: string;
              connectionIds: string[];
            },
            revokedAt?: Date,
          ) => Promise<number>)
        | undefined;
      expect(value).toBeTypeOf("function");
      return value;
    }

    function revokeState(
      connections: ConnectionRow[],
      options: { failRefreshTokenRevoke?: boolean } = {},
    ): OAuthStateDatabase {
      return new OAuthStateDatabase({
        accessTokens: connections.map((row, index) => credential({
          accountId: row.accountId,
          audience: row.audience,
          clientId: row.clientId,
          connectionId: row.id,
          id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        })),
        connections,
        ...options,
        refreshTokens: connections.map((row, index) => credential({
          accountId: row.accountId,
          audience: row.audience,
          clientId: row.clientId,
          connectionId: row.id,
          id: `40000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        })),
      });
    }

    it("rejects an added matching connection without revoking the confirmed snapshot", async () => {
      const db = revokeState([
        connection({ id: firstConnectionId, clientName: "Codex" }),
        connection({ id: secondConnectionId, clientName: "Codex" }),
        connection({ id: thirdConnectionId, clientName: "Codex" }),
      ]);
      const revoke = candidate();
      if (!revoke) return;

      await expect(revoke(db.database, {
        accountId,
        clientName: "Codex",
        connectionIds: [firstConnectionId, secondConnectionId],
      }, now)).rejects.toMatchObject({ message: "oauth_connection_snapshot_stale" });

      expect(db.state.connections.every(({ revokedAt }) => revokedAt === null)).toBe(true);
      expect(db.state.accessTokens.every(({ status }) => status === "active")).toBe(true);
      expect(db.state.refreshTokens.every(({ status }) => status === "active")).toBe(true);
    });

    it.each([
      ["foreign", connection({ accountId: otherAccountId, id: secondConnectionId })],
      ["already revoked", connection({ id: secondConnectionId, revokedAt: now })],
      ["another client group", connection({ clientName: "Claude", id: secondConnectionId })],
    ])("rejects one %s ID and leaves every connection unchanged", async (_case, invalid) => {
      const db = revokeState([
        connection({ id: firstConnectionId, clientName: "Codex" }),
        invalid,
      ]);
      const revoke = candidate();
      if (!revoke) return;

      await expect(revoke(db.database, {
        accountId,
        clientName: "Codex",
        connectionIds: [firstConnectionId, secondConnectionId],
      }, now)).rejects.toMatchObject({ message: "oauth_connection_snapshot_stale" });

      expect(db.state.connections.find(({ id }) => id === firstConnectionId)?.revokedAt)
        .toBeNull();
      expect(db.state.accessTokens.every(({ status }) => status === "active")).toBe(true);
      expect(db.state.refreshTokens.every(({ status }) => status === "active")).toBe(true);
    });

    it("rolls back every connection and credential when a late revoke write fails", async () => {
      const db = revokeState([
        connection({ id: firstConnectionId, clientName: "Codex" }),
        connection({ id: secondConnectionId, clientName: "Codex" }),
      ], { failRefreshTokenRevoke: true });
      const revoke = candidate();
      if (!revoke) return;

      await expect(revoke(db.database, {
        accountId,
        clientName: "Codex",
        connectionIds: [firstConnectionId, secondConnectionId],
      }, now)).rejects.toThrow("injected_refresh_revoke_failure");

      expect(db.state.connections.every(({ revokedAt }) => revokedAt === null)).toBe(true);
      expect(db.state.accessTokens.every(({ status }) => status === "active")).toBe(true);
      expect(db.state.refreshTokens.every(({ status }) => status === "active")).toBe(true);
    });

    it("revokes the exact confirmed set and no other logical connection", async () => {
      const db = revokeState([
        connection({ id: firstConnectionId, clientName: "Codex" }),
        connection({ id: secondConnectionId, clientName: "Codex" }),
        connection({ clientName: "Claude", id: thirdConnectionId }),
      ]);
      const revoke = candidate();
      if (!revoke) return;

      await expect(revoke(db.database, {
        accountId,
        clientName: "Ｃｏｄｅｘ",
        connectionIds: [firstConnectionId, secondConnectionId],
      }, now)).resolves.toBe(2);

      expect(db.state.connections.map(({ id, revokedAt }) => [id, revokedAt])).toEqual([
        [firstConnectionId, now],
        [secondConnectionId, now],
        [thirdConnectionId, null],
      ]);
      expect(db.state.accessTokens.map(({ status }) => status)).toEqual([
        "revoked",
        "revoked",
        "active",
      ]);
      expect(db.state.refreshTokens.map(({ status }) => status)).toEqual([
        "revoked",
        "revoked",
        "active",
      ]);
    });
  });
});

describe("API key scope boundary", () => {
  it("keeps runtime control-plane scopes out of PAT credentials", () => {
    expect(apiKeyScopes).toEqual([
      "profile:read",
      "collection:read",
      "collection:write",
      "digest:read",
      "digest:write",
      "moderation:write",
      "moderation:court:read",
      "moderation:court:vote",
      "sync:read",
      "sync:write",
      "public:read",
      "public:full",
      "ai:search",
      "subscription:read",
    ]);
  });
});

function authorizationRequest() {
  return {
    audience: "attention-mcp" as const,
    clientId,
    clientName: "Attention Test Client",
    codeChallenge: challenge,
    redirectUri: "http://127.0.0.1:43820/callback",
    resource: resources["attention-mcp"],
    scopes: ["profile:read" as const],
    state: null,
  };
}

function exchangeInput(code: string) {
  return {
    clientId,
    code,
    codeVerifier: verifier,
    now,
    redirectUri: "http://127.0.0.1:43820/callback",
    resource: resources["attention-mcp"],
    resources,
  };
}

interface AuthorizationCodeRow {
  accountId: string;
  audience: string;
  clientId: string;
  codeChallenge: string;
  codeHash: string;
  connectionId: string | null;
  connectionLabel: string | null;
  consumedAt: Date | null;
  createdAt: Date;
  expiresAt: Date;
  id: string;
  normalizedConnectionLabel: string | null;
  redirectUri: string;
  replacementConnectionId: string | null;
  scopes: string[];
}

interface ConnectionRow {
  accountId: string;
  audience: string;
  clientId: string;
  clientName: string;
  createdAt: Date;
  id: string;
  kind: "mcp" | "runtime";
  label: string;
  lastAuthorizedAt: Date;
  lastUsedAt: Date | null;
  normalizedLabel: string;
  revokedAt: Date | null;
  updatedAt: Date;
}

interface CredentialRow {
  accountId: string;
  audience: string;
  clientId: string;
  connectionId: string | null;
  consumedAt?: Date | null;
  createdAt: Date;
  expiresAt: Date;
  id: string;
  revokedAt: Date | null;
  scopes: string[];
  status: "active" | "revoked";
  tokenHash: string;
}

interface OAuthState {
  accessTokens: CredentialRow[];
  authorizationCodes: AuthorizationCodeRow[];
  connections: ConnectionRow[];
  refreshTokens: CredentialRow[];
}

async function authorizationCode(
  rawCode: string,
  overrides: Partial<AuthorizationCodeRow> = {},
): Promise<AuthorizationCodeRow> {
  return {
    accountId,
    audience: "attention-mcp",
    clientId,
    codeChallenge: challenge,
    codeHash: await hashOpaqueToken(rawCode),
    connectionId: null,
    connectionLabel: null,
    consumedAt: null,
    createdAt: new Date("2026-08-11T11:00:00.000Z"),
    expiresAt: new Date("2026-08-11T12:05:00.000Z"),
    id: `50000000-0000-4000-8000-${createHash("sha256").update(rawCode).digest("hex").slice(0, 12)}`,
    normalizedConnectionLabel: null,
    redirectUri: "http://127.0.0.1:43820/callback",
    replacementConnectionId: null,
    scopes: ["profile:read"],
    ...overrides,
  };
}

function opaqueToken(seed: string): string {
  return createHash("sha256").update(seed).digest("base64url");
}

function connection(overrides: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    accountId,
    audience: "attention-mcp",
    clientId,
    clientName: "Attention Test Client",
    createdAt: new Date("2026-08-10T10:00:00.000Z"),
    id: "20000000-0000-4000-8000-000000000002",
    kind: "mcp",
    label: "Office MacBook",
    lastAuthorizedAt: new Date("2026-08-10T10:00:00.000Z"),
    lastUsedAt: null,
    normalizedLabel: "office macbook",
    revokedAt: null,
    updatedAt: new Date("2026-08-10T10:00:00.000Z"),
    ...overrides,
  };
}

function credential(overrides: Partial<CredentialRow> = {}): CredentialRow {
  return {
    accountId,
    audience: "attention-mcp",
    clientId,
    connectionId: "20000000-0000-4000-8000-000000000002",
    createdAt: new Date("2026-08-10T10:00:00.000Z"),
    expiresAt: new Date("2026-09-10T10:00:00.000Z"),
    id: "30000000-0000-4000-8000-000000000003",
    revokedAt: null,
    scopes: ["profile:read"],
    status: "active",
    tokenHash: "a".repeat(64),
    ...overrides,
  };
}

class OAuthStateDatabase {
  state: OAuthState;
  readonly database: AttentionDatabase;
  private readonly failRefreshTokenInsert: boolean;
  private readonly failRefreshTokenRevoke: boolean;
  private transactionTail: Promise<void> = Promise.resolve();
  private nextId = 10;

  constructor(input: Partial<OAuthState> & {
    failRefreshTokenInsert?: boolean;
    failRefreshTokenRevoke?: boolean;
  }) {
    this.state = {
      accessTokens: input.accessTokens ?? [],
      authorizationCodes: input.authorizationCodes ?? [],
      connections: input.connections ?? [],
      refreshTokens: input.refreshTokens ?? [],
    };
    this.failRefreshTokenInsert = input.failRefreshTokenInsert ?? false;
    this.failRefreshTokenRevoke = input.failRefreshTokenRevoke ?? false;
    this.database = {
      transaction: <T>(callback: (tx: AttentionDatabase) => Promise<T>) =>
        this.transaction(callback),
    } as unknown as AttentionDatabase;
  }

  private async transaction<T>(callback: (tx: AttentionDatabase) => Promise<T>): Promise<T> {
    const previous = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const working = structuredClone(this.state);
    try {
      const result = await callback(this.transactionDatabase(working));
      this.state = working;
      return result;
    } finally {
      release();
    }
  }

  private transactionDatabase(state: OAuthState): AttentionDatabase {
    return {
      insert: (table: unknown) => ({
        values: (value: Record<string, unknown>) => this.insert(state, table, value),
      }),
      select: () => this.select(state),
      update: (table: unknown) => ({
        set: (value: Record<string, unknown>) => ({
          where: async (condition: unknown) => this.update(state, table, value, condition),
        }),
      }),
    } as unknown as AttentionDatabase;
  }

  private select(state: OAuthState) {
    let table: unknown;
    let condition: unknown;
    const execute = () => {
      const strings = sqlParameterStrings(condition);
      if (table === oauthAuthorizationCodes) {
        return state.authorizationCodes.filter((row) => strings.includes(row.codeHash));
      }
      if (table === oauthRefreshTokens) {
        return state.refreshTokens
          .filter((row) => strings.includes(row.tokenHash) || strings.includes(row.id));
      }
      if (table === oauthConnections) {
        const hasSpecificId = state.connections.some((row) => strings.includes(row.id));
        return hasSpecificId
          ? state.connections.filter((row) => strings.includes(row.id))
          : state.connections;
      }
      return [];
    };
    const query = {
      for: () => query,
      from: (value: unknown) => {
        table = value;
        return query;
      },
      innerJoin: () => query,
      limit: async () => execute().slice(0, 1),
      then: <TResult1 = unknown, TResult2 = never>(
        onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) => Promise.resolve(execute()).then(onfulfilled, onrejected),
      where: (value: unknown) => {
        condition = value;
        return query;
      },
    };
    return query;
  }

  private insert(state: OAuthState, table: unknown, value: Record<string, unknown>) {
    const execute = () => {
      if (table === oauthConnections) {
        if (state.connections.some((row) =>
          row.accountId === value.accountId &&
          row.audience === value.audience &&
          row.normalizedLabel === value.normalizedLabel &&
          row.revokedAt === null
        )) {
          throw Object.assign(new Error("duplicate key"), {
            code: "23505",
            constraint_name: "oauth_connections_active_name_unique",
          });
        }
        const id = typeof value.id === "string"
          ? value.id
          : `60000000-0000-4000-8000-${String(this.nextId++).padStart(12, "0")}`;
        state.connections.push({
          ...(value as unknown as ConnectionRow),
          createdAt: (value.createdAt as Date | undefined) ?? now,
          id,
          lastUsedAt: null,
          revokedAt: null,
          updatedAt: (value.updatedAt as Date | undefined) ?? now,
        });
        return [{ id }];
      }
      if (table === oauthAccessTokens) {
        state.accessTokens.push({
          ...(value as unknown as CredentialRow),
          id: `70000000-0000-4000-8000-${String(this.nextId++).padStart(12, "0")}`,
          revokedAt: null,
          status: "active",
        });
      }
      if (table === oauthRefreshTokens) {
        if (this.failRefreshTokenInsert) throw new Error("injected_refresh_insert_failure");
        state.refreshTokens.push({
          ...(value as unknown as CredentialRow),
          consumedAt: null,
          id: `80000000-0000-4000-8000-${String(this.nextId++).padStart(12, "0")}`,
          revokedAt: null,
          status: "active",
        });
      }
      return [];
    };
    return {
      returning: async () => execute(),
      then: <TResult1 = unknown, TResult2 = never>(
        onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) => Promise.resolve().then(execute).then(onfulfilled, onrejected),
    };
  }

  private update(
    state: OAuthState,
    table: unknown,
    value: Record<string, unknown>,
    condition: unknown,
  ): void {
    const strings = sqlParameterStrings(condition);
    if (table === oauthAuthorizationCodes) {
      for (const row of state.authorizationCodes) {
        if (strings.includes(row.id)) Object.assign(row, value);
      }
      return;
    }
    if (table === oauthConnections) {
      for (const row of state.connections) {
        if (strings.includes(row.id)) Object.assign(row, value);
      }
      return;
    }
    if (
      table === oauthRefreshTokens &&
      value.status === "revoked" &&
      this.failRefreshTokenRevoke
    ) {
      throw new Error("injected_refresh_revoke_failure");
    }
    const rows = table === oauthAccessTokens ? state.accessTokens : state.refreshTokens;
    for (const row of rows) {
      if (strings.includes(row.id) || (row.connectionId && strings.includes(row.connectionId))) {
        Object.assign(row, value);
      }
    }
  }
}

function sqlParameterStrings(value: unknown, seen = new WeakSet<object>()): string[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const result: string[] = [];
  for (const child of Object.values(value)) result.push(...sqlParameterStrings(child, seen));
  return result;
}

function sqlParameterDates(value: unknown, seen = new WeakSet<object>()): Date[] {
  if (value instanceof Date) return [value];
  if (!value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const result: Date[] = [];
  for (const child of Object.values(value)) result.push(...sqlParameterDates(child, seen));
  return result;
}
