import { randomUUID } from "node:crypto";

import type { AttentionDatabase, sql } from "@attention/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  beginWebsiteAgentTurn, closeWebsiteAgentSession, createWebsiteAgentSession,
  decryptWebsiteAgentSessionState, encryptWebsiteAgentSessionState, finishWebsiteAgentTurn,
  isWebsiteAgentTurnActive, listWebsiteAgentSessions, loadWebsiteAgentSession,
  WEBSITE_AGENT_INTERRUPTED_ANSWER, type WebsiteAgentSessionState,
} from "./website-agent-sessions";
import { appendInterruptedNativeWebsiteSession, createNativeWebsiteSession, websiteAgentSessionMessages } from "@attention/website-agent";
import * as nativeRuntime from "@attention/website-agent";

const accountId = "00000000-0000-4000-8000-000000000001";
const otherAccount = "00000000-0000-4000-8000-000000000002";
const sessionId = "10000000-0000-4000-8000-000000000001";
const runId = "20000000-0000-4000-8000-000000000001";
const operationId = "30000000-0000-4000-8000-000000000001";
const now = new Date("2026-11-10T15:00:00.000Z");
const deadline = new Date(now.getTime() + 60_000);
const initial = (): WebsiteAgentSessionState => ({ version: 1, nativeSession: createNativeWebsiteSession(sessionId), pending: null });
const identity = { accountId, sessionId, runId, revision: 1 };
const beginInput = { accountId, sessionId, query: "private user question", expectedRevision: 0, operationId,
  requestFingerprint: "a".repeat(64), maxRunCostMicrousd: 400_000, dailyCostMicrousd: null, timeoutMs: 60_000 };
function stored(state = initial(), revision = 0) {
  return { id: sessionId, accountId, revision, encryptedState: encryptWebsiteAgentSessionState({ accountId, sessionId, revision, state }),
    activeRunId: state.pending?.runId ?? null, activeRunDeadline: state.pending ? new Date(state.pending.deadline) : null,
    createdAt: now, updatedAt: now, expiresAt: new Date(now.getTime() + 7 * 86400000), closedAt: null as Date | null };
}
function pendingState(): WebsiteAgentSessionState {
  return { ...initial(), pending: { query: beginInput.query, runId, deadline: deadline.toISOString() } };
}

function queryText(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, child: unknown) => {
    if (child !== null && typeof child === "object") {
      if (seen.has(child)) return "[circular]";
      seen.add(child);
    }
    return child;
  });
}

/** Scripted DB protocol fixture. Real PostgreSQL RLS/FK/CAS checks live in the isolated SQL fixture. */
function fakeDatabase(results: unknown[][] = [], row = stored(), compareAndSwapSucceeds = true) {
  const selects = [...results];
  const clauses: unknown[] = [];
  const writes: Array<{ kind: string; value: Record<string, unknown> }> = [];
  let committed = false;
  const tx = {
    execute: vi.fn(async (query: ReturnType<typeof sql>) => {
      return JSON.stringify(query).includes("AS now") ? [{ now: now.toISOString() }] : [];
    }),
    select: vi.fn(() => {
      const result = selects.shift() ?? [];
      const chain = { from: () => chain, innerJoin: () => chain,
        where: (clause: unknown) => { clauses.push(clause); return chain; }, orderBy: () => chain,
        limit: async () => result, then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(result).then(resolve) };
      return chain;
    }),
    insert: vi.fn(() => ({ values: (value: Record<string, unknown>) => {
      writes.push({ kind: "insert", value });
      return { returning: async () => [{ ...row, ...value, id: value.id ?? runId }] };
    } })),
    update: vi.fn(() => ({ set: (value: Record<string, unknown>) => {
      writes.push({ kind: "update", value });
      return { where: (clause: unknown) => { clauses.push(clause); return {
        returning: async () => compareAndSwapSucceeds ? [{ ...row, ...value }] : [],
        then: (resolve: (value: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
      }; } };
    } })),
  };
  const transaction = vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => {
    const result = await callback(tx); committed = true; return result;
  });
  return { tx, transaction, clauses, writes, committed: () => committed, db: { transaction } as unknown as AttentionDatabase };
}
beforeEach(() => vi.stubEnv("ATTENTION_WEBSITE_AGENT_SESSION_SECRET", "synthetic-session-key-32-chars-or-longer-never-production"));
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("website session authenticated encryption", () => {
  it("roundtrips context and pending input without plaintext at rest, using a fresh nonce", () => {
    const state = pendingState();
    const value = { accountId, sessionId, revision: 1, state };
    const encryptedState = encryptWebsiteAgentSessionState(value);
    expect(encryptedState).not.toContain(state.pending!.query);
    expect(encryptWebsiteAgentSessionState(value)).not.toBe(encryptedState);
    expect(decryptWebsiteAgentSessionState({ ...value, encryptedState })).toEqual(state);
  });
  it("authenticates owner, opaque session ID, revision, ciphertext and key", () => {
    const value = { accountId, sessionId, revision: 0 };
    const encryptedState = encryptWebsiteAgentSessionState({ ...value, state: initial() });
    for (const change of [{ accountId: otherAccount }, { sessionId: randomUUID() }, { revision: 1 },
      { encryptedState: encryptedState.slice(0, -8) + "AAAAAAAA" }]) {
      expect(() => decryptWebsiteAgentSessionState({ ...value, encryptedState, ...change })).toThrow("session_unavailable");
    }
    vi.stubEnv("ATTENTION_WEBSITE_AGENT_SESSION_SECRET", "another-synthetic-session-secret-at-least-32");
    expect(() => decryptWebsiteAgentSessionState({ ...value, encryptedState })).toThrow("session_unavailable");
  });
  it.each(["", "too-short"])("fails closed when independent session key is unavailable: %s", secret => {
    vi.stubEnv("ATTENTION_WEBSITE_AGENT_SESSION_SECRET", secret);
    expect(() => encryptWebsiteAgentSessionState({ accountId, sessionId, revision: 0, state: initial() })).toThrow("session_unavailable");
  });
  it.each(["ATTENTION_HMAC_SECRET", "ATTENTION_AUTH_SECRET", "ATTENTION_WEBSITE_AGENT_DEEPSEEK_API_KEY"])("rejects reusing another secret: %s", key => {
    vi.stubEnv(key, process.env.ATTENTION_WEBSITE_AGENT_SESSION_SECRET!);
    expect(() => encryptWebsiteAgentSessionState({ accountId, sessionId, revision: 0, state: initial() })).toThrow("session_unavailable");
  });
  it("rejects extra/raw source or credential-bearing envelope fields", () => {
    const state = { ...initial(), sourceBody: "never persist raw source", apiKey: "synthetic" };
    expect(() => encryptWebsiteAgentSessionState({ accountId, sessionId, revision: 0, state })).toThrow("session_unavailable");
  });
  it("rejects malformed, oversized and unauthenticated encryption envelopes", () => {
    const identity = { accountId, sessionId, revision: 0 };
    const encrypted = encryptWebsiteAgentSessionState({ ...identity, state: initial() });
    const parts = encrypted.split(".");
    for (const encryptedState of ["", "v2." + parts.slice(1).join("."), encrypted + ".extra", "x".repeat(1_048_577),
      [parts[0], parts[1] + "=", parts[2], parts[3]].join("."),
      [parts[0], Buffer.alloc(11).toString("base64url"), parts[2], parts[3]].join("."),
      [parts[0], parts[1], Buffer.alloc(16).toString("base64url"), parts[3]].join(".")]) {
      expect(() => decryptWebsiteAgentSessionState({ ...identity, encryptedState })).toThrow("session_unavailable");
    }
  });
  it.each([
    { query: " ", runId, deadline: deadline.toISOString() },
    { query: "q".repeat(4_001), runId, deadline: deadline.toISOString() },
    { query: "query", runId: "guessed", deadline: deadline.toISOString() },
    { query: "query", runId, deadline: "tomorrow" },
    { query: "query", runId, deadline: "2026-11-10T15:01:00Z" },
    { query: "query", runId, deadline: deadline.toISOString(), sourceBody: "private" },
  ])("rejects invalid pending metadata without silently stripping fields", pending => {
    expect(() => encryptWebsiteAgentSessionState({ accountId, sessionId, revision: 0,
      state: { ...initial(), pending } })).toThrow("session_unavailable");
  });
});

describe("account-owned website session lifecycle", () => {
  it("creates random server IDs and owner-encrypted empty state without a model call", async () => {
    const fake = fakeDatabase();
    const result = await createWebsiteAgentSession(fake.db, accountId);
    expect(result.id).not.toBe(sessionId);
    expect(result.revision).toBe(0);
    expect(result.status).toBe("open");
    expect(result.pending).toBeNull();
    expect(fake.writes[0]!.value).toMatchObject({ accountId, revision: 0 });
    expect(fake.writes[0]!.value).not.toHaveProperty("nativeSession");
    expect(JSON.stringify(fake.tx.execute.mock.calls[0])).toContain("set_config");
    expect(JSON.stringify(fake.tx.execute.mock.calls[1])).toContain("pg_advisory_xact_lock");
  });
  it("lists only owner-scoped metadata, never ciphertext or native history", async () => {
    const fake = fakeDatabase([[stored()]]);
    const result = await listWebsiteAgentSessions(fake.db, accountId);
    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty("encryptedState");
    expect(result[0]).not.toHaveProperty("nativeSession");
    expect(queryText(fake.clauses)).toContain(accountId);
  });
  it.each(["load", "close", "begin", "finish"])("rejects guessed or another user's session during %s", async operation => {
    const fake = fakeDatabase([[]]);
    const call = operation === "load" ? loadWebsiteAgentSession(fake.db, otherAccount, sessionId)
      : operation === "close" ? closeWebsiteAgentSession(fake.db, { accountId: otherAccount, sessionId, expectedRevision: 0 })
      : operation === "begin" ? beginWebsiteAgentTurn(fake.db, { ...beginInput, accountId: otherAccount })
      : finishWebsiteAgentTurn(fake.db, { ...identity, accountId: otherAccount, outcome: "failed" });
    await expect(call).rejects.toThrow("session_not_found");
    expect(fake.writes).toEqual([]);
    expect(queryText(fake.clauses)).toContain(otherAccount);
    expect(queryText(fake.clauses)).toContain(sessionId);
  });
  it.each(["stale", "expired", "closed"])("denies %s sessions before reserving money", async kind => {
    const row = stored();
    if (kind === "expired") row.expiresAt = now;
    if (kind === "closed") row.closedAt = now;
    const fake = fakeDatabase([[row]], row);
    await expect(beginWebsiteAgentTurn(fake.db, { ...beginInput, expectedRevision: kind === "stale" ? 4 : 0 }))
      .rejects.toThrow(kind === "stale" ? "session_conflict" : `session_${kind}`);
    expect(fake.writes).toEqual([]);
  });
  it("reserves one account run and persists encrypted pending prompt in the same transaction", async () => {
    const row = stored();
    const fake = fakeDatabase([[row], [], [], [{ total: "2000000" }], [{ deadline }]], row);
    const result = await beginWebsiteAgentTurn(fake.db, beginInput);
    expect(result).toMatchObject(identity);
    expect(fake.committed()).toBe(true);
    expect(fake.writes[0]!.value).toMatchObject({ accountId, sessionId, reservedCostMicrousd: 400_000 });
    const saved = fake.writes[1]!.value;
    expect(saved).toMatchObject({ revision: 1, activeRunId: runId });
    expect(JSON.stringify(saved)).not.toContain(beginInput.query);
    expect(decryptWebsiteAgentSessionState({ accountId, sessionId, revision: 1, encryptedState: saved.encryptedState as string }).pending?.query).toBe(beginInput.query);
  });
  it("does not commit the paid reservation if the session compare-and-swap fails", async () => {
    const row = stored();
    const fake = fakeDatabase([[row], [], [], [{ total: "0" }], [{ deadline }]], row, false);
    await expect(beginWebsiteAgentTurn(fake.db, beginInput)).rejects.toThrow("session_conflict");
    expect(fake.transaction).toHaveBeenCalledTimes(1);
    expect(fake.writes).toHaveLength(2);
    expect(fake.committed()).toBe(false);
  });
  it("refuses a full native archive before reserving a paid run", async () => {
    const row = stored(); const fake = fakeDatabase([[row]], row);
    vi.spyOn(nativeRuntime, "appendInterruptedNativeWebsiteSession").mockImplementationOnce(() => {
      throw Object.assign(new Error("session_full"), { code: "session_full" });
    });
    await expect(beginWebsiteAgentTurn(fake.db, beginInput)).rejects.toThrow("session_full");
    expect(fake.writes).toEqual([]);
  });
  it("blocks another session's live account reservation without writing pending state", async () => {
    const row = stored();
    const fake = fakeDatabase([[row], [], [{ id: runId }]], row);
    await expect(beginWebsiteAgentTurn(fake.db, beginInput)).rejects.toThrow("website_agent_busy");
    expect(fake.writes).toEqual([]);
  });
  it("reloads an active turn without making a reservation or changing its revision", async () => {
    const state = pendingState(); const row = stored(state, 1);
    const fake = fakeDatabase([[row]], row);
    const result = await loadWebsiteAgentSession(fake.db, accountId, sessionId);
    expect(result.pending?.query).toBe(beginInput.query);
    expect(result.revision).toBe(1);
    expect(fake.writes).toEqual([]);
  });
  it("reconciles a crashed turn once on reload with a factual interruption, not paid retry", async () => {
    const state = pendingState(); state.pending!.deadline = new Date(now.getTime() - 1).toISOString();
    const row = stored(state, 1); const fake = fakeDatabase([[row]], row);
    const result = await loadWebsiteAgentSession(fake.db, accountId, sessionId);
    expect(result.revision).toBe(2); expect(result.pending).toBeNull();
    expect(result.messages.at(-1)?.text).toBe(WEBSITE_AGENT_INTERRUPTED_ANSWER);
    expect(fake.tx.insert).not.toHaveBeenCalled();
    expect(fake.writes.at(-1)!.value).toMatchObject({ outcome: "failed" });
    expect(fake.writes.at(-1)!.value).not.toHaveProperty("reservedCostMicrousd");
    const saved = { ...row, ...fake.writes[0]!.value };
    const reload = fakeDatabase([[saved]], saved);
    const secondResult = await loadWebsiteAgentSession(reload.db, accountId, sessionId);
    expect(secondResult.messages).toEqual(result.messages);
    expect(secondResult.revision).toBe(2);
    expect(reload.writes).toEqual([]);
  });
  it("requires reload acknowledgement rather than retrying existing pending input", async () => {
    const row = stored(pendingState(), 1); const fake = fakeDatabase([[row]], row);
    await expect(beginWebsiteAgentTurn(fake.db, { ...beginInput, expectedRevision: 1 })).rejects.toThrow("session_conflict");
    expect(fake.writes).toEqual([]);
  });
  it("closes an active turn, invalidates its revision and keeps conservative budget", async () => {
    const row = stored(pendingState(), 1); const fake = fakeDatabase([[row]], row);
    const result = await closeWebsiteAgentSession(fake.db, { accountId, sessionId, expectedRevision: 1 });
    expect(result).toMatchObject({ revision: 2, status: "closed", pending: null });
    expect(fake.writes[0]!.value).toMatchObject({ revision: 2, activeRunId: null, activeRunDeadline: null });
    expect(fake.writes[1]!.value).toMatchObject({ outcome: "cancelled" });
  });
  it("keeps repeated close idempotent while rejecting stale close revisions", async () => {
    const row = stored(); row.closedAt = now;
    const fake = fakeDatabase([[row]], row);
    await expect(closeWebsiteAgentSession(fake.db, { accountId, sessionId, expectedRevision: 0 })).resolves.toMatchObject({ status: "closed", revision: 0 });
    expect(fake.writes).toEqual([]);
    await expect(closeWebsiteAgentSession(fakeDatabase([[row]], row).db, { accountId, sessionId, expectedRevision: 1 })).rejects.toThrow("session_conflict");
  });
  it.each(["revision", "closed", "run"])("discards stale completion after %s changes", async changed => {
    const row = stored(pendingState(), 1);
    if (changed === "revision") row.revision = 2;
    if (changed === "closed") row.closedAt = now;
    if (changed === "run") row.activeRunId = randomUUID();
    const fake = fakeDatabase([[row]], row);
    await expect(finishWebsiteAgentTurn(fake.db, { ...identity, outcome: "completed" })).resolves.toBeNull();
    expect(fake.writes).toEqual([]);
  });
  it("persists only validated continuation before marking a run completed", async () => {
    const state = pendingState(); const row = stored(state, 1);
    const fake = fakeDatabase([[row], [{ outcome: "reserved", deadline }]], row);
    const nativeSession = appendInterruptedNativeWebsiteSession(state.nativeSession, beginInput.query, "Final public answer");
    const result = await finishWebsiteAgentTurn(fake.db, { ...identity, outcome: "completed", nativeSession });
    expect(result?.messages).toEqual(websiteAgentSessionMessages(nativeSession)); expect(result?.revision).toBe(2);
    expect(fake.writes.at(-1)!.value).toMatchObject({ outcome: "completed" });
    expect(queryText(fake.clauses)).toContain('"revision"');
  });
  it("rejects a completed snapshot that changes the pending user prompt", async () => {
    const state = pendingState(); const row = stored(state, 1);
    const fake = fakeDatabase([[row], [{ outcome: "reserved", deadline }]], row);
    const nativeSession = appendInterruptedNativeWebsiteSession(state.nativeSession, "forged user instruction", "Answer");
    await expect(finishWebsiteAgentTurn(fake.db, { ...identity, outcome: "completed", nativeSession })).rejects.toThrow("session_unavailable");
    expect(fake.writes).toEqual([]);
  });
  it("rejects a completed snapshot whose final answer differs from the public response", async () => {
    const state = pendingState(); const row = stored(state, 1);
    const fake = fakeDatabase([[row], [{ outcome: "reserved", deadline }]], row);
    const nativeSession = appendInterruptedNativeWebsiteSession(state.nativeSession, beginInput.query, "Saved answer");
    await expect(finishWebsiteAgentTurn(fake.db, { ...identity, outcome: "completed", nativeSession, answer: "Different answer" })).rejects.toThrow("session_unavailable");
    expect(fake.writes).toEqual([]);
  });
  it.each([{ run: [] }, { run: [{ outcome: "cancelled", deadline }] }])("ignores completions without the matching reserved budget lease", async ({ run }) => {
    const state = pendingState(); const row = stored(state, 1);
    const fake = fakeDatabase([[row], run], row);
    await expect(finishWebsiteAgentTurn(fake.db, { ...identity, outcome: "failed" })).resolves.toBeNull();
    expect(fake.writes).toEqual([]);
  });
  it("does not publish a result after its deadline and records local interruption", async () => {
    const state = pendingState(); const row = stored(state, 1);
    const fake = fakeDatabase([[row], [{ outcome: "reserved", deadline: now }]], row);
    await expect(finishWebsiteAgentTurn(fake.db, { ...identity, outcome: "completed" })).resolves.toBeNull();
    expect(fake.writes.at(-1)!.value).toMatchObject({ outcome: "failed" });
  });
  it.each(["failed", "cancelled"] as const)("records only a local interruption on %s, never supplied partial native output", async outcome => {
    const state = pendingState(); const row = stored(state, 1);
    const fake = fakeDatabase([[row], [{ outcome: "reserved", deadline }]], row);
    const nativeSession = appendInterruptedNativeWebsiteSession(state.nativeSession, beginInput.query, "Uncertain partial provider answer");
    const result = await finishWebsiteAgentTurn(fake.db, { ...identity, outcome, nativeSession });
    expect(result?.messages.at(-1)?.text).toBe(WEBSITE_AGENT_INTERRUPTED_ANSWER);
    expect(result?.pending).toBeNull();
    expect(fake.writes.at(-1)!.value).toMatchObject({ outcome });
    expect(fake.writes.at(-1)!.value).not.toHaveProperty("reservedCostMicrousd");
    expect(JSON.stringify(fake.writes)).not.toContain("Uncertain partial provider answer");
  });
  it("fails closed on invalid stored ciphertext without reserving or silently resetting history", async () => {
    const row = stored(); row.encryptedState = "bad";
    const fake = fakeDatabase([[row]], row);
    await expect(beginWebsiteAgentTurn(fake.db, beginInput)).rejects.toThrow("session_unavailable");
    expect(fake.writes).toEqual([]);
  });
  it.each(["run", "deadline"])("rejects unauthenticated active lease metadata tampering: %s", async changed => {
    const row = stored(pendingState(), 1);
    if (changed === "run") row.activeRunId = randomUUID();
    else row.activeRunDeadline = new Date(deadline.getTime() + 1);
    const fake = fakeDatabase([[row]], row);
    await expect(loadWebsiteAgentSession(fake.db, accountId, sessionId)).rejects.toThrow("session_unavailable");
    expect(fake.writes).toEqual([]);
  });
  it("reports idle expiry without reviving it or running a model", async () => {
    const row = stored(); row.expiresAt = now;
    const fake = fakeDatabase([[row]], row);
    await expect(loadWebsiteAgentSession(fake.db, accountId, sessionId)).resolves.toMatchObject({ status: "expired", revision: 0, pending: null });
    expect(fake.writes).toEqual([]);
  });
  it("per-operation revalidation scopes owner, run, revision, open lifecycle and both deadlines", async () => {
    const fake = fakeDatabase([[{ id: sessionId }]]);
    await expect(isWebsiteAgentTurnActive(fake.db, identity)).resolves.toBe(true);
    const query = queryText(fake.clauses);
    for (const token of [accountId, sessionId, runId, '"revision"', '"closed_at"', '"expires_at"', '"active_run_deadline"', '"deadline"', '"reserved"']) expect(query).toContain(token);
    await expect(isWebsiteAgentTurnActive(fakeDatabase([[]]).db, identity)).resolves.toBe(false);
    await expect(isWebsiteAgentTurnActive(fakeDatabase().db, { ...identity, sessionId: "guessed" })).resolves.toBe(false);
  });
});
