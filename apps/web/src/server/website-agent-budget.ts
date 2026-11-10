import "server-only";

import { createHmac } from "node:crypto";

import { and, eq, sql, setAccountContext, websiteAgentRuns, websiteAgentSessions, type AttentionDatabase, type AttentionTransaction } from "@attention/db";

export class WebsiteAgentAdmissionError extends Error {
  constructor(readonly code: "operation_already_used" | "operation_payload_mismatch" | "website_agent_busy" | "website_agent_daily_budget_exhausted") {
    super(code);
    this.name = "WebsiteAgentAdmissionError";
  }
}

export function websiteAgentRequestFingerprint(input: { query: string; collect: boolean; readSources: boolean; sessionId?: string; expectedRevision?: number }): string {
  const secret = process.env.ATTENTION_HMAC_SECRET?.trim();
  if (!secret || secret.length < 32) throw new Error("website_agent_hmac_unavailable");
  return createHmac("sha256", secret).update("attention:website-agent-request:v1\0").update(JSON.stringify(input)).digest("hex");
}

/**
 * Reserve the entire maximum before any provider call. Reservations are never
 * refunded, including timeout/unknown outcomes. This deliberately overcounts.
 * The lock and daily sum are shared across processes and replicas, not memory.
 */
export interface WebsiteAgentRunReservationInput {
  accountId: string;
  operationId: string;
  requestFingerprint: string;
  maxRunCostMicrousd: number;
  dailyCostMicrousd: number | null;
  timeoutMs: number;
  sessionId?: string;
}

export async function lockWebsiteAgentAccount(tx: AttentionTransaction, accountId: string): Promise<void> {
  await setAccountContext(tx, accountId);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('attention:website-agent:v1'), hashtext(${accountId}))`);
}

/** The account lock must be held. Model runs and reviewed actions share one lane. */
export async function assertWebsiteAgentAccountIdle(tx: AttentionTransaction, accountId: string): Promise<void> {
  const [row] = await tx.execute<{ busy: boolean }>(sql`SELECT (
    EXISTS (SELECT 1 FROM ${websiteAgentRuns} WHERE ${websiteAgentRuns.accountId} = ${accountId}
      AND ${websiteAgentRuns.outcome} = 'reserved' AND ${websiteAgentRuns.deadline} > clock_timestamp())
    OR EXISTS (SELECT 1 FROM ${websiteAgentSessions} WHERE ${websiteAgentSessions.accountId} = ${accountId}
      AND ${websiteAgentSessions.activeRunId} IS NOT NULL AND ${websiteAgentSessions.activeRunDeadline} > clock_timestamp())
  ) AS busy`);
  if (!row || typeof row.busy !== "boolean") throw new Error("website_agent_admission_unavailable");
  if (row.busy) throw new WebsiteAgentAdmissionError("website_agent_busy");
}

export function validateWebsiteAgentRunReservation(input: WebsiteAgentRunReservationInput): void {
  if (![input.maxRunCostMicrousd, input.timeoutMs].every(value => Number.isSafeInteger(value) && value > 0) ||
      input.maxRunCostMicrousd > 100_000_000 ||
      (input.dailyCostMicrousd !== null && (!Number.isSafeInteger(input.dailyCostMicrousd) || input.dailyCostMicrousd < input.maxRunCostMicrousd)) ||
      input.timeoutMs > 120_000) throw new RangeError("invalid_website_agent_budget");
}

/** Caller must hold lockWebsiteAgentAccount in this same transaction. */
export async function reserveWebsiteAgentRunInTransaction(tx: AttentionTransaction, input: WebsiteAgentRunReservationInput): Promise<string> {
  validateWebsiteAgentRunReservation(input);
  const [existing] = await tx.select({ fingerprint: websiteAgentRuns.requestFingerprint }).from(websiteAgentRuns).where(and(
    eq(websiteAgentRuns.accountId, input.accountId), eq(websiteAgentRuns.operationId, input.operationId),
  )).limit(1);
  if (existing) throw new WebsiteAgentAdmissionError(existing.fingerprint === input.requestFingerprint ? "operation_already_used" : "operation_payload_mismatch");
  const [active] = await tx.select({ id: websiteAgentRuns.id }).from(websiteAgentRuns).where(and(
    eq(websiteAgentRuns.accountId, input.accountId), eq(websiteAgentRuns.outcome, "reserved"),
    sql`${websiteAgentRuns.deadline} > clock_timestamp()`,
  )).limit(1);
  if (active) throw new WebsiteAgentAdmissionError("website_agent_busy");
  await assertWebsiteAgentAccountIdle(tx, input.accountId);
  const [usage] = await tx.select({ total: sql<string>`coalesce(sum(${websiteAgentRuns.reservedCostMicrousd}), 0)::text` })
    .from(websiteAgentRuns).where(and(eq(websiteAgentRuns.accountId, input.accountId),
      sql`${websiteAgentRuns.budgetDate} = (clock_timestamp() AT TIME ZONE 'UTC')::date`));
  const used = Number(usage?.total ?? 0);
  if (!Number.isSafeInteger(used) || used < 0 || (input.dailyCostMicrousd !== null && used + input.maxRunCostMicrousd > input.dailyCostMicrousd)) {
    throw new WebsiteAgentAdmissionError("website_agent_daily_budget_exhausted");
  }
  const [reservation] = await tx.insert(websiteAgentRuns).values({
    accountId: input.accountId,
    sessionId: input.sessionId ?? null,
    operationId: input.operationId,
    requestFingerprint: input.requestFingerprint,
    reservedCostMicrousd: input.maxRunCostMicrousd,
    budgetDate: sql`(clock_timestamp() AT TIME ZONE 'UTC')::date`,
    deadline: sql`clock_timestamp() + ${input.timeoutMs} * interval '1 millisecond'`,
  }).returning({ id: websiteAgentRuns.id });
  if (!reservation) throw new Error("website_agent_reservation_missing");
  return reservation.id;
}

export async function reserveWebsiteAgentRun(db: AttentionDatabase, input: WebsiteAgentRunReservationInput): Promise<string> {
  validateWebsiteAgentRunReservation(input);
  return db.transaction(async tx => {
    await lockWebsiteAgentAccount(tx, input.accountId);
    return reserveWebsiteAgentRunInTransaction(tx, input);
  });
}

export async function finishWebsiteAgentRun(db: AttentionDatabase, accountId: string, runId: string,
  outcome: "completed" | "failed" | "cancelled"): Promise<void> {
  await db.transaction(async tx => {
    await setAccountContext(tx, accountId);
    await tx.update(websiteAgentRuns).set({ outcome, finishedAt: sql`clock_timestamp()` }).where(and(
      eq(websiteAgentRuns.accountId, accountId), eq(websiteAgentRuns.id, runId), eq(websiteAgentRuns.outcome, "reserved"),
    ));
  });
}
