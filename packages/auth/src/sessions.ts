import {
  accounts,
  and,
  type AttentionDatabase,
  eq,
  entitlements,
  filterProfiles,
  gt,
  isNull,
  lte,
  or,
  sessions
} from "@attention/db";

import { createOpaqueToken, hashOpaqueToken } from "./tokens";

export const defaultSessionTtlSeconds = 30 * 24 * 60 * 60;

export interface SessionPrincipal {
  sessionId: string;
  accountId: string;
  stableHandle: string;
  expiresAt: Date;
  isMember: boolean;
  isFilter: boolean;
}

export interface IssuedSession {
  token: string;
  sessionId: string;
  accountId: string;
  expiresAt: Date;
}

export async function issueSession(
  db: AttentionDatabase,
  input: { accountId: string; now?: Date; ttlSeconds?: number }
): Promise<IssuedSession> {
  const now = input.now ?? new Date();
  const ttlSeconds = input.ttlSeconds ?? defaultSessionTtlSeconds;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new RangeError("ttlSeconds must be a positive integer");
  }

  const [account] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.id, input.accountId), eq(accounts.status, "active")))
    .limit(1);
  if (!account) {
    throw new Error("account_not_active");
  }

  const token = createOpaqueToken();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1_000);
  const [session] = await db
    .insert(sessions)
    .values({
      accountId: input.accountId,
      tokenHash: await hashOpaqueToken(token),
      createdAt: now,
      lastSeenAt: now,
      expiresAt
    })
    .returning({ id: sessions.id });
  if (!session) {
    throw new Error("Failed to issue session");
  }

  return { token, sessionId: session.id, accountId: input.accountId, expiresAt };
}

export async function resolveSession(
  db: AttentionDatabase,
  token: string,
  options: { now?: Date; touch?: boolean } = {}
): Promise<SessionPrincipal | null> {
  let tokenHash: string;
  try {
    tokenHash = await hashOpaqueToken(token);
  } catch {
    return null;
  }

  const now = options.now ?? new Date();
  const [row] = await db
    .select({
      sessionId: sessions.id,
      accountId: accounts.id,
      stableHandle: accounts.stableHandle,
      expiresAt: sessions.expiresAt
    })
    .from(sessions)
    .innerJoin(accounts, eq(accounts.id, sessions.accountId))
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
        eq(accounts.status, "active")
      )
    )
    .limit(1);
  if (!row) {
    return null;
  }

  const [filter] = await db
    .select({ accountId: filterProfiles.accountId })
    .from(filterProfiles)
    .where(
      and(
        eq(filterProfiles.accountId, row.accountId),
        eq(filterProfiles.active, true),
        isNull(filterProfiles.revokedAt)
      )
    )
    .limit(1);

  const [member] = await db
    .select({ id: entitlements.id })
    .from(entitlements)
    .where(
      and(
        eq(entitlements.accountId, row.accountId),
        eq(entitlements.memberEnabled, true),
        lte(entitlements.startsAt, now),
        or(isNull(entitlements.endsAt), gt(entitlements.endsAt, now))
      )
    )
    .limit(1);

  if (options.touch ?? true) {
    await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.sessionId));
  }

  const isFilter = Boolean(filter);
  return {
    ...row,
    isFilter,
    isMember: isFilter || Boolean(member)
  };
}

export async function revokeSession(
  db: AttentionDatabase,
  token: string,
  now = new Date()
): Promise<boolean> {
  let tokenHash: string;
  try {
    tokenHash = await hashOpaqueToken(token);
  } catch {
    return false;
  }

  const rows = await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return rows.length > 0;
}

export async function revokeAllSessions(
  db: AttentionDatabase,
  accountId: string,
  now = new Date()
): Promise<number> {
  const rows = await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.accountId, accountId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return rows.length;
}
