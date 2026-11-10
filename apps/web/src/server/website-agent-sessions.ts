import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";

import { and, desc, eq, isNull, sql, setAccountContext, websiteAgentRuns, websiteAgentSessions,
  type AttentionDatabase, type AttentionTransaction } from "@attention/db";
import { appendInterruptedNativeWebsiteSession, assertNativeWebsiteSessionContinuation, createNativeWebsiteSession,
  parseNativeWebsiteSession, websiteAgentSessionMessages, type NativeWebsiteAgentSession } from "@attention/website-agent";

import { lockWebsiteAgentAccount, reserveWebsiteAgentRunInTransaction, validateWebsiteAgentRunReservation,
  type WebsiteAgentRunReservationInput } from "./website-agent-budget";

export const WEBSITE_AGENT_SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
export const WEBSITE_AGENT_INTERRUPTED_ANSWER = "This turn did not finish. No automatic retry was made. An earlier tool action may have completed; check its current status before requesting another action.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_CIPHERTEXT_BYTES = 1_048_576;
const MAX_PLAINTEXT_BYTES = 600_000;

type SessionRow = typeof websiteAgentSessions.$inferSelect;
type SessionMetadata = Pick<SessionRow, "id" | "revision" | "closedAt" | "expiresAt" | "createdAt" | "updatedAt">;
export type WebsiteAgentSessionErrorCode = "session_not_found" | "session_closed" | "session_expired" | "session_conflict" | "session_full" | "session_unavailable";
export class WebsiteAgentSessionError extends Error {
  constructor(readonly code: WebsiteAgentSessionErrorCode) {
    super(code);
    this.name = "WebsiteAgentSessionError";
  }
}

export interface WebsiteAgentPendingTurn { query: string; runId: string; deadline: string }
export interface WebsiteAgentSessionState {
  version: 1;
  nativeSession: NativeWebsiteAgentSession;
  pending: WebsiteAgentPendingTurn | null;
}
export interface WebsiteAgentSessionSummary {
  id: string;
  revision: number;
  status: "open" | "closed" | "expired";
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}
export interface WebsiteAgentSessionView extends WebsiteAgentSessionSummary {
  messages: Array<{ role: "user" | "assistant"; text: string }>;
  pending: WebsiteAgentPendingTurn | null;
}
export interface WebsiteAgentTurnIdentity {
  accountId: string;
  sessionId: string;
  runId: string;
  revision: number;
}
export interface WebsiteAgentStartedTurn extends WebsiteAgentTurnIdentity { nativeSession: NativeWebsiteAgentSession }

function unavailable(): never { throw new WebsiteAgentSessionError("session_unavailable"); }
function validRevision(value: number): boolean { return Number.isSafeInteger(value) && value >= 0 && value < 2_147_483_646; }
function assertOwnerKey(accountId: string, sessionId?: string): void {
  if (!UUID.test(accountId) || (sessionId !== undefined && !UUID.test(sessionId))) {
    throw new WebsiteAgentSessionError("session_not_found");
  }
}
function validQuery(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= 4_000 && Buffer.byteLength(value, "utf8") <= 16_000;
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
function parseState(value: unknown, sessionId: string): WebsiteAgentSessionState {
  try {
    if (!object(value) || !exactKeys(value, ["version", "nativeSession", "pending"]) || value.version !== 1) return unavailable();
    const nativeSession = parseNativeWebsiteSession(value.nativeSession, sessionId);
    let pending: WebsiteAgentPendingTurn | null = null;
    if (value.pending !== null) {
      const candidate = value.pending;
      if (!object(candidate) || !exactKeys(candidate, ["query", "runId", "deadline"]) || !validQuery(candidate.query) ||
        typeof candidate.runId !== "string" || !UUID.test(candidate.runId) || typeof candidate.deadline !== "string" ||
        !Number.isFinite(Date.parse(candidate.deadline)) || new Date(candidate.deadline).toISOString() !== candidate.deadline) return unavailable();
      pending = { query: candidate.query, runId: candidate.runId, deadline: candidate.deadline };
    }
    return { version: 1, nativeSession, pending };
  } catch { return unavailable(); }
}
function encryptionKey(): Buffer {
  const secret = process.env.ATTENTION_WEBSITE_AGENT_SESSION_SECRET?.trim();
  if (!secret || secret.length < 32 || [process.env.ATTENTION_HMAC_SECRET, process.env.ATTENTION_AUTH_SECRET,
    process.env.ATTENTION_WEBSITE_AGENT_DEEPSEEK_API_KEY].some(other => secret === other?.trim())) return unavailable();
  return createHash("sha256").update("attention:website-agent-session:key:v1\0").update(secret).digest();
}
function aad(input: { accountId: string; sessionId: string; revision: number }): Buffer {
  assertOwnerKey(input.accountId, input.sessionId);
  if (!validRevision(input.revision)) return unavailable();
  return Buffer.from(JSON.stringify(["attention:website-agent-session:v1", input.accountId, input.sessionId, input.revision]));
}

/** Versioned authenticated encryption; no environment secret is read at module initialization. */
export function encryptWebsiteAgentSessionState(input: {
  accountId: string; sessionId: string; revision: number; state: WebsiteAgentSessionState;
}): string {
  const plaintext = Buffer.from(JSON.stringify(parseState(input.state, input.sessionId)));
  if (plaintext.length > MAX_PLAINTEXT_BYTES) return unavailable();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), nonce);
  cipher.setAAD(aad(input));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const encoded = ["v1", nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
  if (Buffer.byteLength(encoded) > MAX_CIPHERTEXT_BYTES) return unavailable();
  return encoded;
}
export function decryptWebsiteAgentSessionState(input: {
  accountId: string; sessionId: string; revision: number; encryptedState: string;
}): WebsiteAgentSessionState {
  try {
    if (typeof input.encryptedState !== "string" || Buffer.byteLength(input.encryptedState) > MAX_CIPHERTEXT_BYTES) return unavailable();
    const parts = input.encryptedState.split(".");
    if (parts.length !== 4 || parts[0] !== "v1" || parts.slice(1).some(part => !/^[A-Za-z0-9_-]+$/u.test(part))) return unavailable();
    const nonce = Buffer.from(parts[1]!, "base64url");
    const tag = Buffer.from(parts[2]!, "base64url");
    const ciphertext = Buffer.from(parts[3]!, "base64url");
    if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length > MAX_PLAINTEXT_BYTES ||
      [nonce, tag, ciphertext].some((part, index) => part.toString("base64url") !== parts[index + 1])) return unavailable();
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), nonce);
    decipher.setAAD(aad(input));
    decipher.setAuthTag(tag);
    return parseState(JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")), input.sessionId);
  } catch { return unavailable(); }
}

async function databaseNow(tx: AttentionTransaction): Promise<Date> {
  const [row] = await tx.execute<{ now: string }>(sql`SELECT clock_timestamp()::text AS now`);
  const now = new Date(row?.now ?? "");
  if (!Number.isFinite(now.getTime())) return unavailable();
  return now;
}
async function findSession(tx: AttentionTransaction, accountId: string, sessionId: string): Promise<SessionRow> {
  const [row] = await tx.select().from(websiteAgentSessions).where(and(
    eq(websiteAgentSessions.accountId, accountId), eq(websiteAgentSessions.id, sessionId),
  )).limit(1);
  if (!row) throw new WebsiteAgentSessionError("session_not_found");
  return row;
}
function summary(row: SessionMetadata, now: Date): WebsiteAgentSessionSummary {
  return { id: row.id, revision: row.revision, status: row.closedAt ? "closed" : row.expiresAt <= now ? "expired" : "open",
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), expiresAt: row.expiresAt.toISOString() };
}
function stateFor(row: SessionRow): WebsiteAgentSessionState {
  const state = decryptWebsiteAgentSessionState({ accountId: row.accountId, sessionId: row.id, revision: row.revision, encryptedState: row.encryptedState });
  if (state.pending?.runId !== (row.activeRunId ?? undefined) || state.pending?.deadline !== (row.activeRunDeadline?.toISOString() ?? undefined)) return unavailable();
  return state;
}
function view(row: SessionRow, state: WebsiteAgentSessionState, now: Date): WebsiteAgentSessionView {
  return { ...summary(row, now), messages: websiteAgentSessionMessages(state.nativeSession), pending: state.pending };
}
function assertOpen(row: SessionRow, expectedRevision: number, now: Date): void {
  if (row.closedAt) throw new WebsiteAgentSessionError("session_closed");
  if (row.expiresAt <= now) throw new WebsiteAgentSessionError("session_expired");
  if (!validRevision(expectedRevision) || row.revision !== expectedRevision) throw new WebsiteAgentSessionError("session_conflict");
}
async function finishReservation(tx: AttentionTransaction, identity: WebsiteAgentTurnIdentity, outcome: "completed" | "failed" | "cancelled"): Promise<void> {
  await tx.update(websiteAgentRuns).set({ outcome, finishedAt: sql`clock_timestamp()` }).where(and(
    eq(websiteAgentRuns.accountId, identity.accountId), eq(websiteAgentRuns.sessionId, identity.sessionId),
    eq(websiteAgentRuns.id, identity.runId), eq(websiteAgentRuns.outcome, "reserved"),
  ));
}
async function replaceState(tx: AttentionTransaction, row: SessionRow, state: WebsiteAgentSessionState, now: Date,
  changes: { closedAt?: Date; expiresAt?: Date } = {}): Promise<SessionRow> {
  const revision = row.revision + 1;
  const [updated] = await tx.update(websiteAgentSessions).set({
    revision, encryptedState: encryptWebsiteAgentSessionState({ accountId: row.accountId, sessionId: row.id, revision, state }),
    activeRunId: state.pending?.runId ?? null, activeRunDeadline: state.pending ? new Date(state.pending.deadline) : null,
    updatedAt: now, ...changes,
  }).where(and(eq(websiteAgentSessions.accountId, row.accountId), eq(websiteAgentSessions.id, row.id),
    eq(websiteAgentSessions.revision, row.revision),
    row.activeRunId ? eq(websiteAgentSessions.activeRunId, row.activeRunId) : isNull(websiteAgentSessions.activeRunId),
    row.closedAt ? eq(websiteAgentSessions.closedAt, row.closedAt) : isNull(websiteAgentSessions.closedAt),
  )).returning();
  if (!updated) throw new WebsiteAgentSessionError("session_conflict");
  return updated;
}

export async function createWebsiteAgentSession(db: AttentionDatabase, accountId: string): Promise<WebsiteAgentSessionView> {
  assertOwnerKey(accountId);
  return db.transaction(async tx => {
    await lockWebsiteAgentAccount(tx, accountId);
    const now = await databaseNow(tx);
    const id = randomUUID();
    const state: WebsiteAgentSessionState = { version: 1, nativeSession: createNativeWebsiteSession(id), pending: null };
    const [row] = await tx.insert(websiteAgentSessions).values({
      id, accountId, revision: 0, createdAt: now, updatedAt: now, expiresAt: new Date(now.getTime() + WEBSITE_AGENT_SESSION_IDLE_MS),
      encryptedState: encryptWebsiteAgentSessionState({ accountId, sessionId: id, revision: 0, state }),
    }).returning();
    if (!row) return unavailable();
    return view(row, state, now);
  });
}
export async function listWebsiteAgentSessions(db: AttentionDatabase, accountId: string): Promise<WebsiteAgentSessionSummary[]> {
  assertOwnerKey(accountId);
  return db.transaction(async tx => {
    await setAccountContext(tx, accountId);
    const now = await databaseNow(tx);
    const rows = await tx.select({ id: websiteAgentSessions.id, revision: websiteAgentSessions.revision,
      closedAt: websiteAgentSessions.closedAt, expiresAt: websiteAgentSessions.expiresAt,
      createdAt: websiteAgentSessions.createdAt, updatedAt: websiteAgentSessions.updatedAt,
    }).from(websiteAgentSessions).where(eq(websiteAgentSessions.accountId, accountId))
      .orderBy(desc(websiteAgentSessions.updatedAt)).limit(50);
    return rows.map(row => summary(row, now));
  });
}

/** Read/reload never starts a model call. An expired lease is reconciled once with a factual local answer. */
export async function loadWebsiteAgentSession(db: AttentionDatabase, accountId: string, sessionId: string): Promise<WebsiteAgentSessionView> {
  assertOwnerKey(accountId, sessionId);
  return db.transaction(async tx => {
    await lockWebsiteAgentAccount(tx, accountId);
    const now = await databaseNow(tx);
    let row = await findSession(tx, accountId, sessionId);
    let state = stateFor(row);
    if (state.pending && (row.activeRunDeadline! <= now || row.expiresAt <= now || row.closedAt)) {
      const identity = { accountId, sessionId, runId: state.pending.runId, revision: row.revision };
      state = { version: 1, nativeSession: appendInterruptedNativeWebsiteSession(state.nativeSession, state.pending.query, WEBSITE_AGENT_INTERRUPTED_ANSWER), pending: null };
      row = await replaceState(tx, row, state, now);
      await finishReservation(tx, identity, "failed");
    }
    return view(row, state, now);
  });
}
export async function closeWebsiteAgentSession(db: AttentionDatabase, input: {
  accountId: string; sessionId: string; expectedRevision: number;
}): Promise<WebsiteAgentSessionView> {
  assertOwnerKey(input.accountId, input.sessionId);
  return db.transaction(async tx => {
    await lockWebsiteAgentAccount(tx, input.accountId);
    const now = await databaseNow(tx);
    const row = await findSession(tx, input.accountId, input.sessionId);
    if (!validRevision(input.expectedRevision) || row.revision !== input.expectedRevision) throw new WebsiteAgentSessionError("session_conflict");
    const state = stateFor(row);
    if (row.closedAt) return view(row, state, now);
    const closed: WebsiteAgentSessionState = { version: 1, nativeSession: state.pending
      ? appendInterruptedNativeWebsiteSession(state.nativeSession, state.pending.query, WEBSITE_AGENT_INTERRUPTED_ANSWER) : state.nativeSession, pending: null };
    const updated = await replaceState(tx, row, closed, now, { closedAt: now });
    if (state.pending) await finishReservation(tx, { ...input, runId: state.pending.runId, revision: row.revision }, "cancelled");
    return view(updated, closed, now);
  });
}
export async function beginWebsiteAgentTurn(db: AttentionDatabase, input: WebsiteAgentRunReservationInput & {
  sessionId: string; expectedRevision: number; query: string;
}): Promise<WebsiteAgentStartedTurn> {
  assertOwnerKey(input.accountId, input.sessionId);
  if (!validQuery(input.query)) return unavailable();
  validateWebsiteAgentRunReservation(input);
  return db.transaction(async tx => {
    await lockWebsiteAgentAccount(tx, input.accountId);
    const now = await databaseNow(tx);
    const row = await findSession(tx, input.accountId, input.sessionId);
    assertOpen(row, input.expectedRevision, now);
    const state = stateFor(row);
    // Require a reload to acknowledge interrupted state. Never silently retry or discard pending input.
    if (state.pending) throw new WebsiteAgentSessionError("session_conflict");
    // Reserve room for a factual interruption before spending money. Native session
    // archives are append-only; a full session must be explicitly replaced, never trimmed.
    try { appendInterruptedNativeWebsiteSession(state.nativeSession, input.query, WEBSITE_AGENT_INTERRUPTED_ANSWER); }
    catch (error) {
      if (object(error) && error.code === "session_full") throw new WebsiteAgentSessionError("session_full");
      return unavailable();
    }
    const runId = await reserveWebsiteAgentRunInTransaction(tx, input);
    const [run] = await tx.select({ deadline: websiteAgentRuns.deadline }).from(websiteAgentRuns).where(and(
      eq(websiteAgentRuns.accountId, input.accountId), eq(websiteAgentRuns.sessionId, input.sessionId), eq(websiteAgentRuns.id, runId),
    )).limit(1);
    if (!run) return unavailable();
    const pending = { query: input.query, runId, deadline: run.deadline.toISOString() };
    const updated = await replaceState(tx, row, { ...state, pending }, now, { expiresAt: new Date(now.getTime() + WEBSITE_AGENT_SESSION_IDLE_MS) });
    return { accountId: input.accountId, sessionId: input.sessionId, runId, revision: updated.revision, nativeSession: state.nativeSession };
  });
}

/** Every model/tool/source operation must revalidate this fixed, server-created identity. */
export async function isWebsiteAgentTurnActive(db: AttentionDatabase, input: WebsiteAgentTurnIdentity): Promise<boolean> {
  if (!UUID.test(input.accountId) || !UUID.test(input.sessionId) || !UUID.test(input.runId) || !validRevision(input.revision)) return false;
  return db.transaction(async tx => {
    await setAccountContext(tx, input.accountId);
    const [row] = await tx.select({ id: websiteAgentSessions.id }).from(websiteAgentSessions)
      .innerJoin(websiteAgentRuns, and(eq(websiteAgentRuns.id, websiteAgentSessions.activeRunId),
        eq(websiteAgentRuns.accountId, websiteAgentSessions.accountId), eq(websiteAgentRuns.sessionId, websiteAgentSessions.id)))
      .where(and(eq(websiteAgentSessions.accountId, input.accountId), eq(websiteAgentSessions.id, input.sessionId),
        eq(websiteAgentSessions.revision, input.revision), eq(websiteAgentSessions.activeRunId, input.runId),
        isNull(websiteAgentSessions.closedAt), sql`${websiteAgentSessions.expiresAt} > clock_timestamp()`,
        sql`${websiteAgentSessions.activeRunDeadline} > clock_timestamp()`, eq(websiteAgentRuns.outcome, "reserved"),
        sql`${websiteAgentRuns.deadline} > clock_timestamp()`)).limit(1);
    return Boolean(row);
  });
}
export async function finishWebsiteAgentTurn(db: AttentionDatabase, input: WebsiteAgentTurnIdentity & {
  outcome: "completed" | "failed" | "cancelled"; nativeSession?: NativeWebsiteAgentSession; answer?: string;
}): Promise<WebsiteAgentSessionView | null> {
  assertOwnerKey(input.accountId, input.sessionId);
  return db.transaction(async tx => {
    await lockWebsiteAgentAccount(tx, input.accountId);
    const now = await databaseNow(tx);
    const row = await findSession(tx, input.accountId, input.sessionId);
    if (row.closedAt || row.revision !== input.revision || row.activeRunId !== input.runId) return null;
    const state = stateFor(row);
    if (!state.pending) return null;
    const [run] = await tx.select({ outcome: websiteAgentRuns.outcome, deadline: websiteAgentRuns.deadline }).from(websiteAgentRuns)
      .where(and(eq(websiteAgentRuns.accountId, input.accountId), eq(websiteAgentRuns.sessionId, input.sessionId), eq(websiteAgentRuns.id, input.runId))).limit(1);
    if (!run || run.outcome !== "reserved") return null;
    const expired = row.expiresAt <= now || row.activeRunDeadline! <= now || run.deadline <= now;
    // Completion after the deadline is not a successful answer, even if the provider returned one.
    const outcome = expired ? "failed" : input.outcome;
    let nativeSession: NativeWebsiteAgentSession;
    if (outcome === "completed") {
      try {
        nativeSession = parseNativeWebsiteSession(input.nativeSession, input.sessionId);
        assertNativeWebsiteSessionContinuation(state.nativeSession, nativeSession, state.pending.query, input.answer);
      } catch { return unavailable(); }
    } else {
      nativeSession = appendInterruptedNativeWebsiteSession(state.nativeSession, state.pending.query, WEBSITE_AGENT_INTERRUPTED_ANSWER);
    }
    const finished: WebsiteAgentSessionState = { version: 1, nativeSession, pending: null };
    const updated = await replaceState(tx, row, finished, now, expired ? {} : { expiresAt: new Date(now.getTime() + WEBSITE_AGENT_SESSION_IDLE_MS) });
    await finishReservation(tx, input, outcome);
    return expired ? null : view(updated, finished, now);
  });
}
