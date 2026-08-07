import { createHash, randomBytes } from "node:crypto";

import {
  accounts,
  and,
  apiCredentials,
  eq,
  gt,
  isNull,
  or,
  type AttentionDatabase,
} from "@attention/db";

import { oauthDefaultClientScopes, type OAuthScope } from "./oauth";
import { resolveAccountCapabilities } from "./sessions";

const patPattern = /^att_pat_([A-Za-z0-9_-]{32,256})$/u;

/**
 * API Keys authenticate an Attention account; they are not a second
 * authorization system. Every active key receives the same protocol-level
 * scopes, while the account's live Free/Member/Filter capabilities decide
 * which operations are actually available on every request.
 */
export const apiKeyScopes: readonly OAuthScope[] = oauthDefaultClientScopes;
const apiKeyScopeSet = new Set<string>(apiKeyScopes);

function hashPat(value: string): string {
  return createHash("sha256").update("attention:pat:v1\0").update(value).digest("hex");
}

export interface CreatedApiCredential {
  credentialId: string;
  expiresAt: Date | null;
  key: string;
  keyPrefix: string;
  name: string;
}

export async function createApiCredential(
  db: AttentionDatabase,
  input: {
    accountId: string;
    expiresAt?: Date | null;
    name: string;
  },
): Promise<CreatedApiCredential> {
  const name = input.name.normalize("NFKC").trim();
  if (
    name.length < 1 || name.length > 100 ||
    (input.expiresAt && input.expiresAt <= new Date())
  ) throw new RangeError("invalid_api_credential");
  const key = `att_pat_${randomBytes(32).toString("base64url")}`;
  const keyPrefix = key.slice(0, 20);
  const [created] = await db
    .insert(apiCredentials)
    .values({
      accountId: input.accountId,
      expiresAt: input.expiresAt ?? null,
      keyHash: hashPat(key),
      keyPrefix,
      name,
      scopes: [...apiKeyScopes],
    })
    .returning({ id: apiCredentials.id });
  if (!created) throw new Error("api_credential_creation_failed");
  return {
    credentialId: created.id,
    expiresAt: input.expiresAt ?? null,
    key,
    keyPrefix,
    name,
  };
}

export interface ApiCredentialPrincipal {
  accountId: string;
  credentialId: string;
  isFilter: boolean;
  isMember: boolean;
  scopes: string[];
}

export async function resolveApiCredential(
  db: AttentionDatabase,
  key: string,
  now = new Date(),
): Promise<ApiCredentialPrincipal | null> {
  if (!patPattern.test(key)) return null;
  const [credential] = await db
    .select({
      accountId: apiCredentials.accountId,
      id: apiCredentials.id,
      scopes: apiCredentials.scopes,
    })
    .from(apiCredentials)
    .innerJoin(accounts, eq(accounts.id, apiCredentials.accountId))
    .where(
      and(
        eq(apiCredentials.keyHash, hashPat(key)),
        eq(apiCredentials.status, "active"),
        isNull(apiCredentials.revokedAt),
        or(isNull(apiCredentials.expiresAt), gt(apiCredentials.expiresAt, now)),
        eq(accounts.status, "active"),
      ),
    )
    .limit(1);
  if (!credential) return null;
  const capabilities = await resolveAccountCapabilities(db, credential.accountId, now);
  await db.update(apiCredentials).set({ lastUsedAt: now }).where(eq(apiCredentials.id, credential.id));
  return {
    accountId: credential.accountId,
    credentialId: credential.id,
    // New keys store the full protocol scope set. Keys created by the former
    // client-selected model retain their narrower stored scope as a security
    // ceiling until the user rotates them. Live account capabilities are still
    // evaluated on every request.
    scopes: credential.scopes.filter((scope) => apiKeyScopeSet.has(scope)),
    ...capabilities,
  };
}

export async function revokeApiCredential(
  db: AttentionDatabase,
  accountId: string,
  credentialId: string,
  now = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(apiCredentials)
    .set({ revokedAt: now, status: "revoked" })
    .where(
      and(
        eq(apiCredentials.id, credentialId),
        eq(apiCredentials.accountId, accountId),
        eq(apiCredentials.status, "active"),
      ),
    )
    .returning({ id: apiCredentials.id });
  return rows.length > 0;
}
