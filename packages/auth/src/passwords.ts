import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

import {
  accounts,
  and,
  eq,
  gte,
  passwordLoginAttempts,
  sessions,
  sql,
  type AttentionDatabase,
} from "@attention/db";

import { normalizeEmail, safeReturnTo } from "./email-auth";
import { type IssuedSession, defaultSessionTtlSeconds } from "./sessions";
import { createOpaqueToken, hashOpaqueToken } from "./tokens";

const keyLength = 64;
const scryptN = 32_768;
const scryptR = 8;
const scryptP = 1;
const dummyPasswordHash =
  "scrypt$32768$8$1$MDAwMDAwMDAwMDAwMDAwMA$ekTuJIhtwFxBV7QLlYXdxxHZlIRpQjoLnaDwV4U3Xh6EzmUNcjGnmcNN7KDgXxqwRtqXoMoRFxgHb0vVGl4gKg";

function derivePasswordKey(
  password: string,
  salt: Buffer,
  options: { N: number; p: number; r: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      keyLength,
      { ...options, maxmem: 64 * 1024 * 1024 },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}

export type PasswordAuthErrorCode =
  | "account_unavailable"
  | "invalid_credentials"
  | "invalid_password"
  | "password_not_configured"
  | "rate_limited"
  | "recent_authentication_required";

export class PasswordAuthError extends Error {
  readonly code: PasswordAuthErrorCode;

  constructor(code: PasswordAuthErrorCode) {
    super(code);
    this.name = "PasswordAuthError";
    this.code = code;
  }
}

export function validatePassword(value: string): string {
  const hasControlCharacter = Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
  if (value.length < 10 || value.length > 128 || hasControlCharacter) {
    throw new PasswordAuthError("invalid_password");
  }
  return value;
}

export async function hashPassword(value: string): Promise<string> {
  const password = validatePassword(value);
  const salt = randomBytes(16);
  const derived = await derivePasswordKey(password, salt, {
    N: scryptN,
    p: scryptP,
    r: scryptR,
  });
  return [
    "scrypt",
    scryptN,
    scryptR,
    scryptP,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(value: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nValue, rValue, pValue, saltValue, hashValue] = parts;
  const n = Number(nValue);
  const r = Number(rValue);
  const p = Number(pValue);
  if (n !== scryptN || r !== scryptR || p !== scryptP || !saltValue || !hashValue) {
    return false;
  }
  let expected: Buffer;
  let salt: Buffer;
  try {
    expected = Buffer.from(hashValue, "base64url");
    salt = Buffer.from(saltValue, "base64url");
  } catch {
    return false;
  }
  if (expected.length !== keyLength || salt.length !== 16) return false;
  const actual = await derivePasswordKey(value, salt, {
    N: n,
    p,
    r,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function loginWithPassword(
  db: AttentionDatabase,
  input: {
    email: string;
    password: string;
    requesterFingerprint?: string;
    returnTo?: string;
    now?: Date;
    sessionTtlSeconds?: number;
  },
): Promise<{
  accountId: string;
  displayName: string;
  returnTo: string;
  session: IssuedSession;
}> {
  const now = input.now ?? new Date();
  const email = normalizeEmail(input.email);
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1_000);
  const attemptId = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`password-login-email:${email}`}, 0))`,
    );
    if (input.requesterFingerprint) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`password-login-source:${input.requesterFingerprint}`}, 0))`,
      );
    }
    const [recentEmailFailures, recentFingerprintFailures] = await Promise.all([
      tx
        .select({ id: passwordLoginAttempts.id })
        .from(passwordLoginAttempts)
        .where(
          and(
            eq(passwordLoginAttempts.email, email),
            eq(passwordLoginAttempts.success, false),
            gte(passwordLoginAttempts.createdAt, hourAgo),
          ),
        )
        .limit(10),
      input.requesterFingerprint
        ? tx
            .select({ id: passwordLoginAttempts.id })
            .from(passwordLoginAttempts)
            .where(
              and(
                eq(passwordLoginAttempts.requesterFingerprint, input.requesterFingerprint),
                eq(passwordLoginAttempts.success, false),
                gte(passwordLoginAttempts.createdAt, hourAgo),
              ),
            )
            .limit(30)
        : Promise.resolve([]),
    ]);
    if (recentEmailFailures.length >= 10 || recentFingerprintFailures.length >= 30) {
      throw new PasswordAuthError("rate_limited");
    }
    const [attempt] = await tx
      .insert(passwordLoginAttempts)
      .values({
        createdAt: now,
        email,
        requesterFingerprint: input.requesterFingerprint,
        success: false,
      })
      .returning({ id: passwordLoginAttempts.id });
    if (!attempt) throw new Error("Failed to reserve password login attempt");
    return attempt.id;
  });
  const [account] = await db
    .select({
      displayName: accounts.displayName,
      id: accounts.id,
      passwordHash: accounts.passwordHash,
      status: accounts.status,
    })
    .from(accounts)
    .where(eq(accounts.primaryEmail, email))
    .limit(1);

  const passwordMatches = await verifyPassword(
    input.password,
    account?.passwordHash ?? dummyPasswordHash,
  );
  const validCredential = Boolean(account?.passwordHash) && passwordMatches;
  if (!account || !validCredential) {
    throw new PasswordAuthError("invalid_credentials");
  }
  if (account.status !== "active") throw new PasswordAuthError("account_unavailable");

  const ttlSeconds = input.sessionTtlSeconds ?? defaultSessionTtlSeconds;
  const token = createOpaqueToken();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1_000);
  const [session] = await db.transaction(async (tx) => {
    await tx
      .update(passwordLoginAttempts)
      .set({ success: true })
      .where(eq(passwordLoginAttempts.id, attemptId));
    return tx
      .insert(sessions)
      .values({
        accountId: account.id,
        createdAt: now,
        expiresAt,
        lastSeenAt: now,
        tokenHash: await hashOpaqueToken(token),
      })
      .returning({ id: sessions.id });
  });
  if (!session) throw new Error("Failed to issue password session");

  return {
    accountId: account.id,
    displayName: account.displayName,
    returnTo: safeReturnTo(input.returnTo),
    session: { accountId: account.id, expiresAt, sessionId: session.id, token },
  };
}

export async function setPassword(
  db: AttentionDatabase,
  input: {
    accountId: string;
    authenticatedAt: Date;
    now?: Date;
    password: string;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  if (now.getTime() - input.authenticatedAt.getTime() > 30 * 60 * 1_000) {
    throw new PasswordAuthError("recent_authentication_required");
  }
  const passwordHash = await hashPassword(input.password);
  const [updated] = await db
    .update(accounts)
    .set({ passwordHash, updatedAt: now })
    .where(and(eq(accounts.id, input.accountId), eq(accounts.status, "active")))
    .returning({ id: accounts.id });
  if (!updated) throw new PasswordAuthError("account_unavailable");
}
