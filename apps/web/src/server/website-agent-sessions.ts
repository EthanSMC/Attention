import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";

import { and, desc, eq, isNull, sql, setAccountContext, websiteAgentRuns, websiteAgentSessions,
  type AttentionDatabase, type AttentionTransaction } from "@attention/db";
import { appendInterruptedNativeWebsiteSession, assertNativeWebsiteSessionContinuation, createNativeWebsiteSession,
  parseNativeWebsiteSession, websiteAgentSessionMessages, type NativeWebsiteAgentSession } from "@attention/website-agent";

import { parseWebsiteAgentActionProposal, type WebsiteAgentActionProposal } from "./website-agent-action-policy";

import { assertWebsiteAgentAccountIdle, lockWebsiteAgentAccount, reserveWebsiteAgentRunInTransaction, validateWebsiteAgentRunReservation,
  type WebsiteAgentRunReservationInput } from "./website-agent-budget";
import { appendWebsiteAgentActions, cancelPendingWebsiteAgentActions, parseStoredWebsiteAgentActions,
  settleWebsiteAgentActions, websiteAgentActionViews, WEBSITE_AGENT_ACTION_LEASE_MS,
  pendingWebsiteAgentAction, storedWebsiteAgentActionProposal, type StoredWebsiteAgentAction, type WebsiteAgentActionView } from "./website-agent-action-state";

export const WEBSITE_AGENT_SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
export const WEBSITE_AGENT_INTERRUPTED_ANSWER = "This turn did not finish. No automatic retry was made. An earlier tool action may have completed; check its current status before requesting another action.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_CIPHERTEXT_BYTES = 1_048_576;
const MAX_PLAINTEXT_BYTES = 600_000;

type SessionRow = typeof websiteAgentSessions.$inferSelect;
type SessionMetadata = Pick<SessionRow, "id" | "revision" | "closedAt" | "expiresAt" | "createdAt" | "updatedAt">;
export type WebsiteAgentSessionErrorCode = "session_not_found" | "session_closed" | "session_expired" | "session_conflict" | "session_full" | "session_unavailable" | "action_not_found" | "action_expired" | "action_authentication_changed" | "candidate_selection_required";
export class WebsiteAgentSessionError extends Error {
  constructor(readonly code: WebsiteAgentSessionErrorCode) {
    super(code);
    this.name = "WebsiteAgentSessionError";
  }
}

export interface WebsiteAgentPendingTurn { query: string; runId: string; deadline: string }
interface WebsiteAgentSessionStateBase {
  nativeSession: NativeWebsiteAgentSession;
  pending: WebsiteAgentPendingTurn | null;
}
export type WebsiteAgentSessionState = WebsiteAgentSessionStateBase &
  ({ version: 1 } | { version: 2; actions: StoredWebsiteAgentAction[] });
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
  actions?: WebsiteAgentActionView[];
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
function parseState(value: unknown, sessionId: string, accountId: string): WebsiteAgentSessionState {
  try {
    if (!object(value) || (value.version !== 1 && value.version !== 2) ||
        !exactKeys(value, value.version === 1 ? ["version", "nativeSession", "pending"] : ["version", "nativeSession", "pending", "actions"])) return unavailable();
    const nativeSession = parseNativeWebsiteSession(value.nativeSession, sessionId);
    let pending: WebsiteAgentPendingTurn | null = null;
    if (value.pending !== null) {
      const candidate = value.pending;
      if (!object(candidate) || !exactKeys(candidate, ["query", "runId", "deadline"]) || !validQuery(candidate.query) ||
        typeof candidate.runId !== "string" || !UUID.test(candidate.runId) || typeof candidate.deadline !== "string" ||
        !Number.isFinite(Date.parse(candidate.deadline)) || new Date(candidate.deadline).toISOString() !== candidate.deadline) return unavailable();
      pending = { query: candidate.query, runId: candidate.runId, deadline: candidate.deadline };
    }
    if (value.version === 2 && parseStoredWebsiteAgentActions(value.actions).some(action => action.prepared?.kind === "enrichment" &&
        (action.prepared.evidence.sessionId !== sessionId || action.prepared.evidence.accountId !== accountId))) return unavailable();
    return value.version === 1 ? { version: 1, nativeSession, pending }
      : { version: 2, nativeSession, pending, actions: parseStoredWebsiteAgentActions(value.actions) };
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
  const plaintext = Buffer.from(JSON.stringify(parseState(input.state, input.sessionId, input.accountId)));
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
    return parseState(JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")), input.sessionId, input.accountId);
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
  const executing = actionsFor(state).find(action => action.status === "executing");
  if (state.pending && executing) return unavailable();
  const activeId = state.pending?.runId ?? executing?.claimId ?? undefined;
  const deadline = state.pending?.deadline ?? executing?.deadline ?? undefined;
  if (activeId !== (row.activeRunId ?? undefined) || deadline !== (row.activeRunDeadline?.toISOString() ?? undefined)) return unavailable();
  return state;
}
function actionsFor(state: WebsiteAgentSessionState): StoredWebsiteAgentAction[] { return state.version === 2 ? state.actions : []; }
function withActions(state: WebsiteAgentSessionState, actions: StoredWebsiteAgentAction[]): WebsiteAgentSessionState {
  return state.version === 2 || actions.length ? { ...state, version: 2, actions } : state;
}
function view(row: SessionRow, state: WebsiteAgentSessionState, now: Date): WebsiteAgentSessionView {
  return { ...summary(row, now), messages: websiteAgentSessionMessages(state.nativeSession), pending: state.pending,
    ...(state.version === 2 ? { actions: websiteAgentActionViews(state.actions, now) } : {}) };
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
  changes: { closedAt?: Date; expiresAt?: Date } = {}, commitDeadline?: Date): Promise<SessionRow> {
  const revision = row.revision + 1;
  const executing = actionsFor(state).find(action => action.status === "executing");
  if (state.pending && executing) return unavailable();
  const [updated] = await tx.update(websiteAgentSessions).set({
    revision, encryptedState: encryptWebsiteAgentSessionState({ accountId: row.accountId, sessionId: row.id, revision, state }),
    activeRunId: state.pending?.runId ?? executing?.claimId ?? null,
    activeRunDeadline: state.pending ? new Date(state.pending.deadline) : executing?.deadline ? new Date(executing.deadline) : null,
    updatedAt: now, ...changes,
  }).where(and(eq(websiteAgentSessions.accountId, row.accountId), eq(websiteAgentSessions.id, row.id),
    eq(websiteAgentSessions.revision, row.revision),
    row.activeRunId ? eq(websiteAgentSessions.activeRunId, row.activeRunId) : isNull(websiteAgentSessions.activeRunId),
    row.closedAt ? eq(websiteAgentSessions.closedAt, row.closedAt) : isNull(websiteAgentSessions.closedAt),
    ...(commitDeadline ? [sql`clock_timestamp() < ${commitDeadline.toISOString()}::timestamptz`] : []),
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
      state = { ...state, nativeSession: appendInterruptedNativeWebsiteSession(state.nativeSession, state.pending.query, WEBSITE_AGENT_INTERRUPTED_ANSWER), pending: null };
      row = await replaceState(tx, row, state, now);
      await finishReservation(tx, identity, "failed");
    }
    const settled = settleWebsiteAgentActions(actionsFor(state), now, Boolean(row.closedAt || row.expiresAt <= now));
    if (JSON.stringify(settled) !== JSON.stringify(actionsFor(state))) {
      state = withActions(state, settled);
      row = await replaceState(tx, row, state, now);
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
    const closed = withActions({ ...state, nativeSession: state.pending
      ? appendInterruptedNativeWebsiteSession(state.nativeSession, state.pending.query, WEBSITE_AGENT_INTERRUPTED_ANSWER) : state.nativeSession, pending: null },
      settleWebsiteAgentActions(actionsFor(state), now, true));
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
    if (state.pending || actionsFor(state).some(action => action.status === "executing")) throw new WebsiteAgentSessionError("session_conflict");
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
    const next = withActions({ ...state, pending }, cancelPendingWebsiteAgentActions(actionsFor(state)));
    const updated = await replaceState(tx, row, next, now, { expiresAt: new Date(now.getTime() + WEBSITE_AGENT_SESSION_IDLE_MS) });
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
  proposedActions?: StoredWebsiteAgentAction[];
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
    const proposed = outcome === "completed" ? parseStoredWebsiteAgentActions(input.proposedActions ?? []) : [];
    if (proposed.some(action => action.originRunId !== input.runId || action.originRevision !== input.revision || action.status !== "pending" ||
        Date.parse(action.createdAt) > now.getTime() + 5_000 || Date.parse(action.expiresAt) <= now.getTime())) return unavailable();
    const finished = withActions({ ...state, nativeSession, pending: null }, appendWebsiteAgentActions(actionsFor(state), proposed));
    const updated = await replaceState(tx, row, finished, now, expired ? {} : { expiresAt: new Date(now.getTime() + WEBSITE_AGENT_SESSION_IDLE_MS) });
    await finishReservation(tx, input, outcome);
    return expired ? null : view(updated, finished, now);
  });
}

export interface WebsiteAgentActionClaim {
  accountId: string; sessionId: string; actionId: string; authSessionId: string;
  claimId: string; revision: number;
}
async function boundActionTransaction(tx: AttentionTransaction): Promise<void> {
  // Transaction-local resource bounds only, never persistent database settings.
  await tx.execute(sql`SELECT set_config('lock_timeout', '5000', true),
    set_config('statement_timeout', '20000', true), set_config('idle_in_transaction_session_timeout', '65000', true)`);
}
export async function claimWebsiteAgentAction(db: AttentionDatabase, input: {
  accountId: string; sessionId: string; actionId: string; authSessionId: string;
  expectedRevision: number; argumentsHash: string;
}): Promise<{ claim: WebsiteAgentActionClaim | null; session: WebsiteAgentSessionView; proposal?: WebsiteAgentActionProposal; origin?: { originRunId: string; originRevision: number } }> {
  assertOwnerKey(input.accountId, input.sessionId);
  if (!UUID.test(input.actionId) || !UUID.test(input.authSessionId) || !/^[a-f0-9]{64}$/u.test(input.argumentsHash)) throw new WebsiteAgentSessionError("action_not_found");
  return db.transaction(async tx => {
    await boundActionTransaction(tx);
    await lockWebsiteAgentAccount(tx, input.accountId);
    const now = await databaseNow(tx);
    const row = await findSession(tx, input.accountId, input.sessionId);
    const state = stateFor(row);
    const action = actionsFor(state).find(item => item.id === input.actionId);
    if (!action || action.argumentsHash !== input.argumentsHash) throw new WebsiteAgentSessionError("action_not_found");
    if (action.authSessionId !== input.authSessionId) throw new WebsiteAgentSessionError("action_authentication_changed");
    // Replayed approval only reads the existing receipt. It never executes again.
    if (action.prepared?.kind === "candidate_options") throw new WebsiteAgentSessionError("candidate_selection_required");
    if (action.status !== "pending") return { claim: null, session: view(row, state, now) };
    assertOpen(row, input.expectedRevision, now);
    if (state.pending || actionsFor(state).some(item => item.status === "executing")) throw new WebsiteAgentSessionError("session_conflict");
    if (Date.parse(action.expiresAt) <= now.getTime()) throw new WebsiteAgentSessionError("action_expired");
    const [run] = await tx.select({ outcome: websiteAgentRuns.outcome }).from(websiteAgentRuns).where(and(
      eq(websiteAgentRuns.id, action.originRunId), eq(websiteAgentRuns.accountId, input.accountId), eq(websiteAgentRuns.sessionId, input.sessionId),
    )).limit(1);
    if (!run || run.outcome !== "completed" || row.revision <= action.originRevision) throw new WebsiteAgentSessionError("session_conflict");
    await assertWebsiteAgentAccountIdle(tx, input.accountId);
    const claimId = randomUUID();
    const deadline = new Date(Math.min(now.getTime() + WEBSITE_AGENT_ACTION_LEASE_MS, Date.parse(action.expiresAt))).toISOString();
    const claimed: StoredWebsiteAgentAction = { ...action, status: "executing", claimId, deadline };
    const next = withActions(state, actionsFor(state).map(item => item.id === action.id ? claimed : item));
    const updated = await replaceState(tx, row, next, now);
    return { claim: { accountId: input.accountId, sessionId: input.sessionId, actionId: action.id,
      authSessionId: input.authSessionId, claimId, revision: updated.revision }, session: view(updated, next, now), proposal: storedWebsiteAgentActionProposal(action),
      origin: { originRunId: action.originRunId, originRevision: action.originRevision } };
  });
}

/** Effects and their receipt must commit in this same transaction; callbacks must never dispatch external effects. */
export async function executeClaimedWebsiteAgentAction<T>(db: AttentionDatabase, claim: WebsiteAgentActionClaim,
  execute: (tx: AttentionTransaction, action: StoredWebsiteAgentAction) => Promise<{ receipt: NonNullable<StoredWebsiteAgentAction["receipt"]>; value: T }>,
): Promise<{ session: WebsiteAgentSessionView; value: T }> {
  assertOwnerKey(claim.accountId, claim.sessionId);
  return db.transaction(async tx => {
    await boundActionTransaction(tx);
    await lockWebsiteAgentAccount(tx, claim.accountId);
    const now = await databaseNow(tx);
    const row = await findSession(tx, claim.accountId, claim.sessionId);
    assertOpen(row, claim.revision, now);
    const state = stateFor(row);
    const action = actionsFor(state).find(item => item.id === claim.actionId);
    if (state.pending || !action || action.status !== "executing" || action.claimId !== claim.claimId ||
        action.authSessionId !== claim.authSessionId || Date.parse(action.deadline!) <= now.getTime() ||
        Date.parse(action.expiresAt) <= now.getTime()) throw new WebsiteAgentSessionError("session_conflict");
    const result = await execute(tx, structuredClone(action));
    const finishedAt = await databaseNow(tx);
    if (Date.parse(action.deadline!) <= finishedAt.getTime() || Date.parse(action.expiresAt) <= finishedAt.getTime()) {
      // Throwing rolls back all DB effects and receipt changes, never a partial success.
      throw new WebsiteAgentSessionError("action_expired");
    }
    const finished: StoredWebsiteAgentAction = { ...action, status: result.receipt.ok ? "completed" : "failed",
      claimId: null, deadline: null, receipt: result.receipt };
    const next = withActions(state, actionsFor(state).map(item => item.id === action.id ? finished : item));
    const updated = await replaceState(tx, row, next, finishedAt, {}, new Date(action.deadline!));
    return { session: view(updated, next, finishedAt), value: result.value };
  });
}

/** Uncertain commits are reconciled by reading the receipt. Never run the effect again. */
export async function markWebsiteAgentActionUnknown(db: AttentionDatabase, claim: WebsiteAgentActionClaim): Promise<void> {
  await db.transaction(async tx => {
    await boundActionTransaction(tx);
    await lockWebsiteAgentAccount(tx, claim.accountId);
    const now = await databaseNow(tx);
    const row = await findSession(tx, claim.accountId, claim.sessionId);
    const state = stateFor(row);
    const action = actionsFor(state).find(item => item.id === claim.actionId);
    if (!action || action.status !== "executing" || action.claimId !== claim.claimId) return;
    const unknown: StoredWebsiteAgentAction = { ...action, status: "unknown", claimId: null, deadline: null,
      receipt: { ok: false, code: "outcome_unknown", message: "No automatic retry was made. Reload this session and check current Attention state before proposing another action." } };
    await replaceState(tx, row, withActions(state, actionsFor(state).map(item => item.id === action.id ? unknown : item)), now);
  });
}

export async function declineWebsiteAgentAction(db: AttentionDatabase, input: {
  accountId: string; sessionId: string; actionId: string; expectedRevision: number;
}): Promise<WebsiteAgentSessionView> {
  assertOwnerKey(input.accountId, input.sessionId);
  if (!UUID.test(input.actionId)) throw new WebsiteAgentSessionError("action_not_found");
  return db.transaction(async tx => {
    await lockWebsiteAgentAccount(tx, input.accountId);
    const now = await databaseNow(tx);
    const row = await findSession(tx, input.accountId, input.sessionId);
    assertOpen(row, input.expectedRevision, now);
    const state = stateFor(row);
    const action = actionsFor(state).find(item => item.id === input.actionId);
    if (!action) throw new WebsiteAgentSessionError("action_not_found");
    if (action.status !== "pending") return view(row, state, now);
    const next = withActions(state, actionsFor(state).map(item => item.id === action.id ? { ...item, status: "cancelled" } : item));
    const updated = await replaceState(tx, row, next, now);
    return view(updated, next, now);
  });
}

/** Read the server-owned candidate proposal before source resolution. No lock survives this call. */
export async function loadWebsiteAgentCandidateAction(db: AttentionDatabase, input: {
  accountId: string; sessionId: string; actionId: string; authSessionId: string; expectedRevision: number; argumentsHash: string;
}): Promise<StoredWebsiteAgentAction> {
  assertOwnerKey(input.accountId, input.sessionId);
  return db.transaction(async tx => {
    await setAccountContext(tx, input.accountId);
    const now = await databaseNow(tx), row = await findSession(tx, input.accountId, input.sessionId);
    assertOpen(row, input.expectedRevision, now);
    const state = stateFor(row), action = actionsFor(state).find(item => item.id === input.actionId);
    if (state.pending || actionsFor(state).some(item => item.status === "executing")) throw new WebsiteAgentSessionError("session_conflict");
    if (!action || action.argumentsHash !== input.argumentsHash || action.prepared?.kind !== "candidate_options" || action.status !== "pending") throw new WebsiteAgentSessionError("action_not_found");
    if (action.authSessionId !== input.authSessionId) throw new WebsiteAgentSessionError("action_authentication_changed");
    if (Date.parse(action.expiresAt) <= now.getTime()) throw new WebsiteAgentSessionError("action_expired");
    return structuredClone(action);
  });
}

/** Replace a choice card with a new exact-action ID. Selecting never executes collection effects. */
export async function replaceWebsiteAgentCandidateAction(db: AttentionDatabase, input: {
  accountId: string; sessionId: string; expectedRevision: number; original: StoredWebsiteAgentAction; proposal: WebsiteAgentActionProposal;
  revalidate(tx: AttentionTransaction): Promise<boolean>;
}): Promise<WebsiteAgentSessionView> {
  assertOwnerKey(input.accountId, input.sessionId);
  return db.transaction(async tx => {
    await lockWebsiteAgentAccount(tx, input.accountId);
    const now = await databaseNow(tx), row = await findSession(tx, input.accountId, input.sessionId);
    assertOpen(row, input.expectedRevision, now);
    const state = stateFor(row), original = actionsFor(state).find(item => item.id === input.original.id);
    if (state.pending || actionsFor(state).some(item => item.status === "executing") || !original ||
        original.status !== "pending" || original.prepared?.kind !== "candidate_options" ||
        JSON.stringify(original) !== JSON.stringify(input.original)) throw new WebsiteAgentSessionError("session_conflict");
    if (Date.parse(original.expiresAt) <= now.getTime()) throw new WebsiteAgentSessionError("action_expired");
    if (!await input.revalidate(tx)) throw new WebsiteAgentSessionError("action_authentication_changed");
    const proposal = parseWebsiteAgentActionProposal(input.proposal);
    const prepared = proposal.prepared;
    const choices = original.prepared;
    if (proposal.toolName !== "attention_select_collection_candidate" || prepared?.kind !== "collection" || !prepared.pending ||
        prepared.plan.accountId !== input.accountId || !choices.options.some(option => option.candidateId === prepared.pending!.candidateId) ||
        prepared.pending.attemptId !== choices.attemptId || prepared.pending.pendingId !== choices.pendingId ||
        prepared.pending.tokenHash !== choices.tokenHash || prepared.pending.vaultDigest !== choices.vaultDigest ||
        prepared.pending.visibility !== choices.visibility || prepared.pending.expiresAt !== choices.expiresAt) throw new WebsiteAgentSessionError("action_not_found");
    const nextAction = pendingWebsiteAgentAction({ proposal, authSessionId: original.authSessionId,
      originRunId: original.originRunId, originRevision: original.originRevision, now });
    // Selection cannot extend the original approval window or the candidate vault lease.
    nextAction.expiresAt = new Date(Math.min(Date.parse(original.expiresAt), Date.parse(nextAction.expiresAt))).toISOString();
    const next = withActions(state, actionsFor(state).map(item => item.id === original.id ? nextAction : item));
    const updated = await replaceState(tx, row, next, now);
    return view(updated, next, now);
  });
}
