import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionDatabase } from "@attention/db";
import type { CollectionStatusResult } from "./collection-status-service";
import { readCollectionSource, type SourceReadContext } from "./collection-source-reader";

// Real runtime/upstream/network; only database-backed authority and admission use
// synthetic records. This suite cannot be enabled by normal unit-test execution.
const enabled = process.env.ATTENTION_AGENT_REACH_REAL_SMOKE === "1";
const mocks = vi.hoisted(() => ({ status: vi.fn(), coordinator: vi.fn(), externalRead: vi.fn() }));
// No real database export is available in this public synthetic smoke harness.
vi.mock("@attention/db", () => ({}));
vi.mock("./collection-status-service", async importOriginal => ({
  ...await importOriginal<typeof import("./collection-status-service")>(), getCollectionStatus: mocks.status,
}));
vi.mock("./source-read-coordinator", async importOriginal => ({
  ...await importOriginal<typeof import("./source-read-coordinator")>(), createSourceReadCoordinator: mocks.coordinator,
}));
vi.mock("./fetcher-client", async importOriginal => ({
  ...await importOriginal<typeof import("./fetcher-client")>(), readExternalSource: mocks.externalRead,
}));

const approvedUrls = ["https://www.python.org/doc/essays/blurb/", "https://example.com/"] as const;
async function reserveAttempt(url: typeof approvedUrls[number]) {
  const recordPath = process.env.ATTENTION_AGENT_REACH_LIVE_RECORD;
  if (!recordPath) throw new Error("A durable public-test attempt record is required");
  let record: Record<string, number> = {};
  try { record = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, number>; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const attempts = record[url] ?? 0;
  if (!Number.isInteger(attempts) || attempts < 0 || attempts >= 2) throw new Error("Approved public-test attempt limit reached");
  record[url] = attempts + 1;
  await writeFile(recordPath, JSON.stringify(record, null, 2) + "\n");
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.coordinator.mockReturnValue({
    consumeInvocation: async () => ({ allowed: true, retryAfterMs: 0 }),
    acquire: async () => ({ allowed: true, reference: "synthetic-local-admission" }),
    heartbeat: async () => true, release: async () => undefined,
  });
  mocks.externalRead.mockRejectedValue(new Error("The live direct reader must not call Fetcher"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  // Preserve the approved request spacing even when a preceding assertion fails.
  if (enabled) await new Promise(resolve => setTimeout(resolve, 5_000));
});

describe.skipIf(!enabled).sequential("approved public Agent-Reach read through the actual Attention gateway", () => {
  it.each(approvedUrls)("reads only the approved public source %s", async url => {
    if (!/^sha256:[a-f0-9]{64}$/u.test(process.env.ATTENTION_AGENT_REACH_IMAGE ?? "")) {
      throw new Error("The approved local immutable image ID is required");
    }
    await reserveAttempt(url);
    const collectionId = randomUUID(), accountId = randomUUID();
    const status = {
      collection: { collection_id: collectionId, collection_status: "active", moderation_status: "clear",
        updated_at: "2026-10-19T00:00:00.000Z" },
      content: { content_id: randomUUID(), updated_at: "2026-10-19T00:00:00.000Z", source: "generic_web",
        enrichment_action: "generate_summary", public_read_url: url },
    } as CollectionStatusResult;
    mocks.status.mockResolvedValue(status);
    const context: SourceReadContext = {
      accountId, runId: "public-smoke-request", signal: new AbortController().signal,
      getDatabase: () => ({} as AttentionDatabase),
      revalidate: async () => ({ accountId, scopes: ["collection:read"], isMember: true, isFilter: false }),
    };
    const result = await readCollectionSource(context, {collection_id: collectionId, attempt_ref: "public-smoke-attempt"});
    const evidence = result.outcome === "ready" ? result.temporary_text : "";
    // Only approved URL, stable outcome, size and evidence hash enter the report.
    console.info("AGENT_REACH_LIVE_RESULT", JSON.stringify({url, outcome: result.outcome,
      code: "code" in result ? result.code : null, attempts: result.attempts,
      evidence_characters: evidence.length, evidence_sha256: evidence ? createHash("sha256").update(evidence).digest("hex") : null}));
    expect(mocks.externalRead).not.toHaveBeenCalled();
    expect(result.attempts).toEqual([expect.objectContaining({ method: "agent_reach" })]);
    if (url === approvedUrls[0]) {
      expect(result.outcome).toBe("ready");
      if (result.outcome === "ready") {
        expect(result.final_public_url).toBe(url);
        expect(result.temporary_text).toContain("Python");
      }
    } else expect(result).toMatchObject({outcome: "failed", code: "evidence_insufficient"});
  }, 70_000);
});
