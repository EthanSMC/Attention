import "server-only";

import type { SessionPrincipal } from "@attention/auth";
import {
  accounts,
  adminEntitlementAudits,
  and,
  count,
  desc,
  entitlements,
  eq,
  filterProfiles,
  inArray,
  isNull,
  membershipGrants,
  sql,
  subscriptions,
  type AdminEntitlementState,
  type AttentionDatabase,
  type AttentionTransaction,
} from "@attention/db";
import { z } from "zod";

import { requireAdminPrincipal } from "./admin-access";

export type AdminEntitlementAction =
  | "revoke_filter"
  | "set_filter"
  | "set_member";
export type AdminEntitlementTier = AdminEntitlementState["tier"];

export interface AdminUserListInput {
  now?: Date;
  page?: number | string;
  pageSize?: number | string;
  query?: string;
  tier?: AdminEntitlementTier;
}

export interface ParsedAdminUserListInput {
  page: number;
  pageSize: number;
  query?: string;
  tier?: AdminEntitlementTier;
}

export interface AdminUserListItem extends AdminEntitlementState {
  accountId: string;
  attentionId: string | null;
  createdAt: Date;
  displayName: string;
  primaryEmail: string | null;
  status: "active" | "deleted" | "invited" | "suspended";
}

export interface AdminUserListResult {
  items: AdminUserListItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface AdminEntitlementChangeInput {
  action: AdminEntitlementAction;
  now?: Date;
  reason: string;
  requestId: string;
  source: "admin_console";
  targetAccountId: string;
}

export interface ParsedAdminEntitlementChangeInput {
  action: AdminEntitlementAction;
  reason: string;
  requestId: string;
  source: "admin_console";
  targetAccountId: string;
}

export interface AdminEntitlementChangeResult {
  action: AdminEntitlementAction;
  auditId: string;
  nextState: AdminEntitlementState;
  previousState: AdminEntitlementState;
  targetAccountId: string;
}

export interface AdminEntitlementAuditRecord {
  action: AdminEntitlementAction;
  actor: {
    accountId: string;
    displayName: string;
    primaryEmail: string | null;
  };
  id: string;
  nextState: AdminEntitlementState;
  occurredAt: Date;
  previousState: AdminEntitlementState;
  reason: string;
  requestId: string;
  source: string;
  targetAccountId: string;
}

export type AdminUserEntitlementErrorCode =
  | "target_account_not_active"
  | "target_account_not_found";

export class AdminUserEntitlementError extends Error {
  constructor(readonly code: AdminUserEntitlementErrorCode) {
    super(code);
    this.name = "AdminUserEntitlementError";
  }
}

const positiveInteger = (maximum: number) =>
  z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : value,
    z.number().int().min(1).max(maximum),
  );

const adminUserListSchema = z
  .object({
    page: positiveInteger(1_000_000).default(1),
    pageSize: positiveInteger(100).default(25),
    query: z
      .string()
      .transform((value) => value.normalize("NFKC").trim())
      .pipe(z.string().max(100))
      .optional(),
    tier: z.enum(["free", "member", "filter"]).optional(),
  })
  .strict();

const adminEntitlementChangeSchema = z
  .object({
    action: z.enum(["set_member", "set_filter", "revoke_filter"]),
    reason: z.string().transform((value) => value.normalize("NFKC").trim()).pipe(
      z.string().min(3).max(500),
    ),
    requestId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
    source: z.literal("admin_console"),
    targetAccountId: z.string().uuid(),
  })
  .strict();

export function parseAdminUserListInput(input: {
  page?: unknown;
  pageSize?: unknown;
  query?: unknown;
  tier?: unknown;
}): ParsedAdminUserListInput {
  const parsed = adminUserListSchema.parse(input);
  return {
    page: parsed.page,
    pageSize: parsed.pageSize,
    ...(parsed.query ? { query: parsed.query } : {}),
    ...(parsed.tier ? { tier: parsed.tier } : {}),
  };
}

export function parseAdminEntitlementChangeInput(input: {
  action?: unknown;
  reason?: unknown;
  requestId?: unknown;
  source?: unknown;
  targetAccountId?: unknown;
}): ParsedAdminEntitlementChangeInput {
  return adminEntitlementChangeSchema.parse({
    action: input.action,
    reason: input.reason,
    requestId: input.requestId,
    source: input.source,
    targetAccountId: input.targetAccountId,
  });
}

const outerAccountId = sql.raw('"accounts"."id"');

function activeFilterExpression() {
  return sql<boolean>`exists (
    select 1 from ${filterProfiles}
    where ${filterProfiles.accountId} = ${outerAccountId}
      and ${filterProfiles.active} = true
      and ${filterProfiles.revokedAt} is null
  )`;
}

function activeMemberExpression(
  now: Date,
  isFilter = activeFilterExpression(),
) {
  const entitlementNow = sql.param(now, entitlements.startsAt);
  const grantNow = sql.param(now, membershipGrants.startsAt);
  const subscriptionNow = sql.param(now, subscriptions.currentPeriodStart);
  return sql<boolean>`(
    ${isFilter}
    or exists (
      select 1 from ${entitlements}
      where ${entitlements.accountId} = ${outerAccountId}
        and ${entitlements.memberEnabled} = true
        and ${entitlements.startsAt} <= ${entitlementNow}
        and (${entitlements.endsAt} is null or ${entitlements.endsAt} > ${entitlementNow})
    )
    or exists (
      select 1 from ${membershipGrants}
      where ${membershipGrants.accountId} = ${outerAccountId}
        and ${membershipGrants.status} in ('active', 'scheduled')
        and ${membershipGrants.startsAt} <= ${grantNow}
        and ${membershipGrants.endsAt} > ${grantNow}
        and ${membershipGrants.revokedAt} is null
    )
    or exists (
      select 1 from ${subscriptions}
      where ${subscriptions.accountId} = ${outerAccountId}
        and ${subscriptions.status} in ('trialing', 'active')
        and ${subscriptions.currentPeriodStart} <= ${subscriptionNow}
        and ${subscriptions.currentPeriodEnd} > ${subscriptionNow}
    )
  )`;
}

function entitlementExpressions(now: Date) {
  const isFilter = activeFilterExpression();
  const isMember = activeMemberExpression(now, isFilter);
  const tier = sql<AdminEntitlementTier>`case
    when ${isFilter} then 'filter'
    when ${isMember} then 'member'
    else 'free'
  end`;
  return { isFilter, isMember, tier };
}

function escapedContainsPattern(value: string): string {
  return `%${value.replace(/[\\%_]/gu, "\\$&")}%`;
}

export async function listAdminUsers(
  db: AttentionDatabase,
  principal: SessionPrincipal | null,
  input: AdminUserListInput = {},
): Promise<AdminUserListResult> {
  requireAdminPrincipal(principal);
  const parsed = parseAdminUserListInput({
    page: input.page,
    pageSize: input.pageSize,
    query: input.query,
    tier: input.tier,
  });
  const now = input.now ?? new Date();
  const entitlement = entitlementExpressions(now);
  const pattern = parsed.query
    ? escapedContainsPattern(parsed.query)
    : undefined;
  const searchCondition = pattern
    ? sql`(
        coalesce(${accounts.primaryEmail}, '') ilike ${pattern} escape '\\'
        or ${accounts.displayName} ilike ${pattern} escape '\\'
        or coalesce(${accounts.attentionId}, '') ilike ${pattern} escape '\\'
      )`
    : undefined;
  const tierCondition = parsed.tier
    ? sql`${entitlement.tier} = ${parsed.tier}`
    : undefined;
  const where = and(searchCondition, tierCondition);

  return db.transaction(async (tx) => {
    const [totalRow] = await tx
      .select({ value: count() })
      .from(accounts)
      .where(where);
    const items = await tx
      .select({
        accountId: accounts.id,
        attentionId: accounts.attentionId,
        createdAt: accounts.createdAt,
        displayName: accounts.displayName,
        isFilter: entitlement.isFilter,
        isMember: entitlement.isMember,
        primaryEmail: accounts.primaryEmail,
        status: accounts.status,
        tier: entitlement.tier,
      })
      .from(accounts)
      .where(where)
      .orderBy(desc(accounts.createdAt), desc(accounts.id))
      .limit(parsed.pageSize)
      .offset((parsed.page - 1) * parsed.pageSize);
    const total = totalRow?.value ?? 0;
    return {
      items,
      page: parsed.page,
      pageSize: parsed.pageSize,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / parsed.pageSize),
    };
  });
}

type CapabilityReader = AttentionDatabase | AttentionTransaction;

async function readEntitlementState(
  db: CapabilityReader,
  accountId: string,
  now: Date,
): Promise<AdminEntitlementState> {
  const entitlement = entitlementExpressions(now);
  const [state] = await db
    .select({
      isFilter: entitlement.isFilter,
      isMember: entitlement.isMember,
      tier: entitlement.tier,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!state) throw new AdminUserEntitlementError("target_account_not_found");
  return state;
}

async function ensurePermanentMemberEntitlement(
  tx: AttentionTransaction,
  input: {
    accountId: string;
    now: Date;
    source: "admin_grant" | "filter_grant";
  },
): Promise<void> {
  await tx
    .insert(entitlements)
    .values({
      accountId: input.accountId,
      createdAt: input.now,
      endsAt: null,
      memberEnabled: true,
      source: input.source,
      startsAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: [entitlements.accountId, entitlements.source],
      set: {
        endsAt: null,
        memberEnabled: true,
        startsAt: input.now,
        updatedAt: input.now,
      },
    });
}

export async function changeAdminUserEntitlement(
  db: AttentionDatabase,
  principal: SessionPrincipal | null,
  input: AdminEntitlementChangeInput,
): Promise<AdminEntitlementChangeResult> {
  const actor = requireAdminPrincipal(principal);
  const parsed = parseAdminEntitlementChangeInput(input);
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`admin-entitlement:${parsed.targetAccountId}`}::text, 0))`,
    );
    const [target] = await tx
      .select({
        displayName: accounts.displayName,
        id: accounts.id,
        status: accounts.status,
      })
      .from(accounts)
      .where(eq(accounts.id, parsed.targetAccountId))
      .for("update")
      .limit(1);
    if (!target) {
      throw new AdminUserEntitlementError("target_account_not_found");
    }
    if (target.status !== "active") {
      throw new AdminUserEntitlementError("target_account_not_active");
    }

    const previousState = await readEntitlementState(tx, target.id, now);
    if (parsed.action === "set_member") {
      await ensurePermanentMemberEntitlement(tx, {
        accountId: target.id,
        now,
        source: "admin_grant",
      });
      await tx
        .update(filterProfiles)
        .set({ active: false, revokedAt: now, updatedAt: now })
        .where(
          and(
            eq(filterProfiles.accountId, target.id),
            eq(filterProfiles.active, true),
            isNull(filterProfiles.revokedAt),
          ),
        );
    } else if (parsed.action === "set_filter") {
      await ensurePermanentMemberEntitlement(tx, {
        accountId: target.id,
        now,
        source: "filter_grant",
      });
      await tx
        .insert(filterProfiles)
        .values({
          accountId: target.id,
          active: true,
          displayName: target.displayName,
          invitedAt: now,
          revokedAt: null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: filterProfiles.accountId,
          set: {
            active: true,
            displayName: target.displayName,
            revokedAt: null,
            updatedAt: now,
          },
        });
    } else {
      await tx
        .update(filterProfiles)
        .set({ active: false, revokedAt: now, updatedAt: now })
        .where(
          and(
            eq(filterProfiles.accountId, target.id),
            eq(filterProfiles.active, true),
            isNull(filterProfiles.revokedAt),
          ),
        );
    }

    const nextState = await readEntitlementState(tx, target.id, now);
    const [audit] = await tx
      .insert(adminEntitlementAudits)
      .values({
        action: parsed.action,
        actorAccountId: actor.accountId,
        nextState,
        occurredAt: now,
        previousState,
        reason: parsed.reason,
        requestId: parsed.requestId,
        source: parsed.source,
        targetAccountId: target.id,
      })
      .returning({ id: adminEntitlementAudits.id });
    if (!audit) throw new Error("admin_entitlement_audit_insert_failed");

    return {
      action: parsed.action,
      auditId: audit.id,
      nextState,
      previousState,
      targetAccountId: target.id,
    };
  });
}

export async function listAdminEntitlementAudits(
  db: AttentionDatabase,
  principal: SessionPrincipal | null,
  targetAccountId: string,
  requestedLimit = 50,
): Promise<AdminEntitlementAuditRecord[]> {
  requireAdminPrincipal(principal);
  const parsedTargetAccountId = z.string().uuid().parse(targetAccountId);
  const limit = z.number().int().min(1).max(100).parse(requestedLimit);
  const [target] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.id, parsedTargetAccountId))
    .limit(1);
  if (!target) throw new AdminUserEntitlementError("target_account_not_found");

  const rows = await db
    .select({
      action: adminEntitlementAudits.action,
      actorAccountId: adminEntitlementAudits.actorAccountId,
      id: adminEntitlementAudits.id,
      nextState: adminEntitlementAudits.nextState,
      occurredAt: adminEntitlementAudits.occurredAt,
      previousState: adminEntitlementAudits.previousState,
      reason: adminEntitlementAudits.reason,
      requestId: adminEntitlementAudits.requestId,
      source: adminEntitlementAudits.source,
      targetAccountId: adminEntitlementAudits.targetAccountId,
    })
    .from(adminEntitlementAudits)
    .where(eq(adminEntitlementAudits.targetAccountId, parsedTargetAccountId))
    .orderBy(desc(adminEntitlementAudits.occurredAt), desc(adminEntitlementAudits.id))
    .limit(limit);
  if (rows.length === 0) return [];

  const actorIds = [...new Set(rows.map((row) => row.actorAccountId))];
  const actors = await db
    .select({
      accountId: accounts.id,
      displayName: accounts.displayName,
      primaryEmail: accounts.primaryEmail,
    })
    .from(accounts)
    .where(inArray(accounts.id, actorIds));
  const actorById = new Map(actors.map((actor) => [actor.accountId, actor]));

  return rows.map((row) => {
    const actor = actorById.get(row.actorAccountId);
    if (!actor) throw new Error("admin_entitlement_audit_actor_not_found");
    if (
      row.action !== "set_member" &&
      row.action !== "set_filter" &&
      row.action !== "revoke_filter"
    ) {
      throw new Error("admin_entitlement_audit_action_invalid");
    }
    return {
      action: row.action,
      actor,
      id: row.id,
      nextState: row.nextState,
      occurredAt: row.occurredAt,
      previousState: row.previousState,
      reason: row.reason,
      requestId: row.requestId,
      source: row.source,
      targetAccountId: row.targetAccountId,
    };
  });
}
