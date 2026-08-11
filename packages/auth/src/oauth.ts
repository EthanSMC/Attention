import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import {
  accounts,
  and,
  count,
  eq,
  gte,
  gt,
  inArray,
  isNull,
  lte,
  oauthAccessTokens,
  oauthAuthorizationCodes,
  oauthClients,
  oauthConnections,
  oauthRefreshTokens,
  or,
  sql,
  type AttentionDatabase,
  type AttentionTransaction,
} from "@attention/db";
import {
  CHANNEL_RUNTIME_RESOURCE,
  CHANNEL_RUNTIME_SCOPES,
} from "@attention/contracts";

import { resolveAccountCapabilities } from "./sessions";
import {
  isOAuthConnectionNameConflict,
  normalizeOAuthConnectionLabel,
  OAuthConnectionNameConflictError,
  resolveRuntimeOAuthConnectionIntent,
  type OAuthConnectionIntent,
} from "./oauth-connection";
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
const oauthLastUsedTouchIntervalMs = 5 * 60 * 1_000;
const maxOAuthConnectionSnapshotSize = 100;
const oauthConnectionIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function runtimeInstallationHmacSecret(): string {
  const secret = process.env.ATTENTION_HMAC_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error("ATTENTION_HMAC_SECRET must contain at least 32 characters");
  }
  return secret;
}

export function hashRuntimeInstallationId(installationId: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
      .test(installationId)
  ) {
    throw new Error("Runtime installation ID must be a canonical UUID");
  }
  return createHmac("sha256", runtimeInstallationHmacSecret())
    .update("attention:runtime-installation:v1\0")
    .update(installationId.toLocaleLowerCase("en-US"))
    .digest("hex");
}

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

export class OAuthRuntimeInstallationConflictError extends OAuthError {
  constructor() {
    super("invalid_grant");
    this.name = "OAuthRuntimeInstallationConflictError";
    this.message = "runtime_installation_authorization_conflict";
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
  intent: OAuthConnectionIntent,
  now = new Date(),
): Promise<string> {
  const normalized = normalizeOAuthConnectionLabel(intent.label);
  const connectionId = intent.mode === "rotate" ? intent.connectionId : null;
  const replacementConnectionId =
    intent.mode === "replace" ? intent.replacementConnectionId : null;
  const code = createOpaqueToken();
  await db.insert(oauthAuthorizationCodes).values({
    accountId,
    audience: request.audience,
    clientId: request.clientId,
    codeChallenge: request.codeChallenge,
    codeHash: await hashOpaqueToken(code),
    connectionId,
    connectionLabel: normalized.label,
    createdAt: now,
    expiresAt: new Date(now.getTime() + codeTtlMs),
    normalizedConnectionLabel: normalized.normalizedLabel,
    redirectUri: request.redirectUri,
    replacementConnectionId,
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
  connectionId: string;
  expiresIn: number;
  refreshToken: string;
  scope: string;
  tokenType: "Bearer";
}

async function issueTokenPair(
  db: AttentionTransaction,
  input: {
    accountId: string;
    audience: string;
    clientId: string;
    connectionId: string;
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
    connectionId: input.connectionId,
    createdAt: input.now,
    expiresAt: new Date(input.now.getTime() + accessTtlMs),
    scopes: input.scopes,
    tokenHash: await hashOpaqueToken(accessToken),
  });
  await db.insert(oauthRefreshTokens).values({
    accountId: input.accountId,
    audience: input.audience,
    clientId: input.clientId,
    connectionId: input.connectionId,
    createdAt: input.now,
    expiresAt: new Date(input.now.getTime() + refreshTtlMs),
    scopes: input.scopes,
    tokenHash: await hashOpaqueToken(refreshToken),
  });
  return {
    accessToken,
    connectionId: input.connectionId,
    expiresIn: Math.floor(accessTtlMs / 1_000),
    refreshToken,
    scope: input.scopes.join(" "),
    tokenType: "Bearer",
  };
}

async function revokeConnectionCredentials(
  db: AttentionTransaction,
  accountId: string,
  connectionIds: readonly string[],
  now: Date,
): Promise<void> {
  const accessConnectionCondition = connectionIds.length === 1
    ? eq(oauthAccessTokens.connectionId, connectionIds[0]!)
    : inArray(oauthAccessTokens.connectionId, [...connectionIds]);
  const refreshConnectionCondition = connectionIds.length === 1
    ? eq(oauthRefreshTokens.connectionId, connectionIds[0]!)
    : inArray(oauthRefreshTokens.connectionId, [...connectionIds]);
  await db
    .update(oauthAccessTokens)
    .set({ revokedAt: now, status: "revoked" })
    .where(
      and(
        eq(oauthAccessTokens.accountId, accountId),
        accessConnectionCondition,
        eq(oauthAccessTokens.status, "active"),
      ),
    );
  await db
    .update(oauthRefreshTokens)
    .set({ revokedAt: now, status: "revoked" })
    .where(
      and(
        eq(oauthRefreshTokens.accountId, accountId),
        refreshConnectionCondition,
        eq(oauthRefreshTokens.status, "active"),
      ),
    );
}

interface TrustedRuntimeClientMetadata {
  deviceName: string | null;
  installationKeyHash: string | null;
}

function importedOAuthConnectionIdentity(): {
  connectionId: string;
  label: string;
  normalizedLabel: string;
} {
  const connectionId = randomUUID();
  const normalized = normalizeOAuthConnectionLabel(
    `Imported connection ${connectionId}`,
  );
  return { connectionId, ...normalized };
}

async function materializeLegacyOAuthConnection(
  tx: AttentionTransaction,
  input: {
    accountId: string;
    audience: OAuthAudience;
    authorizedAt: Date;
    clientId: string;
    now: Date;
    reauthorize: boolean;
    trustedRuntimeClient: TrustedRuntimeClientMetadata | null;
  },
): Promise<string> {
  if (input.audience === CHANNEL_RUNTIME_RESOURCE) {
    const trusted = input.trustedRuntimeClient;
    if (
      !trusted?.deviceName ||
      !trusted.installationKeyHash ||
      !/^[0-9a-f]{64}$/u.test(trusted.installationKeyHash)
    ) {
      throw new OAuthError("invalid_grant");
    }
    let intent: OAuthConnectionIntent;
    try {
      intent = await resolveRuntimeOAuthConnectionIntent(tx, {
        accountId: input.accountId,
        audience: CHANNEL_RUNTIME_RESOURCE,
        clientId: input.clientId,
        label: trusted.deviceName,
      });
    } catch (error) {
      if (error instanceof OAuthConnectionNameConflictError) throw error;
      throw new OAuthError("invalid_grant");
    }
    const normalized = normalizeOAuthConnectionLabel(intent.label);
    if (intent.mode === "rotate") {
      const [existing] = await tx
        .select()
        .from(oauthConnections)
        .where(eq(oauthConnections.id, intent.connectionId))
        .for("update")
        .limit(1);
      if (
        !existing ||
        existing.revokedAt ||
        existing.accountId !== input.accountId ||
        existing.audience !== input.audience ||
        existing.kind !== "runtime" ||
        existing.installationKeyHash !== trusted.installationKeyHash
      ) {
        throw new OAuthError("invalid_grant");
      }
      if (input.reauthorize) {
        await revokeConnectionCredentials(
          tx,
          input.accountId,
          [existing.id],
          input.now,
        );
      }
      await tx
        .update(oauthConnections)
        .set({
          clientId: input.clientId,
          deviceName: trusted.deviceName,
          installationKeyHash: trusted.installationKeyHash,
          label: normalized.label,
          ...(input.reauthorize ? { lastAuthorizedAt: input.now } : {}),
          normalizedLabel: normalized.normalizedLabel,
          updatedAt: input.now,
        })
        .where(eq(oauthConnections.id, existing.id));
      return existing.id;
    }
    if (intent.mode === "replace") {
      throw new OAuthConnectionNameConflictError();
    }
    const connectionId = randomUUID();
    const [created] = await tx
      .insert(oauthConnections)
      .values({
        accountId: input.accountId,
        audience: input.audience,
        clientId: input.clientId,
        deviceName: trusted.deviceName,
        id: connectionId,
        installationKeyHash: trusted.installationKeyHash,
        kind: "runtime",
        label: normalized.label,
        lastAuthorizedAt: input.authorizedAt,
        normalizedLabel: normalized.normalizedLabel,
        updatedAt: input.now,
      })
      .returning({ id: oauthConnections.id });
    if (!created) throw new OAuthError("invalid_grant");
    return created.id;
  }

  const imported = importedOAuthConnectionIdentity();
  const [created] = await tx
    .insert(oauthConnections)
    .values({
      accountId: input.accountId,
      audience: input.audience,
      clientId: input.clientId,
      id: imported.connectionId,
      kind: "mcp",
      label: imported.label,
      lastAuthorizedAt: input.authorizedAt,
      normalizedLabel: imported.normalizedLabel,
      updatedAt: input.now,
    })
    .returning({ id: oauthConnections.id });
  if (!created) throw new OAuthError("invalid_grant");
  return created.id;
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
  let runtimeExchange = false;
  try {
    return await db.transaction(async (tx) => {
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
      runtimeExchange = code.audience === CHANNEL_RUNTIME_RESOURCE;
      const trustedRuntimeClient = runtimeExchange
        ? (await tx
            .select({
              deviceName: oauthClients.deviceName,
              installationKeyHash: oauthClients.installationKeyHash,
            })
            .from(oauthClients)
            .where(
              and(
                eq(oauthClients.clientId, code.clientId),
                eq(oauthClients.active, true),
                eq(oauthClients.connectionKind, "runtime"),
              ),
            )
            .limit(1))[0]
        : null;
      if (
        runtimeExchange &&
        (
          !trustedRuntimeClient?.deviceName ||
          !trustedRuntimeClient.installationKeyHash ||
          !/^[0-9a-f]{64}$/u.test(trustedRuntimeClient.installationKeyHash)
        )
      ) {
        throw new OAuthError("invalid_grant");
      }
      let connectionId: string;
      let legacyMaterialized = false;
      if (code.connectionId) {
        const [existing] = await tx
          .select()
          .from(oauthConnections)
          .where(eq(oauthConnections.id, code.connectionId))
          .for("update")
          .limit(1);
        if (
          !existing || existing.revokedAt ||
          existing.accountId !== code.accountId || existing.audience !== code.audience ||
          (runtimeExchange &&
            (existing.kind !== "runtime" ||
              existing.installationKeyHash !==
                trustedRuntimeClient?.installationKeyHash))
        ) {
          throw new OAuthError("invalid_grant");
        }
        let rotateLabel: ReturnType<typeof normalizeOAuthConnectionLabel> | null = null;
        if (code.connectionLabel || code.normalizedConnectionLabel) {
          if (!code.connectionLabel || !code.normalizedConnectionLabel) {
            throw new OAuthError("invalid_grant");
          }
          try {
            rotateLabel = normalizeOAuthConnectionLabel(code.connectionLabel);
          } catch {
            throw new OAuthError("invalid_grant");
          }
          if (rotateLabel.normalizedLabel !== code.normalizedConnectionLabel) {
            throw new OAuthError("invalid_grant");
          }
        }
        connectionId = existing.id;
        await revokeConnectionCredentials(tx, code.accountId, [connectionId], now);
        await tx
          .update(oauthConnections)
          .set({
            clientId: code.clientId,
            ...(trustedRuntimeClient
              ? {
                  deviceName: trustedRuntimeClient.deviceName,
                  installationKeyHash:
                    trustedRuntimeClient.installationKeyHash,
                  kind: "runtime" as const,
                }
              : {}),
            ...(rotateLabel
              ? {
                  label: rotateLabel.label,
                  normalizedLabel: rotateLabel.normalizedLabel,
                }
              : {}),
            lastAuthorizedAt: now,
            updatedAt: now,
          })
          .where(eq(oauthConnections.id, connectionId));
      } else if (
        !code.connectionLabel &&
        !code.normalizedConnectionLabel &&
        !code.replacementConnectionId
      ) {
        connectionId = await materializeLegacyOAuthConnection(tx, {
          accountId: code.accountId,
          audience: requestedResource.audience,
          authorizedAt: now,
          clientId: code.clientId,
          now,
          reauthorize: true,
          trustedRuntimeClient: trustedRuntimeClient ?? null,
        });
        legacyMaterialized = true;
      } else {
        if (!code.connectionLabel || !code.normalizedConnectionLabel) {
          throw new OAuthError("invalid_grant");
        }
        let normalized;
        try {
          normalized = normalizeOAuthConnectionLabel(code.connectionLabel);
        } catch {
          throw new OAuthError("invalid_grant");
        }
        if (normalized.normalizedLabel !== code.normalizedConnectionLabel) {
          throw new OAuthError("invalid_grant");
        }
        if (code.replacementConnectionId) {
          const [replacement] = await tx
            .select()
            .from(oauthConnections)
            .where(eq(oauthConnections.id, code.replacementConnectionId))
            .for("update")
            .limit(1);
          if (
            !replacement || replacement.revokedAt ||
            replacement.accountId !== code.accountId ||
            replacement.audience !== code.audience ||
            replacement.normalizedLabel !== code.normalizedConnectionLabel
          ) {
            throw new OAuthError("invalid_grant");
          }
          await tx
            .update(oauthConnections)
            .set({ revokedAt: now, updatedAt: now })
            .where(eq(oauthConnections.id, replacement.id));
          await revokeConnectionCredentials(tx, code.accountId, [replacement.id], now);
        }
        const [created] = await tx
          .insert(oauthConnections)
          .values({
            accountId: code.accountId,
            audience: code.audience,
            clientId: code.clientId,
            deviceName: trustedRuntimeClient?.deviceName ?? null,
            installationKeyHash:
              trustedRuntimeClient?.installationKeyHash ?? null,
            kind: code.audience === CHANNEL_RUNTIME_RESOURCE ? "runtime" : "mcp",
            label: code.connectionLabel,
            lastAuthorizedAt: now,
            normalizedLabel: code.normalizedConnectionLabel,
            updatedAt: now,
          })
          .returning({ id: oauthConnections.id });
        if (!created) throw new OAuthError("invalid_grant");
        connectionId = created.id;
      }
      await tx
        .update(oauthAuthorizationCodes)
        .set({
          ...(legacyMaterialized ? { connectionId } : {}),
          consumedAt: now,
        })
        .where(eq(oauthAuthorizationCodes.id, code.id));
      return issueTokenPair(tx, {
        accountId: code.accountId,
        audience: code.audience,
        clientId: code.clientId,
        connectionId,
        now,
        scopes: code.scopes,
      });
    });
  } catch (error) {
    if (
      runtimeExchange &&
      (error instanceof OAuthConnectionNameConflictError ||
        isOAuthConnectionNameConflict(error) ||
        isRuntimeInstallationConflict(error))
    ) {
      throw new OAuthRuntimeInstallationConflictError();
    }
    if (
      error instanceof OAuthConnectionNameConflictError ||
      isOAuthConnectionNameConflict(error)
    ) {
      throw new OAuthConnectionNameConflictError();
    }
    throw error;
  }
}

function isRuntimeInstallationConflict(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as {
      cause?: unknown;
      code?: unknown;
      constraint?: unknown;
      constraint_name?: unknown;
    };
    if (
      candidate.code === "23505" &&
      (candidate.constraint ===
        "oauth_connections_active_runtime_installation_unique" ||
        candidate.constraint_name ===
          "oauth_connections_active_runtime_installation_unique")
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
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
  let runtimeRefresh = false;
  try {
    return await db.transaction(async (tx) => {
      const [candidate] = await tx
        .select()
        .from(oauthRefreshTokens)
        .where(eq(oauthRefreshTokens.tokenHash, tokenHash))
        .limit(1);
      if (
        !candidate || candidate.clientId !== input.clientId ||
        candidate.status !== "active" || candidate.consumedAt ||
        candidate.revokedAt || candidate.expiresAt <= now
      ) throw new OAuthError("invalid_grant");
      if (candidate.audience !== requestedResource.audience) {
        throw new OAuthError("invalid_target");
      }
      runtimeRefresh = candidate.audience === CHANNEL_RUNTIME_RESOURCE;

      let connectionId = candidate.connectionId;
      if (connectionId) {
        const [connection] = await tx
          .select()
          .from(oauthConnections)
          .where(eq(oauthConnections.id, connectionId))
          .for("update")
          .limit(1);
        if (
          !connection || connection.revokedAt ||
          connection.accountId !== candidate.accountId ||
          connection.audience !== candidate.audience
        ) {
          throw new OAuthError("invalid_grant");
        }
      } else {
        const trustedRuntimeClient = runtimeRefresh
          ? (await tx
              .select({
                deviceName: oauthClients.deviceName,
                installationKeyHash: oauthClients.installationKeyHash,
              })
              .from(oauthClients)
              .where(
                and(
                  eq(oauthClients.clientId, candidate.clientId),
                  eq(oauthClients.active, true),
                  eq(oauthClients.connectionKind, "runtime"),
                ),
              )
              .limit(1))[0]
          : null;
        connectionId = await materializeLegacyOAuthConnection(tx, {
          accountId: candidate.accountId,
          audience: requestedResource.audience,
          authorizedAt: candidate.createdAt,
          clientId: candidate.clientId,
          now,
          reauthorize: false,
          trustedRuntimeClient: trustedRuntimeClient ?? null,
        });
      }

      const [token] = await tx
        .select()
        .from(oauthRefreshTokens)
        .where(eq(oauthRefreshTokens.id, candidate.id))
        .for("update")
        .limit(1);
      if (
        !token || token.connectionId !== candidate.connectionId ||
        token.clientId !== input.clientId || token.status !== "active" ||
        token.consumedAt || token.revokedAt || token.expiresAt <= now
      ) throw new OAuthError("invalid_grant");
      const requestedScopes = input.scope ? normalizeScopes(input.scope) : [...token.scopes].sort();
      const existingScopes = [...token.scopes].sort();
      if (requestedScopes.some((scope) => !existingScopes.includes(scope))) {
        throw new OAuthError("invalid_scope");
      }
      await tx
        .update(oauthRefreshTokens)
        .set({
          connectionId,
          consumedAt: now,
          revokedAt: now,
          status: "revoked",
        })
        .where(eq(oauthRefreshTokens.id, token.id));
      return issueTokenPair(tx, {
        accountId: token.accountId,
        audience: token.audience,
        clientId: token.clientId,
        connectionId,
        now,
        scopes: requestedScopes,
      });
    });
  } catch (error) {
    if (
      runtimeRefresh &&
      (error instanceof OAuthConnectionNameConflictError ||
        isOAuthConnectionNameConflict(error) ||
        isRuntimeInstallationConflict(error))
    ) {
      throw new OAuthRuntimeInstallationConflictError();
    }
    if (
      error instanceof OAuthConnectionNameConflictError ||
      isOAuthConnectionNameConflict(error)
    ) {
      throw new OAuthConnectionNameConflictError();
    }
    throw error;
  }
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
      connectionId: oauthAccessTokens.connectionId,
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
  const touchCutoff = new Date(now.getTime() - oauthLastUsedTouchIntervalMs);
  await Promise.all([
    db
      .update(oauthAccessTokens)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(oauthAccessTokens.id, token.id),
          or(
            isNull(oauthAccessTokens.lastUsedAt),
            lte(oauthAccessTokens.lastUsedAt, touchCutoff),
          ),
        ),
      ),
    token.connectionId
      ? db
          .update(oauthConnections)
          .set({ lastUsedAt: now, updatedAt: now })
          .where(
            and(
              eq(oauthConnections.id, token.connectionId),
              eq(oauthConnections.accountId, token.accountId),
              isNull(oauthConnections.revokedAt),
              or(
                isNull(oauthConnections.lastUsedAt),
                lte(oauthConnections.lastUsedAt, touchCutoff),
              ),
            ),
          )
      : Promise.resolve(),
  ]);
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

export class OAuthConnectionSnapshotConflictError extends Error {
  constructor() {
    super("oauth_connection_snapshot_stale");
    this.name = "OAuthConnectionSnapshotConflictError";
  }
}

function normalizeOAuthClientGroupKey(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("en-US");
  if (
    !normalized ||
    normalized.length > 100 ||
    /[\p{Cc}\p{Cf}]/u.test(normalized)
  ) {
    throw new RangeError("invalid_oauth_client_name");
  }
  return normalized;
}

function validateOAuthConnectionIdSnapshot(connectionIds: readonly string[]): Set<string> {
  const uniqueIds = new Set(connectionIds);
  if (
    connectionIds.length < 1 ||
    connectionIds.length > maxOAuthConnectionSnapshotSize ||
    uniqueIds.size !== connectionIds.length ||
    connectionIds.some((connectionId) => !oauthConnectionIdPattern.test(connectionId))
  ) {
    throw new RangeError("invalid_oauth_connection_snapshot");
  }
  return uniqueIds;
}

async function revokeLockedOAuthConnections(
  tx: AttentionTransaction,
  accountId: string,
  connectionIds: readonly string[],
  now: Date,
): Promise<void> {
  await tx
    .update(oauthConnections)
    .set({ revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(oauthConnections.accountId, accountId),
        inArray(oauthConnections.id, [...connectionIds]),
        isNull(oauthConnections.revokedAt),
      ),
    );
  await revokeConnectionCredentials(tx, accountId, connectionIds, now);
}

export async function revokeMcpOAuthConnectionSnapshot(
  db: AttentionDatabase,
  input: {
    accountId: string;
    clientName: string;
    connectionIds: readonly string[];
  },
  now = new Date(),
): Promise<number> {
  const normalizedClientName = normalizeOAuthClientGroupKey(input.clientName);
  const requestedIds = validateOAuthConnectionIdSnapshot(input.connectionIds);
  return db.transaction(async (tx) => {
    const requestedRows = await tx
      .select({
        accountId: oauthConnections.accountId,
        audience: oauthConnections.audience,
        clientName: oauthClients.name,
        id: oauthConnections.id,
        kind: oauthConnections.kind,
        revokedAt: oauthConnections.revokedAt,
      })
      .from(oauthConnections)
      .innerJoin(oauthClients, eq(oauthClients.clientId, oauthConnections.clientId))
      .where(inArray(oauthConnections.id, [...requestedIds]))
      .for("update");
    if (
      requestedRows.length !== requestedIds.size ||
      requestedRows.some((row) =>
        !requestedIds.has(row.id) ||
        row.accountId !== input.accountId ||
        row.audience !== "attention-mcp" ||
        row.kind !== "mcp" ||
        row.revokedAt !== null ||
        normalizeOAuthClientGroupKey(row.clientName) !== normalizedClientName
      )
    ) {
      throw new OAuthConnectionSnapshotConflictError();
    }
    const activeGroupRows = await tx
      .select({
        accountId: oauthConnections.accountId,
        audience: oauthConnections.audience,
        clientName: oauthClients.name,
        id: oauthConnections.id,
        kind: oauthConnections.kind,
        revokedAt: oauthConnections.revokedAt,
      })
      .from(oauthConnections)
      .innerJoin(oauthClients, eq(oauthClients.clientId, oauthConnections.clientId))
      .where(
        and(
          eq(oauthConnections.accountId, input.accountId),
          eq(oauthConnections.audience, "attention-mcp"),
          eq(oauthConnections.kind, "mcp"),
          isNull(oauthConnections.revokedAt),
        ),
      )
      .for("update");
    const activeMatchingIds = new Set(
      activeGroupRows
        .filter((row) =>
          row.accountId === input.accountId &&
          row.audience === "attention-mcp" &&
          row.kind === "mcp" &&
          row.revokedAt === null &&
          normalizeOAuthClientGroupKey(row.clientName) === normalizedClientName
        )
        .map((row) => row.id),
    );
    if (
      activeMatchingIds.size !== requestedIds.size ||
      [...requestedIds].some((connectionId) => !activeMatchingIds.has(connectionId))
    ) {
      throw new OAuthConnectionSnapshotConflictError();
    }
    await revokeLockedOAuthConnections(
      tx,
      input.accountId,
      input.connectionIds,
      now,
    );
    return input.connectionIds.length;
  });
}

export async function revokeOAuthConnection(
  db: AttentionDatabase,
  accountId: string,
  connectionId: string,
  now = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    const [connection] = await tx
      .select({ id: oauthConnections.id })
      .from(oauthConnections)
      .where(
        and(
          eq(oauthConnections.id, connectionId),
          eq(oauthConnections.accountId, accountId),
          isNull(oauthConnections.revokedAt),
        ),
      )
      .for("update")
      .limit(1);
    if (!connection) return;
    await revokeLockedOAuthConnections(tx, accountId, [connection.id], now);
  });
}

export async function revokeRuntimeOAuthInstallation(
  db: AttentionDatabase,
  input: {
    accountId: string;
    clientId: string;
    installationId: string;
  },
  now = new Date(),
): Promise<boolean> {
  const installationKeyHash = hashRuntimeInstallationId(input.installationId);
  return db.transaction(async (tx) => {
    const [connection] = await tx
      .select({ id: oauthConnections.id })
      .from(oauthConnections)
      .where(
        and(
          eq(oauthConnections.accountId, input.accountId),
          eq(oauthConnections.audience, CHANNEL_RUNTIME_RESOURCE),
          eq(oauthConnections.kind, "runtime"),
          eq(oauthConnections.installationKeyHash, installationKeyHash),
          isNull(oauthConnections.revokedAt),
        ),
      )
      .for("update")
      .limit(1);
    if (connection) {
      await revokeLockedOAuthConnections(
        tx,
        input.accountId,
        [connection.id],
        now,
      );
    }

    // Rolling compatibility: credentials issued before logical connection
    // links existed can only be scoped to their exact legacy Runtime client.
    await tx
      .update(oauthAccessTokens)
      .set({ revokedAt: now, status: "revoked" })
      .where(
        and(
          eq(oauthAccessTokens.accountId, input.accountId),
          eq(oauthAccessTokens.audience, CHANNEL_RUNTIME_RESOURCE),
          eq(oauthAccessTokens.clientId, input.clientId),
          isNull(oauthAccessTokens.connectionId),
          eq(oauthAccessTokens.status, "active"),
        ),
      );
    await tx
      .update(oauthRefreshTokens)
      .set({ revokedAt: now, status: "revoked" })
      .where(
        and(
          eq(oauthRefreshTokens.accountId, input.accountId),
          eq(oauthRefreshTokens.audience, CHANNEL_RUNTIME_RESOURCE),
          eq(oauthRefreshTokens.clientId, input.clientId),
          isNull(oauthRefreshTokens.connectionId),
          eq(oauthRefreshTokens.status, "active"),
        ),
      );
    return Boolean(connection);
  });
}

/**
 * Retained for internal runtime shutdown flows that intentionally revoke every
 * credential issued to one registered client. User-facing settings must revoke
 * by logical connection ID through revokeOAuthConnection instead.
 */
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
    runtimeIdentity?: {
      deviceName: string;
      installationKeyHash: string;
    };
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
  if (
    input.runtimeIdentity &&
    (
      !input.runtimeIdentity.deviceName ||
      input.runtimeIdentity.deviceName.length > 80 ||
      /[\p{Cc}\p{Cf}]/u.test(input.runtimeIdentity.deviceName) ||
      input.runtimeIdentity.deviceName !==
        input.runtimeIdentity.deviceName.normalize("NFKC").trim() ||
      !/^[0-9a-f]{64}$/u.test(input.runtimeIdentity.installationKeyHash)
    )
  ) {
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
      ...(input.runtimeIdentity
        ? {
            connectionKind: "runtime" as const,
            deviceName: input.runtimeIdentity.deviceName,
            installationKeyHash: input.runtimeIdentity.installationKeyHash,
          }
        : {}),
      name,
      registrationFingerprint: input.requesterFingerprint,
      redirectUris,
    });
    return { allowedScopes, clientId };
  });
}
