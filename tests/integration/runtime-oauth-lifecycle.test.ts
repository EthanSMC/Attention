import { createHash } from "node:crypto";

import * as auth from "@attention/auth";
import {
  accounts,
  createDatabase,
  eq,
  oauthAccessTokens,
  oauthAuthorizationCodes,
  oauthClients,
  oauthConnections,
  oauthRefreshTokens,
  type AttentionDatabase,
  type DatabaseHandle,
} from "@attention/db";
import { migrateDatabase } from "@attention/db/migrate";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const databaseUrl = process.env.TEST_RUNTIME_OAUTH_DATABASE_URL;
const accountId = "10000000-0000-4000-8000-000000000001";
const otherAccountId = "10000000-0000-4000-8000-000000000002";
const installationId = "20000000-0000-4000-8000-000000000001";
const otherInstallationId = "20000000-0000-4000-8000-000000000002";
const mcpIsolationConnectionId = "30000000-0000-4000-8000-000000000001";
const verifier = "runtime-pkce-verifier-that-is-at-least-forty-three-characters-123";
const challenge = createHash("sha256").update(verifier).digest("base64url");
const runtimeResource = "http://localhost:3000/api/runtime";
const resources = {
  "attention-channel-runtime": runtimeResource,
  "attention-mcp": "http://localhost:3000/mcp",
  "attention-sync": "http://localhost:3000/api/sync",
} as const;
const runtimeScopes = [
  "channel:bind:report",
  "channel:disconnect:report",
  "runtime:heartbeat",
  "runtime:register",
] as const;

type RuntimeIntentResolver = (
  db: AttentionDatabase,
  input: {
    accountId: string;
    audience: "attention-channel-runtime";
    clientId: string;
    label: string;
  },
) => Promise<
  | { label: string; mode: "create" }
  | { connectionId: string; label: string; mode: "rotate" }
>;

type RuntimeInstallationRevoker = (
  db: AttentionDatabase,
  input: { accountId: string; clientId: string; installationId: string },
  now?: Date,
) => Promise<boolean>;

function runtimeIntentResolver(): RuntimeIntentResolver {
  const candidate = Reflect.get(auth, "resolveRuntimeOAuthConnectionIntent") as
    | RuntimeIntentResolver
    | undefined;
  expect(candidate).toBeTypeOf("function");
  return candidate!;
}

function runtimeInstallationRevoker(): RuntimeInstallationRevoker {
  const candidate = Reflect.get(auth, "revokeRuntimeOAuthInstallation") as
    | RuntimeInstallationRevoker
    | undefined;
  expect(candidate).toBeTypeOf("function");
  return candidate!;
}

describe.skipIf(!databaseUrl)("Runtime OAuth logical lifecycle on PostgreSQL", () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    vi.stubEnv(
      "ATTENTION_HMAC_SECRET",
      "runtime-lifecycle-integration-secret-at-least-32-characters",
    );
    handle = createDatabase(databaseUrl!, { maxConnections: 8 });
    await migrateDatabase(handle.db);
  });

  beforeEach(async () => {
    await handle.sql.unsafe(
      "TRUNCATE TABLE oauth_clients, accounts RESTART IDENTITY CASCADE",
    );
    await handle.db.insert(accounts).values([
      { id: accountId, stableHandle: "runtime-oauth-account" },
      { id: otherAccountId, stableHandle: "runtime-oauth-other-account" },
    ]);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await handle?.close();
  });

  async function registerRuntimeClient(
    clientId: string,
    installationKeyHash: string,
    deviceName: string,
  ): Promise<void> {
    await handle.db.insert(oauthClients).values({
      allowedScopes: [...runtimeScopes],
      clientId,
      connectionKind: "runtime",
      deviceName,
      installationKeyHash,
      name: "Attention Local Channel Runtime",
      redirectUris: [`http://127.0.0.1:43820/${clientId}`],
    });
  }

  async function createRuntimeCode(
    targetAccountId: string,
    clientId: string,
    label: string,
    now: Date,
  ): Promise<{ code: string; intent: Awaited<ReturnType<RuntimeIntentResolver>> }> {
    const intent = await runtimeIntentResolver()(handle.db, {
      accountId: targetAccountId,
      audience: "attention-channel-runtime",
      clientId,
      label,
    });
    const code = await auth.createAuthorizationCode(
      handle.db,
      targetAccountId,
      {
        audience: "attention-channel-runtime",
        clientId,
        clientName: "Attention Local Channel Runtime",
        codeChallenge: challenge,
        redirectUri: `http://127.0.0.1:43820/${clientId}`,
        resource: runtimeResource,
        scopes: [...runtimeScopes],
        state: null,
      },
      intent,
      now,
    );
    return { code, intent };
  }

  async function exchangeRuntimeCode(
    clientId: string,
    code: string,
    now: Date,
  ) {
    return auth.exchangeAuthorizationCode(handle.db, {
      clientId,
      code,
      codeVerifier: verifier,
      now,
      redirectUri: `http://127.0.0.1:43820/${clientId}`,
      resource: runtimeResource,
      resources,
    });
  }

  it("copies only trusted Runtime client metadata onto the first logical connection", async () => {
    const hash = auth.hashRuntimeInstallationId(installationId);
    await registerRuntimeClient("runtime-client-first", hash, "Trusted Studio Mac");

    const { code, intent } = await createRuntimeCode(
      accountId,
      "runtime-client-first",
      "User Runtime Label",
      new Date("2026-08-11T10:00:00.000Z"),
    );
    expect(intent).toEqual({ label: "User Runtime Label", mode: "create" });
    const pair = await exchangeRuntimeCode(
      "runtime-client-first",
      code,
      new Date("2026-08-11T10:01:00.000Z"),
    );

    const [connection] = await handle.db
      .select()
      .from(oauthConnections)
      .where(eq(oauthConnections.id, pair.connectionId));
    expect(connection).toMatchObject({
      accountId,
      audience: "attention-channel-runtime",
      clientId: "runtime-client-first",
      deviceName: "Trusted Studio Mac",
      installationKeyHash: hash,
      kind: "runtime",
      label: "User Runtime Label",
      normalizedLabel: "user runtime label",
      revokedAt: null,
    });
  });

  it("reauthorizes a new DCR client by rotating credentials on the same connection ID", async () => {
    const hash = auth.hashRuntimeInstallationId(installationId);
    await registerRuntimeClient("runtime-client-old", hash, "Studio Mac");
    const first = await createRuntimeCode(
      accountId,
      "runtime-client-old",
      "Studio Runtime",
      new Date("2026-08-11T10:00:00.000Z"),
    );
    const firstPair = await exchangeRuntimeCode(
      "runtime-client-old",
      first.code,
      new Date("2026-08-11T10:01:00.000Z"),
    );

    await registerRuntimeClient("runtime-client-new", hash, "Studio Mac Renamed by OS");
    const second = await createRuntimeCode(
      accountId,
      "runtime-client-new",
      "Studio Runtime",
      new Date("2026-08-11T11:00:00.000Z"),
    );
    expect(second.intent).toEqual({
      connectionId: firstPair.connectionId,
      label: "Studio Runtime",
      mode: "rotate",
    });
    const secondPair = await exchangeRuntimeCode(
      "runtime-client-new",
      second.code,
      new Date("2026-08-11T11:01:00.000Z"),
    );

    expect(secondPair.connectionId).toBe(firstPair.connectionId);
    const [connection] = await handle.db
      .select()
      .from(oauthConnections)
      .where(eq(oauthConnections.id, firstPair.connectionId));
    expect(connection).toMatchObject({
      clientId: "runtime-client-new",
      deviceName: "Studio Mac Renamed by OS",
      installationKeyHash: hash,
      label: "Studio Runtime",
    });
    const accessTokens = await handle.db.select().from(oauthAccessTokens);
    const refreshTokens = await handle.db.select().from(oauthRefreshTokens);
    expect(accessTokens.map(({ clientId, status }) => [clientId, status])).toEqual([
      ["runtime-client-old", "revoked"],
      ["runtime-client-new", "active"],
    ]);
    expect(refreshTokens.map(({ clientId, status }) => [clientId, status])).toEqual([
      ["runtime-client-old", "revoked"],
      ["runtime-client-new", "active"],
    ]);
  });

  it("routes a legacy Runtime authorization code through the trusted installation resolver", async () => {
    const hash = auth.hashRuntimeInstallationId(installationId);
    await registerRuntimeClient("runtime-client-aware", hash, "Legacy Runtime Mac");
    const first = await createRuntimeCode(
      accountId,
      "runtime-client-aware",
      "Legacy Runtime Mac",
      new Date("2026-08-11T10:00:00.000Z"),
    );
    const firstPair = await exchangeRuntimeCode(
      "runtime-client-aware",
      first.code,
      new Date("2026-08-11T10:01:00.000Z"),
    );
    await registerRuntimeClient(
      "runtime-client-legacy-code",
      hash,
      "Legacy Runtime Mac",
    );
    const legacyCode = createHash("sha256")
      .update("legacy-runtime-authorization-code")
      .digest("base64url");
    await handle.db.insert(oauthAuthorizationCodes).values({
      accountId,
      audience: "attention-channel-runtime",
      clientId: "runtime-client-legacy-code",
      codeChallenge: challenge,
      codeHash: await auth.hashOpaqueToken(legacyCode),
      createdAt: new Date("2026-08-11T11:00:00.000Z"),
      expiresAt: new Date("2026-08-11T11:10:00.000Z"),
      redirectUri: "http://127.0.0.1:43820/runtime-client-legacy-code",
      scopes: [...runtimeScopes],
    });

    const legacyPair = await exchangeRuntimeCode(
      "runtime-client-legacy-code",
      legacyCode,
      new Date("2026-08-11T11:01:00.000Z"),
    );

    expect(legacyPair.connectionId).toBe(firstPair.connectionId);
    const [connection] = await handle.db
      .select()
      .from(oauthConnections)
      .where(eq(oauthConnections.id, firstPair.connectionId));
    expect(connection).toMatchObject({
      clientId: "runtime-client-legacy-code",
      deviceName: "Legacy Runtime Mac",
      installationKeyHash: hash,
      label: "Legacy Runtime Mac",
    });
    const [consumedCode] = await handle.db
      .select()
      .from(oauthAuthorizationCodes)
      .where(eq(
        oauthAuthorizationCodes.codeHash,
        await auth.hashOpaqueToken(legacyCode),
      ));
    expect(consumedCode).toMatchObject({
      connectionId: firstPair.connectionId,
      consumedAt: new Date("2026-08-11T11:01:00.000Z"),
    });
  });

  it("links a legacy Runtime refresh to the same trusted installation connection", async () => {
    const hash = auth.hashRuntimeInstallationId(installationId);
    await registerRuntimeClient("runtime-client-refresh-aware", hash, "Refresh Runtime Mac");
    const first = await createRuntimeCode(
      accountId,
      "runtime-client-refresh-aware",
      "Refresh Runtime Mac",
      new Date("2026-08-11T10:30:00.000Z"),
    );
    const firstPair = await exchangeRuntimeCode(
      "runtime-client-refresh-aware",
      first.code,
      new Date("2026-08-11T10:31:00.000Z"),
    );
    await registerRuntimeClient(
      "runtime-client-legacy-refresh",
      hash,
      "Refresh Runtime Mac",
    );
    const legacyRefresh = createHash("sha256")
      .update("legacy-runtime-refresh-token")
      .digest("base64url");
    const [legacyRow] = await handle.db.insert(oauthRefreshTokens).values({
      accountId,
      audience: "attention-channel-runtime",
      clientId: "runtime-client-legacy-refresh",
      connectionId: null,
      createdAt: new Date("2026-08-11T11:00:00.000Z"),
      expiresAt: new Date("2026-09-11T11:00:00.000Z"),
      scopes: [...runtimeScopes],
      tokenHash: await auth.hashOpaqueToken(legacyRefresh),
    }).returning({ id: oauthRefreshTokens.id });
    if (!legacyRow) throw new Error("legacy Runtime refresh fixture insert failed");

    const refreshed = await auth.rotateRefreshToken(handle.db, {
      clientId: "runtime-client-legacy-refresh",
      now: new Date("2026-08-11T11:01:00.000Z"),
      refreshToken: legacyRefresh,
      resource: runtimeResource,
      resources,
    });

    expect(refreshed.connectionId).toBe(firstPair.connectionId);
    const [consumedLegacy] = await handle.db
      .select()
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.id, legacyRow.id));
    expect(consumedLegacy).toMatchObject({
      connectionId: firstPair.connectionId,
      consumedAt: new Date("2026-08-11T11:01:00.000Z"),
      status: "revoked",
    });
    expect(await auth.resolveOAuthAccessToken(handle.db, firstPair.accessToken, {
      audience: "attention-channel-runtime",
      now: new Date("2026-08-11T11:01:30.000Z"),
    })).not.toBeNull();
  });

  it("fails closed for a legacy Runtime code without trusted DCR metadata", async () => {
    await handle.db.insert(oauthClients).values({
      allowedScopes: [...runtimeScopes],
      clientId: "runtime-client-untrusted-legacy",
      name: "Generic runtime-shaped client",
      redirectUris: ["http://127.0.0.1:43820/runtime-client-untrusted-legacy"],
    });
    const legacyCode = createHash("sha256")
      .update("untrusted-legacy-runtime-authorization-code")
      .digest("base64url");
    await handle.db.insert(oauthAuthorizationCodes).values({
      accountId,
      audience: "attention-channel-runtime",
      clientId: "runtime-client-untrusted-legacy",
      codeChallenge: challenge,
      codeHash: await auth.hashOpaqueToken(legacyCode),
      createdAt: new Date("2026-08-11T11:00:00.000Z"),
      expiresAt: new Date("2026-08-11T11:10:00.000Z"),
      redirectUri: "http://127.0.0.1:43820/runtime-client-untrusted-legacy",
      scopes: [...runtimeScopes],
    });

    await expect(exchangeRuntimeCode(
      "runtime-client-untrusted-legacy",
      legacyCode,
      new Date("2026-08-11T11:01:00.000Z"),
    )).rejects.toMatchObject({ code: "invalid_grant" });
    const [unconsumed] = await handle.db
      .select({ consumedAt: oauthAuthorizationCodes.consumedAt })
      .from(oauthAuthorizationCodes)
      .where(eq(
        oauthAuthorizationCodes.codeHash,
        await auth.hashOpaqueToken(legacyCode),
      ));
    expect(unconsumed?.consumedAt).toBeNull();
    expect(await handle.db.select().from(oauthConnections)).toHaveLength(0);
  });

  it("atomically renames the same Runtime connection during rotate", async () => {
    const hash = auth.hashRuntimeInstallationId(installationId);
    await registerRuntimeClient("runtime-client-rename-1", hash, "Runtime Mac");
    const first = await createRuntimeCode(
      accountId,
      "runtime-client-rename-1",
      "Old Runtime Label",
      new Date("2026-08-11T10:00:00.000Z"),
    );
    const firstPair = await exchangeRuntimeCode(
      "runtime-client-rename-1",
      first.code,
      new Date("2026-08-11T10:01:00.000Z"),
    );
    await registerRuntimeClient("runtime-client-rename-2", hash, "Runtime Mac");

    const second = await createRuntimeCode(
      accountId,
      "runtime-client-rename-2",
      "Typed New Runtime Label",
      new Date("2026-08-11T11:00:00.000Z"),
    );
    const secondPair = await exchangeRuntimeCode(
      "runtime-client-rename-2",
      second.code,
      new Date("2026-08-11T11:01:00.000Z"),
    );

    expect(secondPair.connectionId).toBe(firstPair.connectionId);
    const rows = await handle.db.select().from(oauthConnections);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: firstPair.connectionId,
      label: "Typed New Runtime Label",
      normalizedLabel: "typed new runtime label",
    });
  });

  it("converges concurrent first authorizations on the installation invariant", async () => {
    const hash = auth.hashRuntimeInstallationId(installationId);
    await registerRuntimeClient("runtime-client-race-1", hash, "Race Mac");
    await registerRuntimeClient("runtime-client-race-2", hash, "Race Mac");
    const first = await createRuntimeCode(
      accountId,
      "runtime-client-race-1",
      "Race Runtime",
      new Date("2026-08-11T10:00:00.000Z"),
    );
    const second = await createRuntimeCode(
      accountId,
      "runtime-client-race-2",
      "Race Runtime",
      new Date("2026-08-11T10:00:00.000Z"),
    );

    const results = await Promise.allSettled([
      exchangeRuntimeCode(
        "runtime-client-race-1",
        first.code,
        new Date("2026-08-11T10:01:00.000Z"),
      ),
      exchangeRuntimeCode(
        "runtime-client-race-2",
        second.code,
        new Date("2026-08-11T10:01:00.000Z"),
      ),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({
          code: "invalid_grant",
          name: "OAuthRuntimeInstallationConflictError",
        }),
        status: "rejected",
      }),
    ]);
    expect(await handle.db.select().from(oauthConnections)).toHaveLength(1);
  });

  it("scopes the active installation invariant and exact removal by account and audience", async () => {
    const hash = auth.hashRuntimeInstallationId(installationId);
    const otherHash = auth.hashRuntimeInstallationId(otherInstallationId);
    await registerRuntimeClient("runtime-client-remove", hash, "Remove Mac");
    await registerRuntimeClient("runtime-client-other", otherHash, "Other Mac");
    await handle.db.insert(oauthClients).values({
      allowedScopes: ["profile:read"],
      clientId: "mcp-isolation-client",
      name: "Generic MCP isolation client",
      redirectUris: ["http://127.0.0.1:43820/mcp-isolation"],
    });
    const target = await createRuntimeCode(
      accountId,
      "runtime-client-remove",
      "Remove Runtime",
      new Date("2026-08-11T10:00:00.000Z"),
    );
    const targetPair = await exchangeRuntimeCode(
      "runtime-client-remove",
      target.code,
      new Date("2026-08-11T10:01:00.000Z"),
    );
    const other = await createRuntimeCode(
      accountId,
      "runtime-client-other",
      "Other Runtime",
      new Date("2026-08-11T10:00:00.000Z"),
    );
    const otherPair = await exchangeRuntimeCode(
      "runtime-client-other",
      other.code,
      new Date("2026-08-11T10:01:00.000Z"),
    );
    await handle.db.insert(oauthConnections).values({
      accountId: otherAccountId,
      audience: "attention-channel-runtime",
      clientId: "runtime-client-remove",
      deviceName: "Other Account Mac",
      installationKeyHash: hash,
      kind: "runtime",
      label: "Other Account Runtime",
      lastAuthorizedAt: new Date("2026-08-11T10:00:00.000Z"),
      normalizedLabel: "other account runtime",
    });
    await handle.db.insert(oauthConnections).values({
      accountId,
      audience: "attention-mcp",
      clientId: "mcp-isolation-client",
      id: mcpIsolationConnectionId,
      installationKeyHash: hash,
      kind: "mcp",
      label: "MCP audience isolation",
      lastAuthorizedAt: new Date("2026-08-11T10:00:00.000Z"),
      normalizedLabel: "mcp audience isolation",
    });

    await expect(runtimeInstallationRevoker()(handle.db, {
      accountId,
      clientId: "runtime-client-remove",
      installationId,
    }, new Date("2026-08-11T12:00:00.000Z"))).resolves.toBe(true);

    const connections = await handle.db.select().from(oauthConnections);
    expect(connections.find(({ id }) => id === targetPair.connectionId)?.revokedAt)
      .toEqual(new Date("2026-08-11T12:00:00.000Z"));
    expect(connections.find(({ id }) => id === otherPair.connectionId)?.revokedAt)
      .toBeNull();
    expect(connections.find(({ accountId: owner }) => owner === otherAccountId)?.revokedAt)
      .toBeNull();
    expect(connections.find(({ id }) => id === mcpIsolationConnectionId)?.revokedAt)
      .toBeNull();
    const targetAccess = await handle.db
      .select()
      .from(oauthAccessTokens)
      .where(eq(oauthAccessTokens.connectionId, targetPair.connectionId));
    const otherAccess = await handle.db
      .select()
      .from(oauthAccessTokens)
      .where(eq(oauthAccessTokens.connectionId, otherPair.connectionId));
    const targetRefresh = await handle.db
      .select()
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.connectionId, targetPair.connectionId));
    const otherRefresh = await handle.db
      .select()
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.connectionId, otherPair.connectionId));
    expect(targetAccess.map(({ status }) => status)).toEqual(["revoked"]);
    expect(otherAccess.map(({ status }) => status)).toEqual(["active"]);
    expect(targetRefresh.map(({ status }) => status)).toEqual(["revoked"]);
    expect(otherRefresh.map(({ status }) => status)).toEqual(["active"]);
  });
});
