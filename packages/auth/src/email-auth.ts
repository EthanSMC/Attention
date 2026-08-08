import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";

import {
  accounts,
  and,
  desc,
  entitlements,
  eq,
  gte,
  isNull,
  loginChallenges,
  sessions,
  sql,
  type AttentionDatabase,
} from "@attention/db";

import { type IssuedSession, defaultSessionTtlSeconds } from "./sessions";
import {
  GrowthError,
  prepareConsumerReferralIntent,
  redeemConsumerReferralRegistration,
} from "./growth";
import { createOpaqueToken, hashOpaqueToken } from "./tokens";

export const currentTermsVersion = "2026-08-04";
export const currentPrivacyVersion = "2026-08-04";

const defaultChallengeTtlSeconds = 10 * 60;
const defaultResendCooldownSeconds = 60;
const defaultEmailHourlyLimit = 5;
const defaultFingerprintHourlyLimit = 20;
const defaultMaxAttempts = 5;

export type EmailAuthErrorCode =
  | "account_unavailable"
  | "challenge_consumed"
  | "challenge_expired"
  | "challenge_locked"
  | "consent_required"
  | "invalid_challenge"
  | "invalid_code"
  | "invalid_email"
  | "referral_registration_unavailable"
  | "rate_limited";

export class EmailAuthError extends Error {
  readonly code: EmailAuthErrorCode;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: EmailAuthErrorCode, options: { retryAfterSeconds?: number } = {}) {
    super(code);
    this.name = "EmailAuthError";
    this.code = code;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export interface CreatedLoginChallenge {
  challengeId: string;
  code: string;
  email: string;
  expiresAt: Date;
  retryAfterSeconds: number;
}

export interface VerifiedEmailLogin {
  accountCreated: boolean;
  accountId: string;
  displayName: string;
  email: string;
  returnTo: string;
  session: IssuedSession;
}

function authSecret(): string {
  const secret =
    process.env.ATTENTION_AUTH_SECRET?.trim() ?? process.env.ATTENTION_HMAC_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error("ATTENTION_AUTH_SECRET must contain at least 32 characters");
  }
  return secret;
}

export function normalizeEmail(value: string): string {
  const email = value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  const hasControlCharacter = Array.from(email).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
  if (
    email.length < 3 ||
    email.length > 320 ||
    /\s/u.test(email) ||
    hasControlCharacter ||
    !/^[^@]+@[^@]+\.[^@]+$/u.test(email)
  ) {
    throw new EmailAuthError("invalid_email");
  }
  return email;
}

export function safeReturnTo(value: string | null | undefined): string {
  if (!value) return "/ai";
  try {
    const url = new URL(value, "https://attention.invalid");
    if (url.origin !== "https://attention.invalid" || !url.pathname.startsWith("/")) {
      return "/ai";
    }
    if (url.pathname.startsWith("//")) return "/ai";
    return `${url.pathname}${url.search}`;
  } catch {
    return "/ai";
  }
}

function challengeHash(challengeId: string, email: string, code: string): string {
  return createHmac("sha256", authSecret())
    .update("attention:email-code:v1\0")
    .update(challengeId)
    .update("\0")
    .update(email)
    .update("\0")
    .update(code)
    .digest("hex");
}

function hashesEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function randomHandle(): { displayName: string; stableHandle: string } {
  const suffix = randomInt(100_000_000, 1_000_000_000).toString();
  return { displayName: `用户${suffix}`, stableHandle: `user-${suffix}` };
}

async function createAccount(
  db: Parameters<Parameters<AttentionDatabase["transaction"]>[0]>[0],
  email: string,
  now: Date,
  signupSource: "consumer_referral" | "direct",
): Promise<{ id: string; displayName: string }> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const identity = randomHandle();
    const [account] = await db
      .insert(accounts)
      .values({
        createdAt: now,
        displayName: identity.displayName,
        emailVerifiedAt: now,
        primaryEmail: email,
        privacyVersion: currentPrivacyVersion,
        signupSource,
        stableHandle: identity.stableHandle,
        status: "active",
        termsAcceptedAt: now,
        termsVersion: currentTermsVersion,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: accounts.stableHandle })
      .returning({
        displayName: accounts.displayName,
        id: accounts.id,
      });
    if (account) {
      await db.insert(entitlements).values({
        accountId: account.id,
        createdAt: now,
        endsAt: null,
        memberEnabled: true,
        source: "signup",
        startsAt: now,
        updatedAt: now,
      });
      return account;
    }
  }
  throw new Error("Unable to allocate a unique account handle");
}

export async function createLoginChallenge(
  db: AttentionDatabase,
  input: {
    email: string;
    requesterFingerprint?: string;
    returnTo?: string;
    consumerInviteToken?: string;
    now?: Date;
    ttlSeconds?: number;
  },
): Promise<CreatedLoginChallenge> {
  const now = input.now ?? new Date();
  const email = normalizeEmail(input.email);
  const ttlSeconds = input.ttlSeconds ?? defaultChallengeTtlSeconds;
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1_000);

  const challengeId = randomUUID();
  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1_000);
  let consumerReferralId: string | undefined;
  if (input.consumerInviteToken) {
    try {
      consumerReferralId = await prepareConsumerReferralIntent(db, {
        email,
        now,
        ...(input.requesterFingerprint
          ? { requesterFingerprint: input.requesterFingerprint }
          : {}),
        token: input.consumerInviteToken,
      });
    } catch (error) {
      if (error instanceof GrowthError) {
        if (error.code === "rate_limited") {
          throw new EmailAuthError("rate_limited", { retryAfterSeconds: 60 * 60 });
        }
        throw new EmailAuthError("referral_registration_unavailable");
      }
      throw error;
    }
  }
  await db.transaction(async (tx) => {
    // Serialize the complete count-to-insert decision. Locks are always taken
    // in email-then-source order so parallel starts cannot overrun either
    // quota while still avoiding cross-key deadlocks.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`email-login-challenge:${email}`}, 0))`,
    );
    if (input.requesterFingerprint) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`email-login-source:${input.requesterFingerprint}`}, 0))`,
      );
    }

    const recentForEmail = await tx
      .select({ createdAt: loginChallenges.createdAt })
      .from(loginChallenges)
      .where(and(eq(loginChallenges.email, email), gte(loginChallenges.createdAt, hourAgo)))
      .orderBy(desc(loginChallenges.createdAt));
    const newest = recentForEmail[0];
    if (newest) {
      const elapsedSeconds = Math.floor((now.getTime() - newest.createdAt.getTime()) / 1_000);
      if (elapsedSeconds < defaultResendCooldownSeconds) {
        throw new EmailAuthError("rate_limited", {
          retryAfterSeconds: defaultResendCooldownSeconds - elapsedSeconds,
        });
      }
    }
    if (recentForEmail.length >= defaultEmailHourlyLimit) {
      throw new EmailAuthError("rate_limited", { retryAfterSeconds: 60 * 60 });
    }

    if (input.requesterFingerprint) {
      const recentForFingerprint = await tx
        .select({ id: loginChallenges.id })
        .from(loginChallenges)
        .where(
          and(
            eq(loginChallenges.requesterFingerprint, input.requesterFingerprint),
            gte(loginChallenges.createdAt, hourAgo),
          ),
        );
      if (recentForFingerprint.length >= defaultFingerprintHourlyLimit) {
        throw new EmailAuthError("rate_limited", { retryAfterSeconds: 60 * 60 });
      }
    }

    await tx
      .update(loginChallenges)
      .set({ consumedAt: now })
      .where(and(eq(loginChallenges.email, email), isNull(loginChallenges.consumedAt)));
    await tx.insert(loginChallenges).values({
      codeHash: challengeHash(challengeId, email, code),
      consumerReferralId,
      createdAt: now,
      email,
      expiresAt,
      id: challengeId,
      maxAttempts: defaultMaxAttempts,
      requesterFingerprint: input.requesterFingerprint,
      returnTo: safeReturnTo(input.returnTo),
    });
  });

  return {
    challengeId,
    code,
    email,
    expiresAt,
    retryAfterSeconds: defaultResendCooldownSeconds,
  };
}

export async function verifyLoginChallenge(
  db: AttentionDatabase,
  input: {
    acceptTerms: boolean;
    challengeId: string;
    code: string;
    expectedEmail?: string;
    now?: Date;
    sessionTtlSeconds?: number;
  },
): Promise<VerifiedEmailLogin> {
  const now = input.now ?? new Date();
  const ttlSeconds = input.sessionTtlSeconds ?? defaultSessionTtlSeconds;

  const result = await db.transaction(async (tx) => {
    const [challenge] = await tx
      .select()
      .from(loginChallenges)
      .where(eq(loginChallenges.id, input.challengeId))
      .for("update")
      .limit(1);
    if (!challenge) return { error: "invalid_challenge" as const };
    if (input.expectedEmail && challenge.email !== input.expectedEmail) {
      return { error: "invalid_challenge" as const };
    }
    if (challenge.consumedAt) return { error: "challenge_consumed" as const };
    if (challenge.expiresAt <= now) return { error: "challenge_expired" as const };
    if (challenge.failedAttempts >= challenge.maxAttempts) {
      return { error: "challenge_locked" as const };
    }

    const submittedHash = challengeHash(challenge.id, challenge.email, input.code);
    if (!hashesEqual(submittedHash, challenge.codeHash)) {
      const nextFailures = challenge.failedAttempts + 1;
      await tx
        .update(loginChallenges)
        .set({ failedAttempts: nextFailures })
        .where(eq(loginChallenges.id, challenge.id));
      return {
        error: nextFailures >= challenge.maxAttempts ? ("challenge_locked" as const) : ("invalid_code" as const),
      };
    }

    // There may be multiple valid challenges for the same email across devices.
    // Serialize account resolution so concurrent first verification creates one account.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${challenge.email}, 0))`,
    );

    let [account] = await tx
      .select({
        displayName: accounts.displayName,
        id: accounts.id,
        status: accounts.status,
      })
      .from(accounts)
      .where(eq(accounts.primaryEmail, challenge.email))
      .for("update")
      .limit(1);
    let accountCreated = false;
    if (account && challenge.consumerReferralId) {
      return { error: "referral_registration_unavailable" as const };
    }
    if (!account) {
      if (!input.acceptTerms) return { error: "consent_required" as const };
      account = {
        ...(await createAccount(
          tx,
          challenge.email,
          now,
          challenge.consumerReferralId ? "consumer_referral" : "direct",
        )),
        status: "active" as const,
      };
      accountCreated = true;
      if (challenge.consumerReferralId) {
        await redeemConsumerReferralRegistration(tx, {
          inviteeAccountId: account.id,
          now,
          referralId: challenge.consumerReferralId,
        });
      }
    } else if (account.status !== "active") {
      return { error: "account_unavailable" as const };
    }
    if (!account) throw new Error("Email account resolution failed");

    const sessionToken = createOpaqueToken();
    const sessionExpiresAt = new Date(now.getTime() + ttlSeconds * 1_000);
    const [session] = await tx
      .insert(sessions)
      .values({
        accountId: account.id,
        createdAt: now,
        expiresAt: sessionExpiresAt,
        lastSeenAt: now,
        tokenHash: await hashOpaqueToken(sessionToken),
      })
      .returning({ id: sessions.id });
    if (!session) throw new Error("Failed to issue email login session");

    await tx
      .update(loginChallenges)
      .set({ consumedAt: now })
      .where(eq(loginChallenges.id, challenge.id));

    return {
      accountCreated,
      accountId: account.id,
      displayName: account.displayName,
      email: challenge.email,
      returnTo: challenge.returnTo,
      session: {
        accountId: account.id,
        expiresAt: sessionExpiresAt,
        sessionId: session.id,
        token: sessionToken,
      },
    };
    }).catch((error: unknown) => {
    if (
      error instanceof GrowthError &&
      error.code === "referral_registration_unavailable"
    ) {
      throw new EmailAuthError("referral_registration_unavailable");
    }
    throw error;
  });

  if ("error" in result) throw new EmailAuthError(result.error);
  return result;
}

export async function cancelLoginChallenge(
  db: AttentionDatabase,
  challengeId: string,
): Promise<void> {
  await db
    .delete(loginChallenges)
    .where(and(eq(loginChallenges.id, challengeId), isNull(loginChallenges.consumedAt)));
}

export function fingerprintLoginRequester(value: string): string {
  return createHmac("sha256", authSecret())
    .update("attention:login-requester:v1\0")
    .update(value)
    .digest("hex");
}
