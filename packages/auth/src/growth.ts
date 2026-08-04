import {
  accounts,
  and,
  asc,
  consumerReferrals,
  count,
  desc,
  eq,
  filterAnnualCodes,
  filterProfiles,
  growthBillingEvents,
  growthTokenAttempts,
  gt,
  gte,
  inArray,
  isNull,
  membershipGrants,
  pointsBalances,
  pointsLedgerEntries,
  pointsReservations,
  sql,
  subscriptions,
  type AttentionDatabase,
  type AttentionTransaction,
} from "@attention/db";

import { createOpaqueToken, hashOpaqueToken } from "./tokens";

const CONSUMER_INVITE_DEFAULT_TTL_DAYS = 30;
const FILTER_CODE_DEFAULT_TTL_DAYS = 30;
const CONSUMER_INVITE_MAX_TTL_DAYS = 365;
const FILTER_CODE_MAX_TTL_DAYS = 90;
const TOKEN_ATTEMPT_LIMIT_PER_HOUR = 20;
const FILTER_CODES_PER_UTC_YEAR = 5;
const POINTS_PERCENT_NUMERATOR = 15;
const POINTS_PERCENT_DENOMINATOR = 100;

export type GrowthErrorCode =
  | "account_not_active"
  | "active_consumer_invite_exists"
  | "billing_event_conflict"
  | "consumer_invite_ineligible"
  | "consumer_invite_used"
  | "filter_code_annual_limit"
  | "filter_code_invalid"
  | "filter_required"
  | "insufficient_points"
  | "invalid_amount"
  | "invalid_currency"
  | "invalid_event"
  | "points_clawback_pending"
  | "rate_limited"
  | "referral_registration_unavailable"
  | "reservation_conflict"
  | "reservation_finalized"
  | "reservation_not_found";

export class GrowthError extends Error {
  constructor(readonly code: GrowthErrorCode) {
    super(code);
    this.name = "GrowthError";
  }
}

export interface AppendedMembershipGrant {
  duplicate: boolean;
  endsAt: Date;
  grantId: string;
  startsAt: Date;
}

export interface GrowthDashboard {
  consumerInvite: {
    canCreate: boolean;
    expiresAt: Date | null;
    registeredAt: Date | null;
    status: "active" | "expired" | "invalidated" | "redeemed" | "unavailable";
  };
  filterCodes: Array<{
    createdAt: Date;
    expiresAt: Date;
    id: string;
    issuanceYear: number;
    redeemedAt: Date | null;
    status: "active" | "expired" | "invalidated" | "redeemed" | "issuer_revoked";
  }>;
  filterCodesIssuedThisYear: number;
  isFilter: boolean;
  pointsBalances: Array<{
    availableMinor: number;
    clawbackMinor: number;
    currency: string;
    reservedMinor: number;
  }>;
  pointsEntries: Array<{
    amountMinor: number;
    availableDeltaMinor: number;
    clawbackDeltaMinor: number;
    currency: string;
    entryType: "consume" | "earn" | "release" | "reserve" | "reversal";
    id: string;
    occurredAt: Date;
    reservedDeltaMinor: number;
  }>;
}

function envTtlDays(
  name: string,
  fallback: number,
  maximum: number,
): number {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function requestedTtlDays(
  value: number | undefined,
  envName: string,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return envTtlDays(envName, fallback, maximum);
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`ttlDays must be between 1 and ${maximum}`);
  }
  return value;
}

export function addCalendarMonths(value: Date, months: number): Date {
  if (!Number.isInteger(months) || months < 1 || months > 120) {
    throw new RangeError("months must be between 1 and 120");
  }
  const result = new Date(value);
  const originalDay = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(originalDay, lastDay));
  return result;
}

async function setAccountContext(
  tx: AttentionTransaction,
  accountId: string,
): Promise<void> {
  await tx.execute(sql`select set_config('app.account_id', ${accountId}, true)`);
}

async function lockNamespace(
  tx: AttentionTransaction,
  namespace: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${namespace}::text, 0))`,
  );
}

async function requireActiveAccount(
  tx: AttentionTransaction,
  accountId: string,
): Promise<{ signupSource: "consumer_referral" | "direct" }> {
  const [account] = await tx
    .select({ signupSource: accounts.signupSource })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.status, "active")))
    .limit(1);
  if (!account) throw new GrowthError("account_not_active");
  return account;
}

async function activeFilter(
  tx: AttentionTransaction,
  accountId: string,
): Promise<boolean> {
  const [filter] = await tx
    .select({ accountId: filterProfiles.accountId })
    .from(filterProfiles)
    .where(
      and(
        eq(filterProfiles.accountId, accountId),
        eq(filterProfiles.active, true),
        isNull(filterProfiles.revokedAt),
      ),
    )
    .limit(1);
  return Boolean(filter);
}

export async function appendMembershipGrant(
  tx: AttentionTransaction,
  input: {
    accountId: string;
    kind:
      | "admin_grant"
      | "consumer_invitee_quarter"
      | "consumer_inviter_quarter"
      | "direct_trial"
      | "filter_annual_redemption";
    months: number;
    now: Date;
    sourceId: string;
    excludeSubscriptionId?: string;
  },
): Promise<AppendedMembershipGrant> {
  await lockNamespace(tx, `membership-grant:${input.accountId}`);
  const [existing] = await tx
    .select({
      endsAt: membershipGrants.endsAt,
      id: membershipGrants.id,
      startsAt: membershipGrants.startsAt,
    })
    .from(membershipGrants)
    .where(
      and(
        eq(membershipGrants.kind, input.kind),
        eq(membershipGrants.sourceId, input.sourceId),
      ),
    )
    .limit(1);
  if (existing) return { ...existing, duplicate: true, grantId: existing.id };

  const [latestGrant, currentSubscriptions] = await Promise.all([
    tx
      .select({ endsAt: membershipGrants.endsAt })
      .from(membershipGrants)
      .where(
        and(
          eq(membershipGrants.accountId, input.accountId),
          inArray(membershipGrants.status, ["active", "scheduled"]),
          isNull(membershipGrants.revokedAt),
          gt(membershipGrants.endsAt, input.now),
        ),
      )
      .orderBy(desc(membershipGrants.endsAt))
      .limit(1),
    tx
      .select({ endsAt: subscriptions.currentPeriodEnd, id: subscriptions.id })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.accountId, input.accountId),
          inArray(subscriptions.status, ["trialing", "active"]),
          gt(subscriptions.currentPeriodEnd, input.now),
        ),
      )
      .orderBy(desc(subscriptions.currentPeriodEnd)),
  ]);
  const latestSubscription = currentSubscriptions.find(
    (subscription) => subscription.id !== input.excludeSubscriptionId,
  );
  const startsAt = [input.now, latestGrant[0]?.endsAt, latestSubscription?.endsAt]
    .filter((value): value is Date => value instanceof Date)
    .reduce((latest, value) => (value > latest ? value : latest), input.now);
  const endsAt = addCalendarMonths(startsAt, input.months);
  const [grant] = await tx
    .insert(membershipGrants)
    .values({
      accountId: input.accountId,
      createdAt: input.now,
      endsAt,
      kind: input.kind,
      sourceId: input.sourceId,
      startsAt,
      status: startsAt <= input.now ? "active" : "scheduled",
    })
    .returning({ id: membershipGrants.id });
  if (!grant) throw new Error("membership_grant_insert_failed");
  return { duplicate: false, endsAt, grantId: grant.id, startsAt };
}

export async function createConsumerInvite(
  db: AttentionDatabase,
  input: {
    accountId: string;
    now?: Date;
    replaceActive?: boolean;
    ttlDays?: number;
  },
): Promise<{ expiresAt: Date; invitationId: string; token: string }> {
  const now = input.now ?? new Date();
  const ttlDays = requestedTtlDays(
    input.ttlDays,
    "ATTENTION_CONSUMER_INVITE_TTL_DAYS",
    CONSUMER_INVITE_DEFAULT_TTL_DAYS,
    CONSUMER_INVITE_MAX_TTL_DAYS,
  );
  const token = createOpaqueToken();
  const tokenHash = await hashOpaqueToken(token);
  return db.transaction(async (tx) => {
    await setAccountContext(tx, input.accountId);
    await lockNamespace(tx, `consumer-invite:${input.accountId}`);
    await requireActiveAccount(tx, input.accountId);
    if (await activeFilter(tx, input.accountId)) {
      throw new GrowthError("consumer_invite_ineligible");
    }
    const [successful] = await tx
      .select({ id: consumerReferrals.id })
      .from(consumerReferrals)
      .where(
        and(
          eq(consumerReferrals.inviterAccountId, input.accountId),
          eq(consumerReferrals.status, "redeemed"),
        ),
      )
      .limit(1);
    if (successful) throw new GrowthError("consumer_invite_used");

    const [active] = await tx
      .select({ expiresAt: consumerReferrals.expiresAt, id: consumerReferrals.id })
      .from(consumerReferrals)
      .where(
        and(
          eq(consumerReferrals.inviterAccountId, input.accountId),
          eq(consumerReferrals.status, "active"),
        ),
      )
      .for("update")
      .limit(1);
    if (active) {
      if (active.expiresAt > now && !input.replaceActive) {
        throw new GrowthError("active_consumer_invite_exists");
      }
      await tx
        .update(consumerReferrals)
        .set({
          invalidatedAt: now,
          invalidatedReason: active.expiresAt <= now ? "expired" : "replaced",
          status: "invalidated",
          updatedAt: now,
        })
        .where(eq(consumerReferrals.id, active.id));
    }
    const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1_000);
    const [invitation] = await tx
      .insert(consumerReferrals)
      .values({
        createdAt: now,
        expiresAt,
        inviterAccountId: input.accountId,
        tokenHash,
        updatedAt: now,
      })
      .returning({ id: consumerReferrals.id });
    if (!invitation) throw new Error("consumer_invite_insert_failed");
    return { expiresAt, invitationId: invitation.id, token };
  });
}

export async function prepareConsumerReferralIntent(
  db: AttentionDatabase,
  input: {
    email: string;
    now: Date;
    requesterFingerprint?: string;
    token: string;
  },
): Promise<string> {
  let tokenHash: string;
  try {
    tokenHash = await hashOpaqueToken(input.token);
  } catch {
    throw new GrowthError("referral_registration_unavailable");
  }
  const fingerprint = input.requesterFingerprint ?? tokenHash;
  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.growth_requester_fingerprint', ${fingerprint}, true)`,
    );
    await tx.execute(
      sql`select set_config('app.consumer_referral_token_hash', ${tokenHash}, true)`,
    );
    await lockNamespace(tx, `growth-token-attempt:consumer-referral:${fingerprint}`);
    const hourAgo = new Date(input.now.getTime() - 60 * 60 * 1_000);
    const [recent] = await tx
      .select({ value: count() })
      .from(growthTokenAttempts)
      .where(
        and(
          eq(growthTokenAttempts.requesterFingerprint, fingerprint),
          eq(growthTokenAttempts.tokenKind, "consumer_referral"),
          gte(growthTokenAttempts.createdAt, hourAgo),
        ),
      );
    if ((recent?.value ?? 0) >= TOKEN_ATTEMPT_LIMIT_PER_HOUR) {
      return { error: "rate_limited" as const };
    }
    const [referral] = await tx
      .select({
        expiresAt: consumerReferrals.expiresAt,
        id: consumerReferrals.id,
        inviterAccountId: consumerReferrals.inviterAccountId,
        inviterStatus: accounts.status,
        status: consumerReferrals.status,
      })
      .from(consumerReferrals)
      .innerJoin(accounts, eq(accounts.id, consumerReferrals.inviterAccountId))
      .where(eq(consumerReferrals.tokenHash, tokenHash))
      .limit(1);
    const [existingAccount] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.primaryEmail, input.email))
      .limit(1);
    const inviterIsFilter = referral
      ? await activeFilter(tx, referral.inviterAccountId)
      : false;
    const success = Boolean(
      referral &&
        referral.status === "active" &&
        referral.expiresAt > input.now &&
        referral.inviterStatus === "active" &&
        !inviterIsFilter &&
        !existingAccount,
    );
    await tx.insert(growthTokenAttempts).values({
      createdAt: input.now,
      requesterFingerprint: fingerprint,
      success,
      tokenHash,
      tokenKind: "consumer_referral",
    });
    return success && referral
      ? { referralId: referral.id }
      : { error: "referral_registration_unavailable" as const };
  });
  if ("error" in result) throw new GrowthError(result.error);
  return result.referralId;
}

export async function redeemConsumerReferralRegistration(
  tx: AttentionTransaction,
  input: { inviteeAccountId: string; now: Date; referralId: string },
): Promise<{ inviteeGrant: AppendedMembershipGrant; inviterGrant: AppendedMembershipGrant }> {
  await setAccountContext(tx, input.inviteeAccountId);
  await tx.execute(
    sql`select set_config('app.consumer_referral_id', ${input.referralId}, true)`,
  );
  const [referral] = await tx
    .select({
      expiresAt: consumerReferrals.expiresAt,
      inviterAccountId: consumerReferrals.inviterAccountId,
      status: consumerReferrals.status,
    })
    .from(consumerReferrals)
    .where(eq(consumerReferrals.id, input.referralId))
    .for("update")
    .limit(1);
  if (
    !referral ||
    referral.status !== "active" ||
    referral.expiresAt <= input.now ||
    referral.inviterAccountId === input.inviteeAccountId
  ) {
    throw new GrowthError("referral_registration_unavailable");
  }
  const [inviter] = await tx
    .select({ status: accounts.status })
    .from(accounts)
    .where(eq(accounts.id, referral.inviterAccountId))
    .limit(1);
  if (!inviter || inviter.status !== "active" || (await activeFilter(tx, referral.inviterAccountId))) {
    throw new GrowthError("referral_registration_unavailable");
  }
  await tx
    .update(consumerReferrals)
    .set({
      inviteeAccountId: input.inviteeAccountId,
      registeredAt: input.now,
      status: "redeemed",
      updatedAt: input.now,
    })
    .where(eq(consumerReferrals.id, input.referralId));
  const inviteeGrant = await appendMembershipGrant(tx, {
    accountId: input.inviteeAccountId,
    kind: "consumer_invitee_quarter",
    months: 3,
    now: input.now,
    sourceId: input.referralId,
  });
  const inviterGrant = await appendMembershipGrant(tx, {
    accountId: referral.inviterAccountId,
    kind: "consumer_inviter_quarter",
    months: 3,
    now: input.now,
    sourceId: input.referralId,
  });
  return { inviteeGrant, inviterGrant };
}

export async function issueFilterAnnualCode(
  db: AttentionDatabase,
  input: { accountId: string; now?: Date; ttlDays?: number },
): Promise<{ codeId: string; expiresAt: Date; issuanceYear: number; token: string }> {
  const now = input.now ?? new Date();
  const ttlDays = requestedTtlDays(
    input.ttlDays,
    "ATTENTION_FILTER_CODE_TTL_DAYS",
    FILTER_CODE_DEFAULT_TTL_DAYS,
    FILTER_CODE_MAX_TTL_DAYS,
  );
  const token = createOpaqueToken();
  const tokenHash = await hashOpaqueToken(token);
  const issuanceYear = now.getUTCFullYear();
  return db.transaction(async (tx) => {
    await setAccountContext(tx, input.accountId);
    await requireActiveAccount(tx, input.accountId);
    if (!(await activeFilter(tx, input.accountId))) {
      throw new GrowthError("filter_required");
    }
    await lockNamespace(tx, `filter-code-issue:${input.accountId}:${issuanceYear}`);
    const [issued] = await tx
      .select({ value: count() })
      .from(filterAnnualCodes)
      .where(
        and(
          eq(filterAnnualCodes.issuerFilterAccountId, input.accountId),
          eq(filterAnnualCodes.issuanceYear, issuanceYear),
        ),
      );
    if ((issued?.value ?? 0) >= FILTER_CODES_PER_UTC_YEAR) {
      throw new GrowthError("filter_code_annual_limit");
    }
    const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1_000);
    const [code] = await tx
      .insert(filterAnnualCodes)
      .values({
        createdAt: now,
        expiresAt,
        issuanceYear,
        issuerFilterAccountId: input.accountId,
        tokenHash,
        updatedAt: now,
      })
      .returning({ id: filterAnnualCodes.id });
    if (!code) throw new Error("filter_code_insert_failed");
    return { codeId: code.id, expiresAt, issuanceYear, token };
  });
}

async function recordFilterCodeAttempt(
  db: AttentionDatabase,
  input: { accountId: string; now: Date; tokenHash: string },
): Promise<string> {
  return db.transaction(async (tx) => {
    await setAccountContext(tx, input.accountId);
    await requireActiveAccount(tx, input.accountId);
    await lockNamespace(tx, `growth-token-attempt:filter-annual:${input.accountId}`);
    const hourAgo = new Date(input.now.getTime() - 60 * 60 * 1_000);
    const [recent] = await tx
      .select({ value: count() })
      .from(growthTokenAttempts)
      .where(
        and(
          eq(growthTokenAttempts.accountId, input.accountId),
          eq(growthTokenAttempts.tokenKind, "filter_annual"),
          gte(growthTokenAttempts.createdAt, hourAgo),
        ),
      );
    if ((recent?.value ?? 0) >= TOKEN_ATTEMPT_LIMIT_PER_HOUR) {
      throw new GrowthError("rate_limited");
    }
    const [attempt] = await tx
      .insert(growthTokenAttempts)
      .values({
        accountId: input.accountId,
        createdAt: input.now,
        tokenHash: input.tokenHash,
        tokenKind: "filter_annual",
      })
      .returning({ id: growthTokenAttempts.id });
    if (!attempt) throw new Error("growth_attempt_insert_failed");
    return attempt.id;
  });
}

export async function redeemFilterAnnualCode(
  db: AttentionDatabase,
  input: { accountId: string; now?: Date; token: string },
): Promise<AppendedMembershipGrant & { codeId: string }> {
  const now = input.now ?? new Date();
  let tokenHash: string;
  try {
    tokenHash = await hashOpaqueToken(input.token);
  } catch {
    throw new GrowthError("filter_code_invalid");
  }
  const attemptId = await recordFilterCodeAttempt(db, {
    accountId: input.accountId,
    now,
    tokenHash,
  });
  const result = await db.transaction(async (tx) => {
    await setAccountContext(tx, input.accountId);
    await tx.execute(
      sql`select set_config('app.filter_annual_token_hash', ${tokenHash}, true)`,
    );
    await requireActiveAccount(tx, input.accountId);
    const [code] = await tx
      .select({
        expiresAt: filterAnnualCodes.expiresAt,
        id: filterAnnualCodes.id,
        issuerFilterAccountId: filterAnnualCodes.issuerFilterAccountId,
        status: filterAnnualCodes.status,
      })
      .from(filterAnnualCodes)
      .where(eq(filterAnnualCodes.tokenHash, tokenHash))
      .for("update")
      .limit(1);
    if (!code || code.status !== "active" || code.issuerFilterAccountId === input.accountId) {
      return { error: "filter_code_invalid" as const };
    }
    if (code.expiresAt <= now || !(await activeFilter(tx, code.issuerFilterAccountId))) {
      return { error: "filter_code_invalid" as const };
    }
    const grant = await appendMembershipGrant(tx, {
      accountId: input.accountId,
      kind: "filter_annual_redemption",
      months: 12,
      now,
      sourceId: code.id,
    });
    await tx
      .update(filterAnnualCodes)
      .set({
        redeemedAt: now,
        redeemedByAccountId: input.accountId,
        status: "redeemed",
        updatedAt: now,
      })
      .where(eq(filterAnnualCodes.id, code.id));
    await tx
      .update(growthTokenAttempts)
      .set({ success: true })
      .where(eq(growthTokenAttempts.id, attemptId));
    return { ...grant, codeId: code.id };
  });
  if ("error" in result) throw new GrowthError(result.error);
  return result;
}

export async function loadGrowthDashboard(
  db: AttentionDatabase,
  accountId: string,
  now = new Date(),
): Promise<GrowthDashboard> {
  return db.transaction(async (tx) => {
    await setAccountContext(tx, accountId);
    await requireActiveAccount(tx, accountId);
    const isFilter = await activeFilter(tx, accountId);
    const [referrals, codes, balances, entries] = await Promise.all([
      tx
        .select({
          expiresAt: consumerReferrals.expiresAt,
          registeredAt: consumerReferrals.registeredAt,
          status: consumerReferrals.status,
        })
        .from(consumerReferrals)
        .where(eq(consumerReferrals.inviterAccountId, accountId))
        .orderBy(desc(consumerReferrals.createdAt)),
      tx
        .select({
          createdAt: filterAnnualCodes.createdAt,
          expiresAt: filterAnnualCodes.expiresAt,
          id: filterAnnualCodes.id,
          issuanceYear: filterAnnualCodes.issuanceYear,
          redeemedAt: filterAnnualCodes.redeemedAt,
          status: filterAnnualCodes.status,
        })
        .from(filterAnnualCodes)
        .where(eq(filterAnnualCodes.issuerFilterAccountId, accountId))
        .orderBy(desc(filterAnnualCodes.createdAt)),
      tx
        .select({
          availableMinor: pointsBalances.availableMinor,
          clawbackMinor: pointsBalances.clawbackMinor,
          currency: pointsBalances.currency,
          reservedMinor: pointsBalances.reservedMinor,
        })
        .from(pointsBalances)
        .where(eq(pointsBalances.accountId, accountId))
        .orderBy(asc(pointsBalances.currency)),
      tx
        .select({
          amountMinor: pointsLedgerEntries.amountMinor,
          availableDeltaMinor: pointsLedgerEntries.availableDeltaMinor,
          clawbackDeltaMinor: pointsLedgerEntries.clawbackDeltaMinor,
          currency: pointsLedgerEntries.currency,
          entryType: pointsLedgerEntries.entryType,
          id: pointsLedgerEntries.id,
          occurredAt: pointsLedgerEntries.occurredAt,
          reservedDeltaMinor: pointsLedgerEntries.reservedDeltaMinor,
        })
        .from(pointsLedgerEntries)
        .where(eq(pointsLedgerEntries.accountId, accountId))
        .orderBy(desc(pointsLedgerEntries.occurredAt))
        .limit(50),
    ]);
    const latest = referrals[0];
    const successful = referrals.some((item) => item.status === "redeemed");
    const latestStatus = latest
      ? latest.status === "active" && latest.expiresAt <= now
        ? "expired"
        : latest.status
      : "unavailable";
    return {
      consumerInvite: {
        canCreate: !isFilter && !successful,
        expiresAt: latest?.expiresAt ?? null,
        registeredAt: latest?.registeredAt ?? null,
        status: isFilter && latestStatus === "active" ? "invalidated" : latestStatus,
      },
      filterCodes: codes.map((code) => ({
        ...code,
        status:
          code.status === "active" && code.expiresAt <= now
            ? "expired"
            : !isFilter && code.status === "active"
              ? "issuer_revoked"
              : code.status,
      })),
      filterCodesIssuedThisYear: codes.filter(
        (code) => code.issuanceYear === now.getUTCFullYear(),
      ).length,
      isFilter,
      pointsBalances: balances,
      pointsEntries: entries,
    };
  });
}

function normalizeProvider(value: string): string {
  const provider = value.normalize("NFKC").trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(provider)) {
    throw new GrowthError("invalid_event");
  }
  return provider;
}

function normalizeEventId(value: string): string {
  const eventId = value.normalize("NFKC").trim();
  if (!eventId || eventId.length > 255) throw new GrowthError("invalid_event");
  return eventId;
}

function normalizeCurrency(value: string): string {
  const currency = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/u.test(currency)) throw new GrowthError("invalid_currency");
  return currency;
}

function positiveSafeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new GrowthError("invalid_amount");
  }
  return value;
}

async function lockBillingEvent(
  tx: AttentionTransaction,
  provider: string,
  eventId: string,
): Promise<void> {
  await lockNamespace(tx, `growth-billing:${provider}:${eventId}`);
}

async function lockBillingEventSet(
  tx: AttentionTransaction,
  events: ReadonlyArray<{ eventId: string; provider: string }>,
): Promise<void> {
  const namespaces = [...new Set(
    events.map((event) => `growth-billing:${event.provider}:${event.eventId}`),
  )].sort();
  for (const namespace of namespaces) {
    await lockNamespace(tx, namespace);
  }
}

async function requireSubscription(
  tx: AttentionTransaction,
  input: { accountId: string; provider: string; subscriptionId: string },
): Promise<void> {
  const [subscription] = await tx
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.id, input.subscriptionId),
        eq(subscriptions.accountId, input.accountId),
        eq(subscriptions.provider, input.provider),
        inArray(subscriptions.status, ["trialing", "active"]),
      ),
    )
    .limit(1);
  if (!subscription) throw new GrowthError("invalid_event");
}

export async function recordPaidSubscriptionBound(
  db: AttentionDatabase,
  input: {
    accountId: string;
    occurredAt?: Date;
    provider: string;
    providerEventId: string;
    subscriptionId: string;
  },
): Promise<{
  duplicate: boolean;
  eventId: string;
  grant: AppendedMembershipGrant | null;
  trialGranted: boolean;
}> {
  const provider = normalizeProvider(input.provider);
  const providerEventId = normalizeEventId(input.providerEventId);
  const now = input.occurredAt ?? new Date();
  return db.transaction(async (tx) => {
    await setAccountContext(tx, input.accountId);
    await lockBillingEvent(tx, provider, providerEventId);
    const [existing] = await tx
      .select({
        accountId: growthBillingEvents.accountId,
        eventType: growthBillingEvents.eventType,
        id: growthBillingEvents.id,
        subscriptionId: growthBillingEvents.subscriptionId,
      })
      .from(growthBillingEvents)
      .where(
        and(
          eq(growthBillingEvents.provider, provider),
          eq(growthBillingEvents.providerEventId, providerEventId),
        ),
      )
      .limit(1);
    if (existing) {
      if (
        existing.eventType !== "paid_subscription_bound" ||
        existing.accountId !== input.accountId ||
        existing.subscriptionId !== input.subscriptionId
      ) {
        throw new GrowthError("billing_event_conflict");
      }
      const [grant] = await tx
        .select({
          endsAt: membershipGrants.endsAt,
          id: membershipGrants.id,
          startsAt: membershipGrants.startsAt,
        })
        .from(membershipGrants)
        .where(
          and(
            eq(membershipGrants.kind, "direct_trial"),
            eq(membershipGrants.sourceId, existing.id),
          ),
        )
        .limit(1);
      return {
        duplicate: true,
        eventId: existing.id,
        grant: grant ? { ...grant, duplicate: true, grantId: grant.id } : null,
        trialGranted: Boolean(grant),
      };
    }
    await requireSubscription(tx, {
      accountId: input.accountId,
      provider,
      subscriptionId: input.subscriptionId,
    });
    await lockNamespace(tx, `direct-trial:${input.accountId}`);
    const [account] = await tx
      .select({
        consumedAt: accounts.directTrialConsumedAt,
        signupSource: accounts.signupSource,
        status: accounts.status,
      })
      .from(accounts)
      .where(eq(accounts.id, input.accountId))
      .for("update")
      .limit(1);
    if (!account || account.status !== "active") {
      throw new GrowthError("account_not_active");
    }
    const [event] = await tx
      .insert(growthBillingEvents)
      .values({
        accountId: input.accountId,
        eventType: "paid_subscription_bound",
        occurredAt: now,
        provider,
        providerEventId,
        subscriptionId: input.subscriptionId,
      })
      .returning({ id: growthBillingEvents.id });
    if (!event) throw new Error("growth_billing_event_insert_failed");
    if (account.signupSource !== "direct" || account.consumedAt) {
      return {
        duplicate: false,
        eventId: event.id,
        grant: null,
        trialGranted: false,
      };
    }
    const [legacyGrant] = await tx
      .select({ id: membershipGrants.id })
      .from(membershipGrants)
      .where(
        and(
          eq(membershipGrants.accountId, input.accountId),
          eq(membershipGrants.kind, "direct_trial"),
        ),
      )
      .limit(1);
    if (legacyGrant) {
      await tx
        .update(accounts)
        .set({
          directTrialConsumedAt: now,
          directTrialSourceEventKey: `legacy:${legacyGrant.id}`,
          updatedAt: now,
        })
        .where(eq(accounts.id, input.accountId));
      return {
        duplicate: false,
        eventId: event.id,
        grant: null,
        trialGranted: false,
      };
    }
    const grant = await appendMembershipGrant(tx, {
      accountId: input.accountId,
      excludeSubscriptionId: input.subscriptionId,
      kind: "direct_trial",
      months: 3,
      now,
      sourceId: event.id,
    });
    await tx
      .update(accounts)
      .set({
        directTrialConsumedAt: now,
        directTrialSourceEventKey: `${provider}:${providerEventId}`,
        updatedAt: now,
      })
      .where(eq(accounts.id, input.accountId));
    return {
      duplicate: false,
      eventId: event.id,
      grant,
      trialGranted: true,
    };
  });
}

async function lockedPointsBalance(
  tx: AttentionTransaction,
  input: { accountId: string; currency: string; now: Date },
): Promise<{
  availableMinor: number;
  clawbackMinor: number;
  id: string;
  reservedMinor: number;
}> {
  await lockNamespace(tx, `points-balance:${input.accountId}:${input.currency}`);
  let [balance] = await tx
    .select({
      availableMinor: pointsBalances.availableMinor,
      clawbackMinor: pointsBalances.clawbackMinor,
      id: pointsBalances.id,
      reservedMinor: pointsBalances.reservedMinor,
    })
    .from(pointsBalances)
    .where(
      and(
        eq(pointsBalances.accountId, input.accountId),
        eq(pointsBalances.currency, input.currency),
      ),
    )
    .for("update")
    .limit(1);
  if (!balance) {
    [balance] = await tx
      .insert(pointsBalances)
      .values({
        accountId: input.accountId,
        createdAt: input.now,
        currency: input.currency,
        updatedAt: input.now,
      })
      .returning({
        availableMinor: pointsBalances.availableMinor,
        clawbackMinor: pointsBalances.clawbackMinor,
        id: pointsBalances.id,
        reservedMinor: pointsBalances.reservedMinor,
      });
  }
  if (!balance) throw new Error("points_balance_insert_failed");
  return balance;
}

async function creditPoints(
  tx: AttentionTransaction,
  input: {
    accountId: string;
    amountMinor: number;
    billingEventId: string;
    currency: string;
    occurredAt: Date;
  },
): Promise<void> {
  if (input.amountMinor <= 0) return;
  const balance = await lockedPointsBalance(tx, {
    accountId: input.accountId,
    currency: input.currency,
    now: input.occurredAt,
  });
  const clawbackRepaid = Math.min(balance.clawbackMinor, input.amountMinor);
  const availableDelta = input.amountMinor - clawbackRepaid;
  const nextAvailable = balance.availableMinor + availableDelta;
  const nextClawback = balance.clawbackMinor - clawbackRepaid;
  await tx
    .update(pointsBalances)
    .set({
      availableMinor: nextAvailable,
      clawbackMinor: nextClawback,
      updatedAt: input.occurredAt,
    })
    .where(eq(pointsBalances.id, balance.id));
  await tx.insert(pointsLedgerEntries).values({
    accountId: input.accountId,
    amountMinor: input.amountMinor,
    availableAfterMinor: nextAvailable,
    availableDeltaMinor: availableDelta,
    billingEventId: input.billingEventId,
    clawbackAfterMinor: nextClawback,
    clawbackDeltaMinor: -clawbackRepaid,
    currency: input.currency,
    entryType: "earn",
    occurredAt: input.occurredAt,
    reservedAfterMinor: balance.reservedMinor,
    reservedDeltaMinor: 0,
  });
}

async function reversePoints(
  tx: AttentionTransaction,
  input: {
    accountId: string;
    amountMinor: number;
    billingEventId: string;
    currency: string;
    occurredAt: Date;
  },
): Promise<void> {
  if (input.amountMinor <= 0) return;
  const balance = await lockedPointsBalance(tx, {
    accountId: input.accountId,
    currency: input.currency,
    now: input.occurredAt,
  });
  const availableDebit = Math.min(balance.availableMinor, input.amountMinor);
  const clawbackAdded = input.amountMinor - availableDebit;
  const nextAvailable = balance.availableMinor - availableDebit;
  const nextClawback = balance.clawbackMinor + clawbackAdded;
  await tx
    .update(pointsBalances)
    .set({
      availableMinor: nextAvailable,
      clawbackMinor: nextClawback,
      updatedAt: input.occurredAt,
    })
    .where(eq(pointsBalances.id, balance.id));
  await tx.insert(pointsLedgerEntries).values({
    accountId: input.accountId,
    amountMinor: input.amountMinor,
    availableAfterMinor: nextAvailable,
    availableDeltaMinor: -availableDebit,
    billingEventId: input.billingEventId,
    clawbackAfterMinor: nextClawback,
    clawbackDeltaMinor: clawbackAdded,
    currency: input.currency,
    entryType: "reversal",
    occurredAt: input.occurredAt,
    reservedAfterMinor: balance.reservedMinor,
    reservedDeltaMinor: 0,
  });
}

export async function recordSettledReferralRenewal(
  db: AttentionDatabase,
  input: {
    accountId: string;
    cashPaidMinor: number;
    currency: string;
    occurredAt?: Date;
    provider: string;
    providerEventId: string;
    subscriptionId: string;
  },
): Promise<{
  creditedAccountId: string | null;
  duplicate: boolean;
  eventId: string;
  pointsMinor: number;
}> {
  const provider = normalizeProvider(input.provider);
  const providerEventId = normalizeEventId(input.providerEventId);
  const currency = normalizeCurrency(input.currency);
  const cashPaidMinor = positiveSafeInteger(input.cashPaidMinor);
  const occurredAt = input.occurredAt ?? new Date();
  return db.transaction(async (tx) => {
    await setAccountContext(tx, input.accountId);
    await lockBillingEvent(tx, provider, providerEventId);
    const [existing] = await tx
      .select({
        accountId: growthBillingEvents.accountId,
        cashAmountMinor: growthBillingEvents.cashAmountMinor,
        currency: growthBillingEvents.currency,
        eventType: growthBillingEvents.eventType,
        id: growthBillingEvents.id,
        pointsAmountMinor: growthBillingEvents.pointsAmountMinor,
        referralId: growthBillingEvents.referralId,
        subscriptionId: growthBillingEvents.subscriptionId,
      })
      .from(growthBillingEvents)
      .where(
        and(
          eq(growthBillingEvents.provider, provider),
          eq(growthBillingEvents.providerEventId, providerEventId),
        ),
      )
      .limit(1);
    if (existing) {
      if (
        existing.eventType !== "renewal_settled" ||
        existing.accountId !== input.accountId ||
        existing.subscriptionId !== input.subscriptionId ||
        existing.currency !== currency ||
        existing.cashAmountMinor !== cashPaidMinor
      ) {
        throw new GrowthError("billing_event_conflict");
      }
      const [referral] = existing.referralId
        ? await tx
            .select({ inviterAccountId: consumerReferrals.inviterAccountId })
            .from(consumerReferrals)
            .where(eq(consumerReferrals.id, existing.referralId))
            .limit(1)
        : [];
      return {
        creditedAccountId: referral?.inviterAccountId ?? null,
        duplicate: true,
        eventId: existing.id,
        pointsMinor: existing.pointsAmountMinor,
      };
    }
    await requireSubscription(tx, {
      accountId: input.accountId,
      provider,
      subscriptionId: input.subscriptionId,
    });
    const [referral] = await tx
      .select({
        id: consumerReferrals.id,
        inviterAccountId: consumerReferrals.inviterAccountId,
      })
      .from(consumerReferrals)
      .where(
        and(
          eq(consumerReferrals.inviteeAccountId, input.accountId),
          eq(consumerReferrals.status, "redeemed"),
        ),
      )
      .limit(1);
    const pointsMinor = referral
      ? Math.floor(
          (cashPaidMinor * POINTS_PERCENT_NUMERATOR) /
            POINTS_PERCENT_DENOMINATOR,
        )
      : 0;
    const [event] = await tx
      .insert(growthBillingEvents)
      .values({
        accountId: input.accountId,
        cashAmountMinor: cashPaidMinor,
        currency,
        eventType: "renewal_settled",
        occurredAt,
        pointsAmountMinor: pointsMinor,
        provider,
        providerEventId,
        referralId: referral?.id,
        subscriptionId: input.subscriptionId,
      })
      .returning({ id: growthBillingEvents.id });
    if (!event) throw new Error("growth_billing_event_insert_failed");
    if (referral && pointsMinor > 0) {
      await creditPoints(tx, {
        accountId: referral.inviterAccountId,
        amountMinor: pointsMinor,
        billingEventId: event.id,
        currency,
        occurredAt,
      });
    }
    return {
      creditedAccountId: referral?.inviterAccountId ?? null,
      duplicate: false,
      eventId: event.id,
      pointsMinor,
    };
  });
}

export async function recordReferralRenewalReversal(
  db: AttentionDatabase,
  input: {
    cashReversedMinor: number;
    eventType: "renewal_chargeback" | "renewal_refunded";
    occurredAt?: Date;
    originalProvider: string;
    originalProviderEventId: string;
    provider: string;
    providerEventId: string;
  },
): Promise<{ duplicate: boolean; eventId: string; pointsReversedMinor: number }> {
  const provider = normalizeProvider(input.provider);
  const providerEventId = normalizeEventId(input.providerEventId);
  const originalProvider = normalizeProvider(input.originalProvider);
  const originalProviderEventId = normalizeEventId(input.originalProviderEventId);
  const cashReversedMinor = positiveSafeInteger(input.cashReversedMinor);
  const occurredAt = input.occurredAt ?? new Date();
  return db.transaction(async (tx) => {
    // Every reversal of one settlement must serialize before reading the
    // aggregate. Sort the full lock set so malformed cross-event inputs cannot
    // introduce an advisory-lock order cycle.
    await lockBillingEventSet(tx, [
      { eventId: providerEventId, provider },
      { eventId: originalProviderEventId, provider: originalProvider },
    ]);
    const [existing] = await tx
      .select({
        cashAmountMinor: growthBillingEvents.cashAmountMinor,
        eventType: growthBillingEvents.eventType,
        id: growthBillingEvents.id,
        originalEventId: growthBillingEvents.originalEventId,
        pointsAmountMinor: growthBillingEvents.pointsAmountMinor,
      })
      .from(growthBillingEvents)
      .where(
        and(
          eq(growthBillingEvents.provider, provider),
          eq(growthBillingEvents.providerEventId, providerEventId),
        ),
      )
      .limit(1);
    if (existing) {
      const [expectedOriginal] = await tx
        .select({ id: growthBillingEvents.id })
        .from(growthBillingEvents)
        .where(
          and(
            eq(growthBillingEvents.provider, originalProvider),
            eq(growthBillingEvents.providerEventId, originalProviderEventId),
          ),
        )
        .limit(1);
      if (
        existing.eventType !== input.eventType ||
        existing.cashAmountMinor !== cashReversedMinor ||
        existing.originalEventId !== expectedOriginal?.id
      ) {
        throw new GrowthError("billing_event_conflict");
      }
      return {
        duplicate: true,
        eventId: existing.id,
        pointsReversedMinor: existing.pointsAmountMinor,
      };
    }
    const [original] = await tx
      .select({
        accountId: growthBillingEvents.accountId,
        cashAmountMinor: growthBillingEvents.cashAmountMinor,
        currency: growthBillingEvents.currency,
        eventType: growthBillingEvents.eventType,
        id: growthBillingEvents.id,
        pointsAmountMinor: growthBillingEvents.pointsAmountMinor,
        referralId: growthBillingEvents.referralId,
        subscriptionId: growthBillingEvents.subscriptionId,
      })
      .from(growthBillingEvents)
      .where(
        and(
          eq(growthBillingEvents.provider, originalProvider),
          eq(growthBillingEvents.providerEventId, originalProviderEventId),
        ),
      )
      .limit(1);
    if (
      !original ||
      original.eventType !== "renewal_settled" ||
      !original.cashAmountMinor ||
      !original.currency ||
      !original.subscriptionId
    ) {
      throw new GrowthError("invalid_event");
    }
    const priorReversals = await tx
      .select({
        cashAmountMinor: growthBillingEvents.cashAmountMinor,
        pointsAmountMinor: growthBillingEvents.pointsAmountMinor,
      })
      .from(growthBillingEvents)
      .where(
        and(
          eq(growthBillingEvents.originalEventId, original.id),
          inArray(growthBillingEvents.eventType, [
            "renewal_refunded",
            "renewal_chargeback",
          ]),
        ),
      );
    const priorCash = priorReversals.reduce(
      (total, reversal) => total + (reversal.cashAmountMinor ?? 0),
      0,
    );
    if (priorCash + cashReversedMinor > original.cashAmountMinor) {
      throw new GrowthError("invalid_event");
    }
    const priorPoints = priorReversals.reduce(
      (total, reversal) => total + reversal.pointsAmountMinor,
      0,
    );
    const targetReversedPoints = Math.min(
      original.pointsAmountMinor,
      Math.floor(
        ((priorCash + cashReversedMinor) * POINTS_PERCENT_NUMERATOR) /
          POINTS_PERCENT_DENOMINATOR,
      ),
    );
    const pointsReversedMinor = targetReversedPoints - priorPoints;
    const [event] = await tx
      .insert(growthBillingEvents)
      .values({
        accountId: original.accountId,
        cashAmountMinor: cashReversedMinor,
        currency: original.currency,
        eventType: input.eventType,
        occurredAt,
        originalEventId: original.id,
        pointsAmountMinor: pointsReversedMinor,
        provider,
        providerEventId,
        referralId: original.referralId,
        subscriptionId: original.subscriptionId,
      })
      .returning({ id: growthBillingEvents.id });
    if (!event) throw new Error("growth_billing_event_insert_failed");
    if (original.referralId && pointsReversedMinor > 0) {
      const [referral] = await tx
        .select({ inviterAccountId: consumerReferrals.inviterAccountId })
        .from(consumerReferrals)
        .where(eq(consumerReferrals.id, original.referralId))
        .limit(1);
      if (!referral) throw new GrowthError("invalid_event");
      await reversePoints(tx, {
        accountId: referral.inviterAccountId,
        amountMinor: pointsReversedMinor,
        billingEventId: event.id,
        currency: original.currency,
        occurredAt,
      });
    }
    return {
      duplicate: false,
      eventId: event.id,
      pointsReversedMinor,
    };
  });
}

function normalizeIdempotencyKey(value: string): string {
  const key = value.normalize("NFKC").trim();
  if (!key || key.length > 255) throw new GrowthError("reservation_conflict");
  return key;
}

export async function reserveRenewalPoints(
  db: AttentionDatabase,
  input: {
    accountId: string;
    amountMinor: number;
    currency: string;
    idempotencyKey: string;
    now?: Date;
  },
): Promise<{ duplicate: boolean; reservationId: string }> {
  const now = input.now ?? new Date();
  const currency = normalizeCurrency(input.currency);
  const amountMinor = positiveSafeInteger(input.amountMinor);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  return db.transaction(async (tx) => {
    await setAccountContext(tx, input.accountId);
    await requireActiveAccount(tx, input.accountId);
    await lockNamespace(tx, `points-reservation:${input.accountId}:${idempotencyKey}`);
    const [existing] = await tx
      .select({
        amountMinor: pointsReservations.amountMinor,
        currency: pointsReservations.currency,
        id: pointsReservations.id,
      })
      .from(pointsReservations)
      .where(
        and(
          eq(pointsReservations.accountId, input.accountId),
          eq(pointsReservations.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    if (existing) {
      if (existing.amountMinor !== amountMinor || existing.currency !== currency) {
        throw new GrowthError("reservation_conflict");
      }
      return { duplicate: true, reservationId: existing.id };
    }
    const balance = await lockedPointsBalance(tx, {
      accountId: input.accountId,
      currency,
      now,
    });
    if (balance.availableMinor < amountMinor || balance.clawbackMinor > 0) {
      throw new GrowthError("insufficient_points");
    }
    const [reservation] = await tx
      .insert(pointsReservations)
      .values({
        accountId: input.accountId,
        amountMinor,
        createdAt: now,
        currency,
        idempotencyKey,
        updatedAt: now,
      })
      .returning({ id: pointsReservations.id });
    if (!reservation) throw new Error("points_reservation_insert_failed");
    const nextAvailable = balance.availableMinor - amountMinor;
    const nextReserved = balance.reservedMinor + amountMinor;
    await tx
      .update(pointsBalances)
      .set({
        availableMinor: nextAvailable,
        reservedMinor: nextReserved,
        updatedAt: now,
      })
      .where(eq(pointsBalances.id, balance.id));
    await tx.insert(pointsLedgerEntries).values({
      accountId: input.accountId,
      amountMinor,
      availableAfterMinor: nextAvailable,
      availableDeltaMinor: -amountMinor,
      clawbackAfterMinor: balance.clawbackMinor,
      clawbackDeltaMinor: 0,
      currency,
      entryType: "reserve",
      occurredAt: now,
      reservationId: reservation.id,
      reservedAfterMinor: nextReserved,
      reservedDeltaMinor: amountMinor,
    });
    return { duplicate: false, reservationId: reservation.id };
  });
}

async function finalizePointsReservation(
  db: AttentionDatabase,
  input: {
    accountId: string;
    now?: Date;
    reservationId: string;
    target: "consumed" | "released";
  },
): Promise<{ duplicate: boolean }> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    await setAccountContext(tx, input.accountId);
    await requireActiveAccount(tx, input.accountId);
    const [reservation] = await tx
      .select({
        amountMinor: pointsReservations.amountMinor,
        currency: pointsReservations.currency,
        id: pointsReservations.id,
        status: pointsReservations.status,
      })
      .from(pointsReservations)
      .where(
        and(
          eq(pointsReservations.id, input.reservationId),
          eq(pointsReservations.accountId, input.accountId),
        ),
      )
      .for("update")
      .limit(1);
    if (!reservation) throw new GrowthError("reservation_not_found");
    if (reservation.status === input.target) return { duplicate: true };
    if (reservation.status !== "reserved") {
      throw new GrowthError("reservation_finalized");
    }
    const balance = await lockedPointsBalance(tx, {
      accountId: input.accountId,
      currency: reservation.currency,
      now,
    });
    if (balance.reservedMinor < reservation.amountMinor) {
      throw new GrowthError("reservation_conflict");
    }
    if (input.target === "consumed" && balance.clawbackMinor > 0) {
      throw new GrowthError("points_clawback_pending");
    }
    const nextReserved = balance.reservedMinor - reservation.amountMinor;
    const nextAvailable =
      input.target === "released"
        ? balance.availableMinor + reservation.amountMinor
        : balance.availableMinor;
    await tx
      .update(pointsBalances)
      .set({
        availableMinor: nextAvailable,
        reservedMinor: nextReserved,
        updatedAt: now,
      })
      .where(eq(pointsBalances.id, balance.id));
    await tx
      .update(pointsReservations)
      .set(
        input.target === "released"
          ? { releasedAt: now, status: "released", updatedAt: now }
          : { consumedAt: now, status: "consumed", updatedAt: now },
      )
      .where(eq(pointsReservations.id, reservation.id));
    await tx.insert(pointsLedgerEntries).values({
      accountId: input.accountId,
      amountMinor: reservation.amountMinor,
      availableAfterMinor: nextAvailable,
      availableDeltaMinor:
        input.target === "released" ? reservation.amountMinor : 0,
      clawbackAfterMinor: balance.clawbackMinor,
      clawbackDeltaMinor: 0,
      currency: reservation.currency,
      entryType: input.target === "released" ? "release" : "consume",
      occurredAt: now,
      reservationId: reservation.id,
      reservedAfterMinor: nextReserved,
      reservedDeltaMinor: -reservation.amountMinor,
    });
    return { duplicate: false };
  });
}

export function releaseRenewalPoints(
  db: AttentionDatabase,
  input: { accountId: string; now?: Date; reservationId: string },
): Promise<{ duplicate: boolean }> {
  return finalizePointsReservation(db, { ...input, target: "released" });
}

export function consumeRenewalPoints(
  db: AttentionDatabase,
  input: { accountId: string; now?: Date; reservationId: string },
): Promise<{ duplicate: boolean }> {
  return finalizePointsReservation(db, { ...input, target: "consumed" });
}
