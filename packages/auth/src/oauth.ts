import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import {
  accounts,
  and,
  count,
  eq,
  gte,
  gt,
  isNull,
  oauthAccessTokens,
  oauthAuthorizationCodes,
  oauthClients,
  oauthRefreshTokens,
  sql,
  type AttentionDatabase,
} from "@attention/db";
import {
  CHANNEL_RUNTIME_RESOURCE,
  CHANNEL_RUNTIME_SCOPES,
} from "@attention/contracts";

import { resolveAccountCapabilities } from "./sessions";
import { createOpaqueToken, hashOpaqueToken } from "./tokens";

export const oauthAudiences = [
  "attention-mcp",
  "attention-sync",
  CHANNEL_RUNTIME_RESOURCE,
] as const;
export type OAuthAudience = (typeof oauthAudiences)[number];
export const oauthDefaultClientScopes = [
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
] as const;
export const oauthScopes = [
  ...oauthDefaultClientScopes,
  ...CHANNEL_RUNTIME_SCOPES,
] as const;
export type OAuthScope = (typeof oauthScopes)[number];

export const oauthScopesByAudience = {
  "attention-mcp": [
    "profile:read",
    "collection:read",
    "collection:write",
    "digest:read",
    "digest:write",
    "moderation:write",
    "moderation:court:read",
    "moderation:court:vote",
    "public:read",
    "public:full",
    "ai:search",
    "subscription:read",
  ],
  "attention-sync": ["sync:read", "sync:write"],
  [CHANNEL_RUNTIME_RESOURCE]: CHANNEL_RUNTIME_SCOPES,
} as const satisfies Record<OAuthAudience, readonly OAuthScope[]>;

export const oauthDefaultScopesByAudience = {
  "attention-mcp": [
    "profile:read",
    "collection:read",
    "collection:write",
    "digest:read",
    "digest:write",
    "moderation:write",
    "moderation:court:read",
    "moderation:court:vote",
    "public:read",
    "public:full",
    "ai:search",
    "subscription:read",
  ],
  "attention-sync": ["sync:read", "sync:write"],
  [CHANNEL_RUNTIME_RESOURCE]: CHANNEL_RUNTIME_SCOPES,
} as const satisfies Record<OAuthAudience, readonly OAuthScope[]>;

export type OAuthResourceMap = Readonly<Record<OAuthAudience, string>>;

const scopeSet = new Set<string>(oauthScopes);
const runtimeScopeSet = new Set<string>(CHANNEL_RUNTIME_SCOPES);
const codeTtlMs = 10 * 60 * 1_000;
const accessTtlMs = 60 * 60 * 1_000;
const refreshTtlMs = 30 * 24 * 60 * 60 * 1_000;

export type OAuthErrorCode =
  | "access_denied"
  | "invalid_client"
  | "invalid_grant"
  | "invalid_request"
  | "invalid_scope"
  | "invalid_target"
  | "unsupported_grant_type";

export class OAuthError extends Error {
  readonly code: OAuthErrorCode;
  constructor(code: OAuthErrorCode) {
    super(code);
    this.name = "OAuthError";
    this.code = code;
  }
}

/**
 * A public OAuth client registration quota was exhausted.
 *
 * This is deliberately separate from OAuthError: the submitted client
 * metadata is valid and callers should retry later instead of changing it.
 */
export class OAuthRegistrationRateLimitError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds = 60 * 60) {
    super("oauth_registration_rate_limited");
    this.name = "OAuthRegistrationRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function normalizeResourceUri(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthError("invalid_target");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (
    url.hash ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) {
    throw new OAuthError("invalid_target");
  }
  return url.href;
}

export function resolveOAuthResource(
  value: string,
  resources: OAuthResourceMap,
): { audience: OAuthAudience; resource: string } {
  const requested = normalizeResourceUri(value);
  for (const audience of oauthAudiences) {
    const configured = normalizeResourceUri(resources[audience]);
    if (requested === configured) return { audience, resource: configured };
  }
  throw new OAuthError("invalid_target");
}

export interface ValidatedAuthorizationRequest {
  audience: OAuthAudience;
  clientId: string;
  clientName: string;
  codeChallenge: string;
  redirectUri: string;
  resource: string;
  scopes: OAuthScope[];
  state: string | null;
}

function normalizeScopes(value: string): OAuthScope[] {
  const scopes = [...new Set(value.split(/\s+/u).filter(Boolean))].sort();
  if (scopes.length === 0 || scopes.some((scope) => !scopeSet.has(scope))) {
    throw new OAuthError("invalid_scope");
  }
  return scopes as OAuthScope[];
}

function isExactScopeSet(
  scopes: readonly OAuthScope[],
  expected: readonly OAuthScope[],
): boolean {
  const expectedSet = new Set<OAuthScope>(expected);
  return scopes.length === expectedSet.size && scopes.every((scope) => expectedSet.has(scope));
}

export function resolveOAuthClientAllowedScopes(value?: string): OAuthScope[] {
  if (value === undefined) return [...oauthDefaultClientScopes];
  const scopes = normalizeScopes(value);
  // Some MCP clients register the authorization server's exact advertised
  // scope union. DCR has no resource field, so narrow only that exact union to
  // the MCP audience; every other mixed-audience request remains invalid.
  if (isExactScopeSet(scopes, oauthScopes)) {
    return [...oauthScopesByAudience["attention-mcp"]];
  }
  const runtimeScopes = scopes.filter((scope) => runtimeScopeSet.has(scope));
  if (
    runtimeScopes.length > 0 &&
    (runtimeScopes.length !== CHANNEL_RUNTIME_SCOPES.length ||
      scopes.length !== CHANNEL_RUNTIME_SCOPES.length)
  ) {
    throw new OAuthError("invalid_scope");
  }
  return scopes;
}

function validPkceChallenge(value: string): boolean {
  return /^[A-Za-z0-9_-]{43,128}$/u.test(value);
}

export async function validateAuthorizationRequest(
  db: AttentionDatabase,
  input: {
    clientId: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    redirectUri: string;
    resource: string;
    resources: OAuthResourceMap;
    responseType: string;
    scope: string;
    state?: string | null;
  },
): Promise<ValidatedAuthorizationRequest> {
  if (
    input.responseType !== "code" ||
    input.codeChallengeMethod !== "S256" ||
    !validPkceChallenge(input.codeChallenge)
  ) {
    throw new OAuthError("invalid_request");
  }
  const resolvedResource = resolveOAuthResource(input.resource, input.resources);
  const [client] = await db
    .select()
    .from(oauthClients)
    .where(and(eq(oauthClients.clientId, input.clientId), eq(oauthClients.active, true)))
    .limit(1);
  if (!client) throw new OAuthError("invalid_client");
  if (!client.redirectUris.includes(input.redirectUri)) throw new OAuthError("invalid_request");
  const submittedScopes = normalizeScopes(input.scope);
  const requestedScopes =
    resolvedResource.audience === "attention-mcp" &&
    isExactScopeSet(submittedScopes, oauthScopes)
      ? [...oauthScopesByAudience["attention-mcp"]].sort()
      : submittedScopes;
  const audienceScopes = new Set<string>(oauthScopesByAudience[resolvedResource.audience]);
  if (
    requestedScopes.some((scope) => !audienceScopes.has(scope)) ||
    requestedScopes.some((scope) => !client.allowedScopes.includes(scope))
  ) {
    throw new OAuthError("invalid_scope");
  }
  return {
    audience: resolvedResource.audience,
    clientId: client.clientId,
    clientName: client.name,
    codeChallenge: input.codeChallenge,
    redirectUri: input.redirectUri,
    resource: resolvedResource.resource,
    scopes: requestedScopes,
    state: input.state?.slice(0, 512) ?? null,
  };
}

export async function createAuthorizationCode(
  db: AttentionDatabase,
  accountId: string,
  request: ValidatedAuthorizationRequest,
  now = new Date(),
): Promise<string> {
  const code = createOpaqueToken();
  await db.insert(oauthAuthorizationCodes).values({
    accountId,
    audience: request.audience,
    clientId: request.clientId,
    codeChallenge: request.codeChallenge,
    codeHash: await hashOpaqueToken(code),
    createdAt: now,
    expiresAt: new Date(now.getTime() + codeTtlMs),
    redirectUri: request.redirectUri,
    scopes: request.scopes,
  });
  return code;
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function secureStringEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export interface OAuthTokenPair {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  scope: string;
  tokenType: "Bearer";
}

async function issueTokenPair(
  db: Parameters<Parameters<AttentionDatabase["transaction"]>[0]>[0],
  input: {
    accountId: string;
    audience: string;
    clientId: string;
    now: Date;
    scopes: string[];
  },
): Promise<OAuthTokenPair> {
  const accessToken = createOpaqueToken();
  const refreshToken = createOpaqueToken();
  await db.insert(oauthAccessTokens).values({
    accountId: input.accountId,
    audience: input.audience,
    clientId: input.clientId,
    createdAt: input.now,
    expiresAt: new Date(input.now.getTime() + accessTtlMs),
    scopes: input.scopes,
    tokenHash: await hashOpaqueToken(accessToken),
  });
  await db.insert(oauthRefreshTokens).values({
    accountId: input.accountId,
    audience: input.audience,
    clientId: input.clientId,
    createdAt: input.now,
    expiresAt: new Date(input.now.getTime() + refreshTtlMs),
    scopes: input.scopes,
    tokenHash: await hashOpaqueToken(refreshToken),
  });
  return {
    accessToken,
    expiresIn: Math.floor(accessTtlMs / 1_000),
    refreshToken,
    scope: input.scopes.join(" "),
    tokenType: "Bearer",
  };
}

export async function exchangeAuthorizationCode(
  db: AttentionDatabase,
  input: {
    clientId: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
    resource: string;
    resources: OAuthResourceMap;
    now?: Date;
  },
): Promise<OAuthTokenPair> {
  if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(input.codeVerifier)) {
    throw new OAuthError("invalid_grant");
  }
  const now = input.now ?? new Date();
  const requestedResource = resolveOAuthResource(input.resource, input.resources);
  let codeHash: string;
  try { codeHash = await hashOpaqueToken(input.code); } catch { throw new OAuthError("invalid_grant"); }
  return db.transaction(async (tx) => {
    const [code] = await tx
      .select()
      .from(oauthAuthorizationCodes)
      .where(eq(oauthAuthorizationCodes.codeHash, codeHash))
      .for("update")
      .limit(1);
    if (
      !code || code.consumedAt || code.expiresAt <= now ||
      code.clientId !== input.clientId || code.redirectUri !== input.redirectUri ||
      !secureStringEqual(code.codeChallenge, pkceChallenge(input.codeVerifier))
    ) {
      throw new OAuthError("invalid_grant");
    }
    if (code.audience !== requestedResource.audience) {
      throw new OAuthError("invalid_target");
    }
    await tx.update(oauthAuthorizationCodes).set({ consumedAt: now }).where(eq(oauthAuthorizationCodes.id, code.id));
    return issueTokenPair(tx, {
      accountId: code.accountId,
      audience: code.audience,
      clientId: code.clientId,
      now,
      scopes: code.scopes,
    });
  });
}

export async function rotateRefreshToken(
  db: AttentionDatabase,
  input: {
    clientId: string;
    refreshToken: string;
    resource: string;
    resources: OAuthResourceMap;
    scope?: string;
    now?: Date;
  },
): Promise<OAuthTokenPair> {
  const now = input.now ?? new Date();
  const requestedResource = resolveOAuthResource(input.resource, input.resources);
  let tokenHash: string;
  try { tokenHash = await hashOpaqueToken(input.refreshToken); } catch { throw new OAuthError("invalid_grant"); }
  return db.transaction(async (tx) => {
    const [token] = await tx
      .select()
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.tokenHash, tokenHash))
      .for("update")
      .limit(1);
    if (
      !token || token.clientId !== input.clientId || token.status !== "active" ||
      token.consumedAt || token.revokedAt || token.expiresAt <= now
    ) throw new OAuthError("invalid_grant");
    if (token.audience !== requestedResource.audience) {
      throw new OAuthError("invalid_target");
    }
    const requestedScopes = input.scope ? normalizeScopes(input.scope) : [...token.scopes].sort();
    const existingScopes = [...token.scopes].sort();
    if (requestedScopes.some((scope) => !existingScopes.includes(scope))) {
      throw new OAuthError("invalid_scope");
    }
    await tx
      .update(oauthRefreshTokens)
      .set({ consumedAt: now, revokedAt: now, status: "revoked" })
      .where(eq(oauthRefreshTokens.id, token.id));
    return issueTokenPair(tx, {
      accountId: token.accountId,
      audience: token.audience,
      clientId: token.clientId,
      now,
      scopes: requestedScopes,
    });
  });
}

export interface OAuthPrincipal {
  accountId: string;
  audience: OAuthAudience;
  clientId: string;
  isFilter: boolean;
  isMember: boolean;
  scopes: string[];
  tokenId: string;
}

export async function resolveOAuthAccessToken(
  db: AttentionDatabase,
  rawToken: string,
  options: { audience: OAuthAudience; now?: Date },
): Promise<OAuthPrincipal | null> {
  const now = options.now ?? new Date();
  let tokenHash: string;
  try { tokenHash = await hashOpaqueToken(rawToken); } catch { return null; }
  const [token] = await db
    .select({
      accountId: oauthAccessTokens.accountId,
      audience: oauthAccessTokens.audience,
      clientId: oauthAccessTokens.clientId,
      expiresAt: oauthAccessTokens.expiresAt,
      id: oauthAccessTokens.id,
      scopes: oauthAccessTokens.scopes,
      status: oauthAccessTokens.status,
    })
    .from(oauthAccessTokens)
    .innerJoin(accounts, eq(accounts.id, oauthAccessTokens.accountId))
    .where(
      and(
        eq(oauthAccessTokens.tokenHash, tokenHash),
        eq(oauthAccessTokens.status, "active"),
        isNull(oauthAccessTokens.revokedAt),
        gt(oauthAccessTokens.expiresAt, now),
        eq(accounts.status, "active"),
      ),
    )
    .limit(1);
  if (!token || token.audience !== options.audience) return null;
  const capabilities = await resolveAccountCapabilities(db, token.accountId, now);
  await db.update(oauthAccessTokens).set({ lastUsedAt: now }).where(eq(oauthAccessTokens.id, token.id));
  return {
    ...token,
    ...capabilities,
    audience: options.audience,
    tokenId: token.id,
  };
}

export async function revokeOAuthToken(
  db: AttentionDatabase,
  rawToken: string,
  now = new Date(),
): Promise<void> {
  let tokenHash: string;
  try { tokenHash = await hashOpaqueToken(rawToken); } catch { return; }
  await db
    .update(oauthAccessTokens)
    .set({ revokedAt: now, status: "revoked" })
    .where(eq(oauthAccessTokens.tokenHash, tokenHash));
  await db
    .update(oauthRefreshTokens)
    .set({ revokedAt: now, status: "revoked" })
    .where(eq(oauthRefreshTokens.tokenHash, tokenHash));
}

export async function revokeOAuthClientConnection(
  db: AttentionDatabase,
  accountId: string,
  clientId: string,
  now = new Date(),
): Promise<void> {
  await db
    .update(oauthAccessTokens)
    .set({ revokedAt: now, status: "revoked" })
    .where(
      and(
        eq(oauthAccessTokens.accountId, accountId),
        eq(oauthAccessTokens.clientId, clientId),
        eq(oauthAccessTokens.status, "active"),
      ),
    );
  await db
    .update(oauthRefreshTokens)
    .set({ revokedAt: now, status: "revoked" })
    .where(
      and(
        eq(oauthRefreshTokens.accountId, accountId),
        eq(oauthRefreshTokens.clientId, clientId),
        eq(oauthRefreshTokens.status, "active"),
      ),
    );
}

function validRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.hash || url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
  } catch { return false; }
}

export async function registerPublicOAuthClient(
  db: AttentionDatabase,
  input: {
    allowedScopes?: readonly OAuthScope[];
    name: string;
    redirectUris: string[];
    requesterFingerprint: string;
  },
): Promise<{ allowedScopes: OAuthScope[]; clientId: string }> {
  const name = input.name.normalize("NFKC").trim().slice(0, 100);
  const redirectUris = [...new Set(input.redirectUris)].slice(0, 8);
  const allowedScopes = input.allowedScopes === undefined
    ? [...oauthDefaultClientScopes]
    : resolveOAuthClientAllowedScopes(input.allowedScopes.join(" "));
  if (!name || redirectUris.length === 0 || redirectUris.some((uri) => !validRedirectUri(uri))) {
    throw new OAuthError("invalid_request");
  }
  if (!/^[0-9a-f]{64}$/u.test(input.requesterFingerprint)) {
    throw new OAuthError("invalid_request");
  }
  const configuredGlobalLimit = Number.parseInt(
    process.env.ATTENTION_OAUTH_REGISTRATION_HOURLY_LIMIT ?? "100",
    10,
  );
  const globalHourlyLimit = Number.isFinite(configuredGlobalLimit)
    ? Math.min(Math.max(configuredGlobalLimit, 10), 10_000)
    : 100;
  const configuredSourceLimit = Number.parseInt(
    process.env.ATTENTION_OAUTH_REGISTRATION_SOURCE_HOURLY_LIMIT ?? "10",
    10,
  );
  const sourceHourlyLimit = Number.isFinite(configuredSourceLimit)
    ? Math.min(Math.max(configuredSourceLimit, 1), 100)
    : 10;
  const hourAgo = new Date(Date.now() - 60 * 60 * 1_000);
  return db.transaction(async (tx) => {
    // Dynamic registration is intentionally public. Lock in a fixed order so
    // concurrent requests cannot race either the global or per-source quota.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('oauth-dynamic-registration-global', 0))`,
    );
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${'oauth-dynamic-registration-source:' + input.requesterFingerprint}, 0))`,
    );
    const [recent] = await tx
      .select({ value: count() })
      .from(oauthClients)
      .where(gte(oauthClients.createdAt, hourAgo));
    const [recentForSource] = await tx
      .select({ value: count() })
      .from(oauthClients)
      .where(
        and(
          eq(oauthClients.registrationFingerprint, input.requesterFingerprint),
          gte(oauthClients.createdAt, hourAgo),
        ),
      );
    if (
      Number(recent?.value ?? 0) >= globalHourlyLimit ||
      Number(recentForSource?.value ?? 0) >= sourceHourlyLimit
    ) {
      throw new OAuthRegistrationRateLimitError();
    }
    const clientId = `att_${randomUUID()}`;
    await tx.insert(oauthClients).values({
      allowedScopes,
      clientId,
      name,
      registrationFingerprint: input.requesterFingerprint,
      redirectUris,
    });
    return { allowedScopes, clientId };
  });
}
