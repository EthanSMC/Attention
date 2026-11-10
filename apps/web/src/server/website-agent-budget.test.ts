import type { AttentionDatabase, sql } from "@attention/db";
import { afterEach, describe, expect, it, vi } from "vitest";

import { finishWebsiteAgentRun, reserveWebsiteAgentRun, websiteAgentRequestFingerprint } from "./website-agent-budget";

const accountId = "00000000-0000-4000-8000-000000000001";
const operationId = "00000000-0000-4000-8000-000000000002";
const input = { accountId, operationId, requestFingerprint: "a".repeat(64), maxRunCostMicrousd: 400_000,
  dailyCostMicrousd: 1_000_000, timeoutMs: 60_000 };
function queryText(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, child: unknown) => {
    if (child !== null && typeof child === "object") { if (seen.has(child)) return "[circular]"; seen.add(child); }
    return child;
  });
}
function fakeDatabase(results: unknown[][] = [[], [], [{ total: "0" }]]) {
  const selects = [...results];
  const tx = {
    execute: vi.fn(async (query: ReturnType<typeof sql>) => queryText(query).includes("AS busy") ? [{ busy: false }] : []),
    select: vi.fn(() => {
      const result = selects.shift() ?? [];
      const chain = { from: () => chain, where: () => chain, limit: async () => result,
        then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(result).then(resolve) };
      return chain;
    }),
    insert: vi.fn(() => ({ values: vi.fn((value: unknown) => { tx.inserted = value; return { returning: async () => [{ id: operationId }] }; }) })),
    update: vi.fn(() => ({ set: vi.fn((value: unknown) => { tx.updated = value; return { where: async () => [] }; }) })),
    inserted: null as unknown, updated: null as unknown,
  };
  const transaction = vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx));
  return { tx, transaction, db: { transaction } as unknown as AttentionDatabase };
}
afterEach(() => vi.unstubAllEnvs());

describe("website agent durable budget admission", () => {
  it("sets account scope and locks the account before checking prior operations/budgets", async () => {
    const { db, tx } = fakeDatabase();
    expect(await reserveWebsiteAgentRun(db, input)).toBe(operationId);
    const queries = tx.execute.mock.calls.map(args => queryText(args[0]));
    expect(queries[0]).toContain("set_config");
    expect(queries[1]).toContain("pg_advisory_xact_lock");
    expect(vi.mocked(tx.execute).mock.invocationCallOrder[1]).toBeLessThan(tx.select.mock.invocationCallOrder[0]!);
    expect(tx.inserted).toMatchObject({ accountId, operationId, reservedCostMicrousd: 400_000 });
    expect(tx.inserted).not.toHaveProperty("prompt");
  });
  it.each([["a".repeat(64), "operation_already_used"], ["b".repeat(64), "operation_payload_mismatch"]])("never reruns an existing operation: %s", async (fingerprint, code) => {
      const { db, tx } = fakeDatabase([[{ fingerprint }]]);
      await expect(reserveWebsiteAgentRun(db, input)).rejects.toThrow(code);
      expect(tx.insert).not.toHaveBeenCalled();
    });
  it("blocks an overlapping account run", async () => {
    const { db, tx } = fakeDatabase([[], [{ id: operationId }]]);
    await expect(reserveWebsiteAgentRun(db, input)).rejects.toThrow("website_agent_busy");
    expect(tx.insert).not.toHaveBeenCalled();
  });
  it.each(["600001", "NaN", "-1"])("fails closed if reserved daily usage is exhausted or corrupt: %s", async total => {
    const { db, tx } = fakeDatabase([[], [], [{ total }]]);
    await expect(reserveWebsiteAgentRun(db, input)).rejects.toThrow("website_agent_daily_budget_exhausted");
    expect(tx.insert).not.toHaveBeenCalled();
  });
  it("supports the operator's explicit unlimited daily setting without discarding reservation tracking", async () => {
    const { db, tx } = fakeDatabase([[], [], [{ total: "2000000" }]]);
    await expect(reserveWebsiteAgentRun(db, { ...input, dailyCostMicrousd: null })).resolves.toBe(operationId);
    expect(tx.inserted).toMatchObject({ reservedCostMicrousd: 400_000 });
  });
  it("binds a reservation to its server-owned website session", async () => {
    const { db, tx } = fakeDatabase();
    await reserveWebsiteAgentRun(db, { ...input, sessionId: accountId });
    expect(tx.inserted).toMatchObject({ accountId, sessionId: accountId, reservedCostMicrousd: 400_000 });
  });
  it("fingerprints session identity and expected revision as well as the prompt", () => {
    vi.stubEnv("ATTENTION_HMAC_SECRET", "synthetic-32-character-independent-key-value");
    const base = { query: "same query", collect: false, readSources: false, sessionId: accountId, expectedRevision: 0 };
    const fingerprint = websiteAgentRequestFingerprint(base);
    expect(websiteAgentRequestFingerprint({ ...base, sessionId: operationId })).not.toBe(fingerprint);
    expect(websiteAgentRequestFingerprint({ ...base, expectedRevision: 1 })).not.toBe(fingerprint);
  });
  it("finishes an operation without refunding the conservative reservation", async () => {
    const { db, tx } = fakeDatabase(); await finishWebsiteAgentRun(db, accountId, operationId, "cancelled");
    expect(tx.updated).toMatchObject({ outcome: "cancelled" });
    expect(tx.updated).not.toHaveProperty("reservedCostMicrousd");
  });
  it("validates budget/time bounds before opening a transaction", async () => {
    const { db, transaction } = fakeDatabase();
    for (const change of [{ maxRunCostMicrousd: -1 }, { maxRunCostMicrousd: 100_000_001 }, { maxRunCostMicrousd: Infinity },
      { maxRunCostMicrousd: 0.5 }, { timeoutMs: 0 }, { timeoutMs: 120_001 },
      { dailyCostMicrousd: 399_999 }, { dailyCostMicrousd: NaN }]) {
      await expect(reserveWebsiteAgentRun(db, { ...input, ...change })).rejects.toThrow("invalid_website_agent_budget");
    }
    expect(transaction).not.toHaveBeenCalled();
  });
  it("fingerprints exact query and capabilities with HMAC without persisting plaintext", () => {
    vi.stubEnv("ATTENTION_HMAC_SECRET", "synthetic-32-character-independent-key-value");
    const base = { query: "a private query", collect: false, readSources: false };
    const fingerprint = websiteAgentRequestFingerprint(base);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(websiteAgentRequestFingerprint({ ...base, collect: true })).not.toBe(fingerprint);
    expect(websiteAgentRequestFingerprint({ ...base, readSources: true })).not.toBe(fingerprint);
  });
});
