import "server-only";

import {
  accounts,
  and,
  apiCredentials,
  channelIdentities,
  desc,
  eq,
  gt,
  isNull,
  oauthClients,
  oauthRefreshTokens,
  type AttentionDatabase,
} from "@attention/db";

export interface AccountOverview {
  displayName: string;
  email: string | null;
  hasPassword: boolean;
  stableHandle: string;
}

export async function loadAccountOverview(
  db: AttentionDatabase,
  accountId: string,
): Promise<AccountOverview | null> {
  const [row] = await db
    .select({
      displayName: accounts.displayName,
      email: accounts.primaryEmail,
      passwordHash: accounts.passwordHash,
      stableHandle: accounts.stableHandle,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  return row
    ? {
        displayName: row.displayName,
        email: row.email,
        hasPassword: row.passwordHash !== null,
        stableHandle: row.stableHandle,
      }
    : null;
}

export async function updateDisplayName(
  db: AttentionDatabase,
  accountId: string,
  value: string,
): Promise<string> {
  const displayName = value.normalize("NFKC").trim();
  const hasControlCharacter = Array.from(displayName).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
  if (
    displayName.length < 1 ||
    displayName.length > 50 ||
    hasControlCharacter
  ) {
    throw new RangeError("invalid_display_name");
  }
  const [updated] = await db
    .update(accounts)
    .set({ displayName, updatedAt: new Date() })
    .where(eq(accounts.id, accountId))
    .returning({ displayName: accounts.displayName });
  if (!updated) throw new Error("account_not_found");
  return updated.displayName;
}

export async function loadConnectionOverview(db: AttentionDatabase, accountId: string) {
  const [oauth, pats, channels] = await Promise.all([
    db
      .select({
        clientId: oauthRefreshTokens.clientId,
        clientName: oauthClients.name,
        createdAt: oauthRefreshTokens.createdAt,
        expiresAt: oauthRefreshTokens.expiresAt,
        id: oauthRefreshTokens.id,
        scopes: oauthRefreshTokens.scopes,
      })
      .from(oauthRefreshTokens)
      .innerJoin(oauthClients, eq(oauthClients.clientId, oauthRefreshTokens.clientId))
      .where(
        and(
          eq(oauthRefreshTokens.accountId, accountId),
          eq(oauthRefreshTokens.status, "active"),
          isNull(oauthRefreshTokens.revokedAt),
          gt(oauthRefreshTokens.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(oauthRefreshTokens.createdAt)),
    db
      .select({
        createdAt: apiCredentials.createdAt,
        expiresAt: apiCredentials.expiresAt,
        id: apiCredentials.id,
        keyPrefix: apiCredentials.keyPrefix,
        lastUsedAt: apiCredentials.lastUsedAt,
        name: apiCredentials.name,
        scopes: apiCredentials.scopes,
        status: apiCredentials.status,
      })
      .from(apiCredentials)
      .where(eq(apiCredentials.accountId, accountId))
      .orderBy(desc(apiCredentials.createdAt)),
    db
      .select({
        appId: channelIdentities.appId,
        boundAt: channelIdentities.boundAt,
        id: channelIdentities.id,
        provider: channelIdentities.provider,
        revokedAt: channelIdentities.revokedAt,
      })
      .from(channelIdentities)
      .where(eq(channelIdentities.accountId, accountId))
      .orderBy(desc(channelIdentities.boundAt)),
  ]);
  return { channels, oauth, pats };
}
