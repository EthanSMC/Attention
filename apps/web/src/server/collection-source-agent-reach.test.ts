import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionDatabase } from "@attention/db";
import type { CollectionStatusResult } from "./collection-status-service";
import { readCollectionSource, type SourceReadContext, type SourceReadPrincipal } from "./collection-source-reader";

const mocks = vi.hoisted(() => ({
  status: vi.fn(), process: vi.fn(), externalRead: vi.fn(),
  coordinator: vi.fn(), consume: vi.fn(), acquire: vi.fn(), heartbeat: vi.fn(), release: vi.fn(),
}));
vi.mock("./collection-status-service", async importOriginal => ({
  ...await importOriginal<typeof import("./collection-status-service")>(),
  getCollectionStatus: mocks.status,
}));
vi.mock("./source-read-coordinator", async importOriginal => ({
  // Use the real per-account memory; only persistent admission is replaced.
  ...await importOriginal<typeof import("./source-read-coordinator")>(),
  createSourceReadCoordinator: mocks.coordinator,
}));
vi.mock("./agent-reach-process", async importOriginal => ({
  ...await importOriginal<typeof import("./agent-reach-process")>(),
  runAgentReachProcess: mocks.process,
}));
vi.mock("./fetcher-client", async importOriginal => ({
  ...await importOriginal<typeof import("./fetcher-client")>(),
  readExternalSource: mocks.externalRead,
}));

const image = `attention/agent-reach@sha256:${"a".repeat(64)}`;
const collectionId = "11111111-1111-4111-8111-111111111111";
const input = { collection_id: collectionId, attempt_ref: "attempt-1" };
const sourceUrl = "https://example.com/core-authorized-article";
const database = {} as AttentionDatabase;
const status = {
  collection: { collection_id: collectionId, collection_status: "active", moderation_status: "clear",
    updated_at: "2026-10-19T00:00:00.000Z", original_url: "https://example.com/old-source" },
  content: { content_id: "22222222-2222-4222-8222-222222222222", updated_at: "2026-10-19T00:00:00.000Z",
    source: "generic_web", enrichment_action: "generate_summary", public_read_url: sourceUrl },
} as CollectionStatusResult;
const article = "Researchers measured the seasonal changes in the garden using independent instruments. They compared their observations with a control group and recorded the uncertainty of every measurement before discussing their results.\n\n" +
  "The findings describe how differences in soil and rainfall affected growth over several months. The report explains the sampling method, identifies missing observations, and gives readers enough context to understand the limits of this experiment.";

function providerResponse(raw: string, title = "Garden observations") {
  const request = JSON.parse(raw) as { url: string; request_ref: string; attempt_ref: string };
  return { schema_version: 1, request_ref: request.request_ref, attempt_ref: request.attempt_ref,
    upstream_version: "1.5.0", outcome: "ok",
    text: `Title: ${title}\n\nURL Source: ${request.url}\n\nMarkdown Content:\n${article}` };
}

function context() {
  const principal: SourceReadPrincipal = { accountId: randomUUID(), scopes: ["collection:read"], isMember: true, isFilter: false };
  const value: SourceReadContext = { accountId: principal.accountId, runId: "run-1", signal: new AbortController().signal,
    getDatabase: () => database, revalidate: async () => principal };
  return { value, principal };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("ATTENTION_AGENT_REACH_IMAGE", image);
  mocks.status.mockResolvedValue(status);
  mocks.coordinator.mockReturnValue({ consumeInvocation: mocks.consume, acquire: mocks.acquire,
    heartbeat: mocks.heartbeat, release: mocks.release });
  mocks.consume.mockResolvedValue({ allowed: true, retryAfterMs: 0 });
  mocks.acquire.mockResolvedValue({ allowed: true, reference: "private-admission-reference" });
  mocks.heartbeat.mockResolvedValue(true);
  mocks.release.mockResolvedValue(undefined);
  mocks.process.mockImplementation(async (raw: string) => providerResponse(raw));
  mocks.externalRead.mockRejectedValue(new Error("The configured direct reader must not call Fetcher"));
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("Core-owned Agent-Reach reading without a database or runtime", () => {
  it.each(["missing", "cross-account", "missing-scope", "missing-entitlement"])(
    "rejects a %s principal before provider execution", async condition => {
      const { value, principal } = context();
      value.revalidate = async () => condition === "missing" ? null : {
        ...principal,
        accountId: condition === "cross-account" ? randomUUID() : principal.accountId,
        scopes: condition === "missing-scope" ? [] : principal.scopes,
        isMember: condition !== "missing-entitlement",
      };
      await expect(readCollectionSource(value, input)).rejects.toMatchObject({ code: "permission_revoked" });
      expect(mocks.status).not.toHaveBeenCalled();
      expect(mocks.coordinator).not.toHaveBeenCalled();
      expect(mocks.process).not.toHaveBeenCalled();
      expect(mocks.externalRead).not.toHaveBeenCalled();
    },
  );

  it("rejects a caller-supplied URL before resolving or reading the collection", async () => {
    await expect(readCollectionSource(context().value, { ...input, url: "https://example.com/caller-chosen" }))
      .rejects.toMatchObject({ code: "invalid_request" });
    expect(mocks.status).not.toHaveBeenCalled();
    expect(mocks.process).not.toHaveBeenCalled();
    expect(mocks.externalRead).not.toHaveBeenCalled();
  });

  it("dispatches the current Core source through the actual configured adapter", async () => {
    const { value, principal } = context();
    const result = await readCollectionSource(value, input);
    expect(result).toMatchObject({ outcome: "ready", collection_id: collectionId, request_ref: "run-1",
      attempts: [{ method: "agent_reach" }], extraction_method: "agent_reach", final_public_url: sourceUrl,
      temporary_text: article });
    expect(mocks.status).toHaveBeenCalledWith(database, principal, { collection_id: collectionId });
    expect(mocks.process).toHaveBeenCalledTimes(1);
    const [raw, configuredImage, signal] = mocks.process.mock.calls[0]!;
    expect(JSON.parse(raw as string)).toEqual({ schema_version: 1, url: sourceUrl, source_kind: "generic_web",
      request_ref: "run-1", attempt_ref: "attempt-1" });
    expect(configuredImage).toBe(image);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(raw).not.toContain(principal.accountId);
    expect(raw).not.toContain("private-admission-reference");
    expect(mocks.externalRead).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("discards completed provider evidence after revalidation revokes the principal", async () => {
    const { value, principal } = context();
    let active = true;
    value.revalidate = async () => active ? principal : null;
    mocks.process.mockImplementationOnce(async (raw: string) => {
      active = false;
      return providerResponse(raw);
    });
    const result = await readCollectionSource(value, input);
    expect(result).toMatchObject({ outcome: "failed", code: "permission_revoked",
      attempts: [{ method: "agent_reach" }], evidence_kind: "none" });
    expect(result).not.toHaveProperty("temporary_text");
    expect(JSON.stringify(result)).not.toContain("Garden observations");
    expect(mocks.release).toHaveBeenCalledTimes(1);
    active = true;
    expect(await readCollectionSource(value, input)).toMatchObject({ outcome: "ready" });
    expect(mocks.process).toHaveBeenCalledTimes(2);
  });

  it("isolates completed evidence by account even when collection and attempt references coincide", async () => {
    const first = context().value, second = context().value;
    let reads = 0;
    mocks.process.mockImplementation(async (raw: string) => providerResponse(raw, `Read ${++reads}`));
    expect(await readCollectionSource(first, input)).toMatchObject({ outcome: "ready", metadata: { title: "Read 1" } });
    expect(await readCollectionSource(second, input)).toMatchObject({ outcome: "ready", metadata: { title: "Read 2" } });
    expect(await readCollectionSource(first, input)).toMatchObject({ metadata: { title: "Read 1" } });
    expect(await readCollectionSource(second, input)).toMatchObject({ metadata: { title: "Read 2" } });
    expect(mocks.process).toHaveBeenCalledTimes(2);
    expect(mocks.acquire).toHaveBeenCalledTimes(2);
    expect(mocks.consume).toHaveBeenCalledTimes(4);
    expect(mocks.acquire.mock.calls.map(([scope]) => scope.accountId)).toEqual([first.accountId, second.accountId]);
    expect(mocks.externalRead).not.toHaveBeenCalled();
  });
});
