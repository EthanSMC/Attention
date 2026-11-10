import { randomUUID } from "node:crypto";

import { sql, websiteAgentRuns, websiteAgentSessions, type AttentionDatabase, type AttentionTransaction } from "@attention/db";
import { appendInterruptedNativeWebsiteSession, createNativeWebsiteSession, websiteAgentSessionMessages } from "@attention/website-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ATTENTION_TOOL_CONTRACT_VERSION } from "./attention-tool-registry";
import { websiteAgentActionArgumentsHash, type WebsiteAgentActionProposal } from "./website-agent-action-policy";
import { pendingWebsiteAgentAction, type StoredWebsiteAgentAction } from "./website-agent-action-state";
import { beginWebsiteAgentTurn, claimWebsiteAgentAction, closeWebsiteAgentSession, declineWebsiteAgentAction,
  decryptWebsiteAgentSessionState, encryptWebsiteAgentSessionState, executeClaimedWebsiteAgentAction,
  finishWebsiteAgentTurn, loadWebsiteAgentSession, markWebsiteAgentActionUnknown, WEBSITE_AGENT_INTERRUPTED_ANSWER,
  type WebsiteAgentActionClaim, type WebsiteAgentSessionState } from "./website-agent-sessions";

const accountId = "00000000-0000-4000-8000-000000000001";
const otherAccountId = "00000000-0000-4000-8000-000000000002";
const sessionId = "10000000-0000-4000-8000-000000000001";
const authSessionId = "20000000-0000-4000-8000-000000000001";
const runId = "30000000-0000-4000-8000-000000000001";
const targetId = "40000000-0000-4000-8000-000000000001";
const now = new Date("2026-11-10T15:00:00.000Z");
const deadline = new Date(now.getTime() + 60_000);
const identity = { accountId, sessionId, runId, revision: 1 };
const beginInput = { accountId, sessionId, query: "Propose a visibility change", expectedRevision: 2,
  operationId: "50000000-0000-4000-8000-000000000001", requestFingerprint: "a".repeat(64),
  maxRunCostMicrousd: 400_000, dailyCostMicrousd: null, timeoutMs: 60_000 };
const receipt = { ok: true, code: "collection_updated", message: "The collection visibility was updated." };
const nativeHistory = appendInterruptedNativeWebsiteSession(createNativeWebsiteSession(sessionId), "Original question", "Original answer");

function proposal(): WebsiteAgentActionProposal {
  const toolName = "attention_update_collection", args = { collection_id: targetId, visibility: "public" };
  return { version: 1, toolName, contractVersion: ATTENTION_TOOL_CONTRACT_VERSION, arguments: args,
    argumentsHash: websiteAgentActionArgumentsHash(toolName, args), targetFingerprint: "b".repeat(64),
    requiredScopes: ["collection:write"], review: { title: "Make a collection public",
      details: [{ label: "Collection", value: "Fixture article" }], consequences: ["Other people may discover the collection."] } };
}
function pending(): StoredWebsiteAgentAction {
  return pendingWebsiteAgentAction({ proposal: proposal(), authSessionId, originRunId: runId, originRevision: 1, now });
}
function executing(): StoredWebsiteAgentAction {
  return { ...pending(), status: "executing", claimId: randomUUID(), deadline: deadline.toISOString() };
}
function state(actions = [pending()]): WebsiteAgentSessionState {
  return { version: 2, nativeSession: structuredClone(nativeHistory), pending: null, actions };
}
function rowFor(value: WebsiteAgentSessionState = state(), revision = 2): typeof websiteAgentSessions.$inferSelect {
  const active = value.version === 2 ? value.actions.find(action => action.status === "executing") : null;
  return { id: sessionId, accountId, revision, encryptedState: encryptWebsiteAgentSessionState({ accountId, sessionId, revision, state: value }),
    activeRunId: value.pending?.runId ?? active?.claimId ?? null,
    activeRunDeadline: value.pending ? new Date(value.pending.deadline) : active?.deadline ? new Date(active.deadline) : null,
    createdAt: now, updatedAt: now, expiresAt: new Date(now.getTime() + 7 * 86400000), closedAt: null };
}
function claimInput(action: StoredWebsiteAgentAction, expectedRevision = 2) {
  return { accountId, sessionId, actionId: action.id, authSessionId, expectedRevision, argumentsHash: action.argumentsHash };
}
function claimFor(action: StoredWebsiteAgentAction, revision = 3): WebsiteAgentActionClaim {
  return { accountId, sessionId, actionId: action.id, authSessionId, claimId: action.claimId!, revision };
}
function queryText(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, child: unknown) => {
    if (child !== null && typeof child === "object") { if (seen.has(child)) return "[circular]"; seen.add(child); }
    return child;
  });
}

/**
 * Script only the Drizzle protocol responses, using the real store and crypto.
 * This observes transaction boundaries, not PostgreSQL lock/RLS/rollback semantics.
 * Each follow-up request explicitly receives the previously returned persisted row.
 */
function scriptedDatabase(row: ReturnType<typeof rowFor>, runReads: unknown[][] = [], options: {
  sessionRows?: unknown[]; busyRows?: unknown[]; times?: Date[]; cas?: boolean;
} = {}) {
  const reads = [{ table: websiteAgentSessions, rows: options.sessionRows ?? [row] },
    ...runReads.map(rows => ({ table: websiteAgentRuns, rows }))];
  const clauses: unknown[] = [], events: string[] = [];
  const attempts: Array<{ table: unknown; value: Record<string, unknown>; kind: string }> = [];
  let committed = false;
  const times = [...(options.times ?? [now])];
  const tx = {
    execute: vi.fn(async (query: ReturnType<typeof sql>) => {
      const text = queryText(query); events.push(text);
      if (text.includes("AS now")) return [{ now: (times.length > 1 ? times.shift()! : times[0]!).toISOString() }];
      if (text.includes("AS busy")) return options.busyRows ?? [{ busy: false }];
      if (text.includes("AS synthetic_effect")) attempts.push({ table: "synthetic_effect", kind: "effect", value: {} });
      return [];
    }),
    select: vi.fn(() => {
      const step = reads.shift();
      if (!step) throw new Error("Unexpected unscripted database read");
      const chain = {
        from: (table: unknown) => { expect(table).toBe(step.table); events.push(table === websiteAgentSessions ? "read_session" : "read_run"); return chain; },
        where: (clause: unknown) => { clauses.push(clause); return chain; },
        limit: async () => step.rows,
        then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(step.rows).then(resolve),
      };
      return chain;
    }),
    update: vi.fn((table: unknown) => ({ set: (value: Record<string, unknown>) => {
      attempts.push({ table, value, kind: "update" });
      events.push(table === websiteAgentSessions ? "write_session" : "write_run");
      return { where: (clause: unknown) => {
        clauses.push(clause);
        return { returning: async () => options.cas === false ? [] : [{ ...row, ...value }],
          then: (resolve: (value: unknown[]) => unknown) => Promise.resolve([]).then(resolve) };
      } };
    } })),
    insert: vi.fn((table: unknown) => ({ values: (value: Record<string, unknown>) => {
      attempts.push({ table, value, kind: "insert" });
      return { returning: async () => [{ id: runId }] };
    } })),
  };
  const transaction = vi.fn(async (callback: (tx: AttentionTransaction) => Promise<unknown>) => {
    const result = await callback(tx as unknown as AttentionTransaction);
    committed = true;
    return result;
  });
  const savedRow = () => ({ ...row, ...attempts.filter(write => write.table === websiteAgentSessions).at(-1)!.value });
  const savedState = () => {
    const saved = savedRow();
    return decryptWebsiteAgentSessionState({ accountId, sessionId, revision: saved.revision, encryptedState: saved.encryptedState });
  };
  return { db: { transaction } as unknown as AttentionDatabase, tx, transaction, attempts, clauses, events, savedRow, savedState,
    committed: () => committed, committedWrites: () => committed ? attempts : [], remainingReads: () => reads.length };
}
beforeEach(() => vi.stubEnv("ATTENTION_WEBSITE_AGENT_SESSION_SECRET", "synthetic-action-store-secret-never-production-12345"));
afterEach(() => vi.unstubAllEnvs());

describe("action proposals commit only with their originating model turn", () => {
  function pendingModelRow() {
    return rowFor({ version: 1, nativeSession: createNativeWebsiteSession(sessionId),
      pending: { query: beginInput.query, runId, deadline: deadline.toISOString() } }, 1);
  }
  it("atomically upgrades v1 to v2 with exact successful Pi continuation and bound pending proposal", async () => {
    const row = pendingModelRow(), action = pending();
    const fake = scriptedDatabase(row, [[{ outcome: "reserved", deadline }]]);
    const prior = decryptWebsiteAgentSessionState({ accountId, sessionId, revision: 1, encryptedState: row.encryptedState });
    const nativeSession = appendInterruptedNativeWebsiteSession(prior.nativeSession, beginInput.query, "Please review this change.");
    const result = await finishWebsiteAgentTurn(fake.db, { ...identity, outcome: "completed", nativeSession, proposedActions: [action] });
    expect(result?.actions).toEqual([expect.objectContaining({ id: action.id, status: "pending" })]);
    expect(result?.messages).toEqual(websiteAgentSessionMessages(nativeSession));
    expect(fake.savedState()).toEqual({ version: 2, nativeSession, pending: null, actions: [action] });
    expect(fake.attempts.at(-1)!.value).toMatchObject({ outcome: "completed" });
    expect(fake.committed()).toBe(true);
    expect(fake.remainingReads()).toBe(0);
  });
  it.each(["failed", "cancelled", "expired"] as const)("never persists proposals or partial provider history after a %s turn", async outcome => {
    const row = pendingModelRow(), action = pending();
    const fake = scriptedDatabase(row, [[{ outcome: "reserved", deadline: outcome === "expired" ? now : deadline }]]);
    const result = await finishWebsiteAgentTurn(fake.db, { ...identity, outcome: outcome === "expired" ? "completed" : outcome,
      proposedActions: [action] });
    const saved = fake.savedState();
    expect(saved).toMatchObject({ version: 1, pending: null });
    expect(saved).not.toHaveProperty("actions");
    expect(websiteAgentSessionMessages(saved.nativeSession).at(-1)?.text).toBe(WEBSITE_AGENT_INTERRUPTED_ANSWER);
    expect(fake.attempts.at(-1)!.value).toMatchObject({ outcome: outcome === "expired" ? "failed" : outcome });
    if (outcome === "expired") expect(result).toBeNull();
  });
  it.each(["run", "revision", "expiry", "future"])("rejects an otherwise valid proposal with the wrong %s binding", async changed => {
    const row = pendingModelRow(), action = pending();
    if (changed === "run") action.originRunId = randomUUID();
    if (changed === "revision") action.originRevision = 0;
    if (changed === "expiry") { action.createdAt = new Date(now.getTime() - 300_000).toISOString(); action.expiresAt = now.toISOString(); }
    if (changed === "future") { action.createdAt = new Date(now.getTime() + 5_001).toISOString(); action.expiresAt = new Date(now.getTime() + 305_001).toISOString(); }
    const prior = decryptWebsiteAgentSessionState({ accountId, sessionId, revision: 1, encryptedState: row.encryptedState });
    const nativeSession = appendInterruptedNativeWebsiteSession(prior.nativeSession, beginInput.query, "Review this.");
    const fake = scriptedDatabase(row, [[{ outcome: "reserved", deadline }]]);
    await expect(finishWebsiteAgentTurn(fake.db, { ...identity, outcome: "completed", nativeSession, proposedActions: [action] })).rejects.toThrow("session_unavailable");
    expect(fake.attempts).toEqual([]);
    expect(fake.committed()).toBe(false);
  });
});

describe("one-time durable reviewed action claims", () => {
  it("claims once under the account lock and returns no execution authority on replay", async () => {
    const action = pending(), fake = scriptedDatabase(rowFor(state([action])), [[{ outcome: "completed" }]]);
    const first = await claimWebsiteAgentAction(fake.db, claimInput(action));
    expect(first.claim).toMatchObject({ accountId, sessionId, actionId: action.id, authSessionId, revision: 3 });
    expect(first.claim!.claimId).not.toBe(action.id);
    expect(first.session.actions![0]!.status).toBe("executing");
    expect(fake.savedRow()).toMatchObject({ revision: 3, activeRunId: first.claim!.claimId, activeRunDeadline: deadline });
    expect(fake.savedState().nativeSession).toEqual(state().nativeSession);
    const queries = fake.tx.execute.mock.calls.map(([query]) => queryText(query));
    const boundsIndex = queries.findIndex(query => query.includes("lock_timeout"));
    const scopeIndex = queries.findIndex(query => query.includes("app.account_id"));
    const advisoryIndex = queries.findIndex(query => query.includes("pg_advisory_xact_lock"));
    expect(boundsIndex).toBeGreaterThanOrEqual(0);
    expect(boundsIndex).toBeLessThan(scopeIndex); expect(scopeIndex).toBeLessThan(advisoryIndex);
    for (const bound of ["'lock_timeout', '5000', true", "'statement_timeout', '20000', true", "'idle_in_transaction_session_timeout', '65000', true"])
      expect(queries[boundsIndex]).toContain(bound);
    const advisoryEvent = fake.events.findIndex(event => event.includes("pg_advisory_xact_lock"));
    expect(advisoryEvent).toBeLessThan(fake.events.indexOf("read_session"));
    expect(advisoryEvent).toBeLessThan(fake.events.indexOf("write_session"));
    for (const token of [accountId, sessionId, runId]) expect(queryText(fake.clauses)).toContain(token);
    const replay = scriptedDatabase(fake.savedRow());
    await expect(claimWebsiteAgentAction(replay.db, claimInput(action))).resolves.toMatchObject({ claim: null, session: { revision: 3 } });
    expect(replay.attempts).toEqual([]);
  });
  it.each(["hash", "authentication", "revision", "expiry", "missing_run", "unfinished_run", "origin_revision"])(
    "denies approval after %s changes before writing a claim", async changed => {
      const action = pending(), input = claimInput(action);
      if (changed === "hash") input.argumentsHash = "f".repeat(64);
      if (changed === "authentication") input.authSessionId = randomUUID();
      if (changed === "revision") input.expectedRevision = 3;
      if (changed === "expiry") { action.createdAt = new Date(now.getTime() - 300_000).toISOString(); action.expiresAt = now.toISOString(); }
      if (changed === "origin_revision") action.originRevision = 2;
      const reads = ["missing_run", "unfinished_run", "origin_revision"].includes(changed)
        ? [changed === "missing_run" ? [] : [{ outcome: changed === "unfinished_run" ? "failed" : "completed" }]] : [];
      const fake = scriptedDatabase(rowFor(state([action])), reads);
      await expect(claimWebsiteAgentAction(fake.db, input)).rejects.toThrow(changed === "hash" ? "action_not_found"
        : changed === "authentication" ? "action_authentication_changed" : changed === "expiry" ? "action_expired" : "session_conflict");
      expect(fake.attempts).toEqual([]);
    });
  it.each(["claim", "execute", "decline", "unknown"])("scopes %s to its owner and refuses a guessed foreign session without effects", async operation => {
    const action = executing(), fake = scriptedDatabase(rowFor(state([action]), 3), [], { sessionRows: [] });
    const callback = vi.fn(async () => ({ receipt, value: true }));
    const claim = { ...claimFor(action), accountId: otherAccountId };
    const call = operation === "claim" ? claimWebsiteAgentAction(fake.db, { ...claimInput(action, 3), accountId: otherAccountId })
      : operation === "execute" ? executeClaimedWebsiteAgentAction(fake.db, claim, callback)
      : operation === "decline" ? declineWebsiteAgentAction(fake.db, { ...claimInput(action, 3), accountId: otherAccountId })
      : markWebsiteAgentActionUnknown(fake.db, claim);
    await expect(call).rejects.toThrow("session_not_found");
    expect(callback).not.toHaveBeenCalled(); expect(fake.attempts).toEqual([]);
    expect(queryText(fake.clauses)).toContain(otherAccountId); expect(queryText(fake.clauses)).toContain(sessionId);
  });
  it("caps a claim's execution lease at the original approval expiry", async () => {
    const action = pending(); action.createdAt = new Date(now.getTime() - 290_000).toISOString();
    action.expiresAt = new Date(now.getTime() + 10_000).toISOString();
    const fake = scriptedDatabase(rowFor(state([action])), [[{ outcome: "completed" }]]);
    await claimWebsiteAgentAction(fake.db, claimInput(action));
    expect(fake.savedRow().activeRunDeadline).toEqual(new Date(action.expiresAt));
  });
  it("does not commit an executing claim when the session compare-and-swap loses", async () => {
    const action = pending(), fake = scriptedDatabase(rowFor(state([action])), [[{ outcome: "completed" }]], { cas: false });
    await expect(claimWebsiteAgentAction(fake.db, claimInput(action))).rejects.toThrow("session_conflict");
    expect(fake.attempts).toHaveLength(1); expect(fake.committedWrites()).toEqual([]);
    for (const token of [accountId, sessionId, '"revision"', '"active_run_id"', '"closed_at"']) expect(queryText(fake.clauses)).toContain(token);
  });
});

describe("account lane and action/model fencing", () => {
  it.each(["action", "model"])("rejects a new %s when another session occupies the account-wide action/model lane", async operation => {
    const action = pending(), row = rowFor(state([action]));
    const fake = scriptedDatabase(row, operation === "action" ? [[{ outcome: "completed" }]] : [[], []], { busyRows: [{ busy: true }] });
    await expect(operation === "action" ? claimWebsiteAgentAction(fake.db, claimInput(action)) : beginWebsiteAgentTurn(fake.db, beginInput))
      .rejects.toThrow("website_agent_busy");
    expect(fake.attempts).toEqual([]);
    const admission = fake.tx.execute.mock.calls.map(([query]) => queryText(query)).find(text => text.includes("AS busy"))!;
    for (const token of ["website_agent_runs", "website_agent_sessions", "reserved", "active_run_id", "active_run_deadline", "clock_timestamp", accountId])
      expect(admission).toContain(token);
    expect(admission).toContain("OR EXISTS");
  });
  it.each([[], [{ busy: null }], [{ busy: "false" }]])("fails closed when account-lane admission is unavailable: %j", async (...rows) => {
    const action = pending(), fake = scriptedDatabase(rowFor(state([action])), [[{ outcome: "completed" }]], { busyRows: rows });
    await expect(claimWebsiteAgentAction(fake.db, claimInput(action))).rejects.toThrow("website_agent_admission_unavailable");
    expect(fake.attempts).toEqual([]);
  });
  it("starting another model turn cancels old pending proposals while retaining unknown receipts", async () => {
    const action = pending(), unknown: StoredWebsiteAgentAction = { ...pending(), status: "unknown",
      receipt: { ok: false, code: "outcome_unknown", message: "Check current state." } };
    const row = rowFor(state([action, unknown]));
    const fake = scriptedDatabase(row, [[], [], [{ total: "0" }], [{ deadline }]]);
    await beginWebsiteAgentTurn(fake.db, beginInput);
    const saved = fake.savedState();
    expect(saved.version).toBe(2);
    if (saved.version !== 2) throw new Error("Expected v2");
    expect(saved.actions.map(item => item.status)).toEqual(["cancelled", "unknown"]);
    expect(saved.nativeSession).toEqual(state().nativeSession);
    expect(saved.pending).toMatchObject({ runId, query: beginInput.query });
    const replay = scriptedDatabase(fake.savedRow());
    await expect(claimWebsiteAgentAction(replay.db, claimInput(action))).resolves.toMatchObject({ claim: null });
    expect(replay.attempts).toEqual([]);
  });
  it("blocks a model turn while an action owns the current session lease", async () => {
    const fake = scriptedDatabase(rowFor(state([executing()]), 3));
    await expect(beginWebsiteAgentTurn(fake.db, { ...beginInput, expectedRevision: 3 })).rejects.toThrow("session_conflict");
    expect(fake.attempts).toEqual([]);
  });
  it("closing an executing session removes its lease, retains unknown outcome, and fences the old callback", async () => {
    const action = executing(), row = rowFor(state([action, pending()]), 3), fake = scriptedDatabase(row);
    const result = await closeWebsiteAgentSession(fake.db, { accountId, sessionId, expectedRevision: 3 });
    expect(result).toMatchObject({ status: "closed", revision: 4 });
    expect(result.actions!.map(item => item.status)).toEqual(["unknown", "cancelled"]);
    expect(fake.savedRow()).toMatchObject({ activeRunId: null, activeRunDeadline: null, closedAt: now });
    expect(fake.savedState().nativeSession).toEqual(state().nativeSession);
    const later = scriptedDatabase(fake.savedRow()), effect = vi.fn(async () => ({ receipt, value: true }));
    await expect(executeClaimedWebsiteAgentAction(later.db, claimFor(action), effect)).rejects.toThrow("session_closed");
    expect(effect).not.toHaveBeenCalled(); expect(later.attempts).toEqual([]);
  });
  it("rejects disagreement between the encrypted executing claim and unencrypted lease metadata", async () => {
    const action = executing();
    for (const change of [{ activeRunId: randomUUID() }, { activeRunDeadline: new Date(deadline.getTime() + 1) }]) {
      const fake = scriptedDatabase({ ...rowFor(state([action]), 3), ...change });
      await expect(loadWebsiteAgentSession(fake.db, accountId, sessionId)).rejects.toThrow("session_unavailable");
      expect(fake.attempts).toEqual([]);
    }
  });
});

describe("durable effects, receipts and interrupted claims", () => {
  it.each([true, false])("stores a known ok=%s receipt and any successful effect in one transaction, preserving native Pi history", async ok => {
    const action = executing(), row = rowFor(state([action]), 3), fake = scriptedDatabase(row);
    const outcome = { ...receipt, ok, code: ok ? "collection_updated" : "permission_revoked" };
    const effect = vi.fn(async (tx: AttentionTransaction, stored: StoredWebsiteAgentAction) => {
      expect(tx).toBe(fake.tx); expect(stored).toEqual(action); expect(stored).not.toBe(action);
      if (ok) await tx.execute(sql`SELECT 1 AS synthetic_effect`);
      return { receipt: outcome, value: "caller-result" };
    });
    const result = await executeClaimedWebsiteAgentAction(fake.db, claimFor(action), effect);
    expect(result.value).toBe("caller-result");
    expect(result.session.actions![0]).toMatchObject({ status: ok ? "completed" : "failed", receipt: outcome });
    expect(fake.savedRow()).toMatchObject({ revision: 4, activeRunId: null, activeRunDeadline: null });
    expect(queryText(fake.clauses)).toContain("clock_timestamp");
    expect(queryText(fake.clauses)).toContain(deadline.toISOString());
    expect(fake.savedState().nativeSession).toEqual(state().nativeSession);
    expect(fake.transaction).toHaveBeenCalledTimes(1); expect(effect).toHaveBeenCalledTimes(1);
    expect(fake.committedWrites().map(write => write.kind)).toEqual(ok ? ["effect", "update"] : ["update"]);
    for (const key of ["arguments", "token", "authSessionId", "claimId"]) expect(result.session.actions![0]).not.toHaveProperty(key);
    const replay = scriptedDatabase(fake.savedRow());
    await expect(claimWebsiteAgentAction(replay.db, claimInput(action))).resolves.toMatchObject({ claim: null,
      session: { actions: [expect.objectContaining({ receipt: outcome })] } });
    expect(replay.attempts).toEqual([]); expect(effect).toHaveBeenCalledTimes(1);
  });
  it.each(["throw", "cas", "deadline", "invalid_receipt", "nested_receipt"])("does not commit a DB effect without its receipt when %s fails", async failure => {
    const action = executing(), fake = scriptedDatabase(rowFor(state([action]), 3), [], {
      cas: failure !== "cas", times: failure === "deadline" ? [now, deadline] : [now],
    });
    const effect = vi.fn(async (tx: AttentionTransaction) => {
      await tx.execute(sql`SELECT 1 AS synthetic_effect`);
      if (failure === "throw") throw new Error("synthetic_effect_failure");
      const output = failure === "invalid_receipt" ? { ...receipt, code: "" }
        : failure === "nested_receipt" ? { ...receipt, value: { arguments: action.arguments, token: "synthetic-cookie-not-a-real-token" } } : receipt;
      return { receipt: output, value: true };
    });
    await expect(executeClaimedWebsiteAgentAction(fake.db, claimFor(action), effect)).rejects.toThrow(
      failure === "throw" ? "synthetic_effect_failure" : failure === "cas" ? "session_conflict" : failure === "deadline" ? "action_expired" : "session_unavailable");
    expect(effect).toHaveBeenCalledTimes(1); expect(fake.attempts[0]!.kind).toBe("effect");
    expect(fake.committedWrites()).toEqual([]);
  });
  it.each(["claim", "authentication", "revision", "lease", "completed"])("refuses the effect callback when its %s is stale", async changed => {
    const action = executing(), claim = claimFor(action);
    if (changed === "claim") claim.claimId = randomUUID();
    if (changed === "authentication") claim.authSessionId = randomUUID();
    if (changed === "revision") claim.revision = 2;
    if (changed === "completed") { action.status = "completed"; action.claimId = null; action.deadline = null; action.receipt = receipt; }
    const fake = scriptedDatabase(rowFor(state([action]), 3), [], { times: [changed === "lease" ? deadline : now] });
    const effect = vi.fn(async () => ({ receipt, value: true }));
    await expect(executeClaimedWebsiteAgentAction(fake.db, claim, effect)).rejects.toThrow("session_conflict");
    expect(effect).not.toHaveBeenCalled(); expect(fake.attempts).toEqual([]);
  });
  it("reload settles an expired execution lease to durable unknown exactly once, without any effect or model retry", async () => {
    const action = executing(), row = rowFor(state([action]), 3), fake = scriptedDatabase(row, [], { times: [deadline] });
    const result = await loadWebsiteAgentSession(fake.db, accountId, sessionId);
    expect(result.actions![0]).toMatchObject({ status: "unknown", receipt: { ok: false, code: "outcome_unknown" } });
    expect(result.revision).toBe(4); expect(fake.tx.insert).not.toHaveBeenCalled();
    expect(fake.savedRow()).toMatchObject({ activeRunId: null, activeRunDeadline: null });
    expect(fake.savedState().nativeSession).toEqual(state().nativeSession);
    const reload = scriptedDatabase(fake.savedRow(), [], { times: [new Date(deadline.getTime() + 86400000)] });
    await expect(loadWebsiteAgentSession(reload.db, accountId, sessionId)).resolves.toMatchObject({ revision: 4, actions: result.actions });
    expect(reload.attempts).toEqual([]);
    const replay = scriptedDatabase(fake.savedRow());
    await expect(claimWebsiteAgentAction(replay.db, claimInput(action, 4))).resolves.toMatchObject({ claim: null });
    expect(replay.attempts).toEqual([]);
  });
  it("records an uncertain outcome once and never overwrites an already committed receipt", async () => {
    const action = executing(), fake = scriptedDatabase(rowFor(state([action]), 3));
    await markWebsiteAgentActionUnknown(fake.db, claimFor(action));
    const saved = fake.savedState();
    expect(saved.version === 2 && saved.actions[0]).toMatchObject({ status: "unknown", claimId: null, deadline: null });
    for (const current of [fake.savedRow(), rowFor(state([{ ...action, status: "completed", claimId: null, deadline: null, receipt }]), 4)]) {
      const later = scriptedDatabase(current);
      await markWebsiteAgentActionUnknown(later.db, claimFor(action));
      expect(later.attempts).toEqual([]);
    }
  });
  it("declines a pending proposal without effects or history mutation and remains non-executable on replay", async () => {
    const action = pending(), fake = scriptedDatabase(rowFor(state([action])));
    const result = await declineWebsiteAgentAction(fake.db, claimInput(action));
    expect(result.actions![0]).toMatchObject({ status: "cancelled", receipt: null });
    expect(result.revision).toBe(3); expect(fake.tx.insert).not.toHaveBeenCalled();
    expect(fake.savedState().nativeSession).toEqual(state().nativeSession);
    const replay = scriptedDatabase(fake.savedRow());
    await expect(claimWebsiteAgentAction(replay.db, claimInput(action))).resolves.toMatchObject({ claim: null });
    expect(replay.attempts).toEqual([]);
    const repeated = scriptedDatabase(fake.savedRow());
    await expect(declineWebsiteAgentAction(repeated.db, claimInput(action, 3))).resolves.toMatchObject({ revision: 3 });
    expect(repeated.attempts).toEqual([]);
  });
});
