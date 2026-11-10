import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReadRequest, ReadResult } from "@attention/content-reader-contracts";
import type { AttentionDatabase } from "@attention/db";
import type * as CollectionStatusModule from "./collection-status-service";
import { SourceReadMemory } from "./source-read-coordinator";
import type { SourceReadDependencies } from "./collection-source-reader";
import { createWebsiteSourceEvidenceRun, parseWebsiteSourceAttestation, assertWebsiteSourceAttestation,
  websiteSourceAttemptRef } from "./website-agent-source-evidence";
import { attestation, ids, runIdentity, status, time, finalUrl } from "../test-support/enrichment-review-fixtures";
const mocks = vi.hoisted(() => ({ status: vi.fn() }));
vi.mock("./collection-status-service", async importOriginal => ({ ...await importOriginal<typeof CollectionStatusModule>(), getCollectionStatus: mocks.status }));

describe("trusted current-run source attestations", () => {
  beforeEach(() => { mocks.status.mockImplementation(async () => status()); vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network"); })); });
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });
  function fixture() {
    let authorized = true;
    const principal = { accountId: ids.account, scopes: ["collection:read"], isMember: true, isFilter: false };
    const context = { accountId: ids.account, runId: "model-supplied-run", signal: new AbortController().signal,
      caller: { credentialId: ids.auth, credentialKind: "session" as const, entrypoint: "hosted_agent" as const, clientId: "website" },
      getDatabase: () => ({} as AttentionDatabase), revalidate: async () => authorized ? principal : null };
    const read = vi.fn(async (request: ReadRequest): Promise<ReadResult> => ({ schema_version: 1,
      request_ref: request.request_ref, attempt_ref: request.attempt_ref, outcome: "ready", evidence_kind: "article",
      source_kind: request.sourceKind, final_public_url: finalUrl, extraction_method: "readability",
      metadata: { title: "Untrusted article title", description: null, author: null, published_at: null },
      temporary_text: "Synthetic source text that must never persist.", read_at: time, truncated: true,
      attempts: [{ method: "static", duration_ms: 1 }] }));
    const deps: SourceReadDependencies = { read, memory: new SourceReadMemory(), coordinator: {
      consumeInvocation: vi.fn(async () => ({ allowed: true, retryAfterMs: 0 })),
      acquire: vi.fn(async () => ({ allowed: true as const, reference: ids.run })), heartbeat: vi.fn(async () => true), release: vi.fn(async () => {}),
      browserInspect: vi.fn(async () => null), browserClaim: vi.fn(async () => null), browserStatus: vi.fn(async () => null), browserRelease: vi.fn(async () => false),
    } };
    return { context, deps, read, revoke: () => { authorized = false; } };
  }
  it("captures only post-auth article metadata and overrides model attempt references", async () => {
    const { context, deps, read } = fixture();
    const run = createWebsiteSourceEvidenceRun(runIdentity, () => new Date(time));
    expect(await run.readCollectionSource(context, { collection_id: ids.collection, attempt_ref: "model-forged-proof" }, deps)).toMatchObject({ outcome: "ready" });
    expect(read.mock.calls[0]?.[0]).toMatchObject({ attempt_ref: websiteSourceAttemptRef(runIdentity, ids.collection), request_ref: `website-evidence:${ids.run}` });
    const evidence = run.evidenceFor(ids.content), serialized = JSON.stringify(evidence);
    expect(evidence).toMatchObject({ ...runIdentity, truncated: true, extractionMethod: "readability", finalPublicUrl: finalUrl });
    expect(Date.parse(evidence.expiresAt) - Date.parse(evidence.observedAt)).toBe(120000);
    expect(serialized).not.toContain("Synthetic source text"); expect(serialized).not.toContain("temporary_text");
    expect(serialized).not.toContain("Untrusted article title");
  });
  it("forces a different server cache key for a different run", async () => {
    const { context, deps, read } = fixture();
    const first = createWebsiteSourceEvidenceRun(runIdentity, () => new Date(time));
    const secondIdentity = { ...runIdentity, originRunId: ids.auth };
    const second = createWebsiteSourceEvidenceRun(secondIdentity, () => new Date(time));
    const input = { collection_id: ids.collection, attempt_ref: "same-model-key" };
    await first.readCollectionSource(context, input, deps); await second.readCollectionSource(context, input, deps);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[0]?.[0].attempt_ref).not.toBe(read.mock.calls[1]?.[0].attempt_ref);
    expect(second.evidenceFor(ids.content).originRunId).toBe(ids.auth);
  });
  it("does not attest an actual article result after final authority revocation", async () => {
    const { context, deps, read, revoke } = fixture(); const original = read.getMockImplementation()!;
    read.mockImplementation(async request => { const result = await original(request); revoke(); return result; });
    const run = createWebsiteSourceEvidenceRun(runIdentity, () => new Date(time));
    expect(await run.readCollectionSource(context, { collection_id: ids.collection, attempt_ref: "a" }, deps)).toMatchObject({ outcome: "failed", code: "permission_revoked" });
    expect(() => run.evidenceFor(ids.content)).toThrow("source_evidence_required");
  });
  it("does not attest metadata-only/login results or user-provided evidence fields", async () => {
    const { context, deps, read } = fixture();
    read.mockImplementation(async request => ({ schema_version: 1, request_ref: request.request_ref, attempt_ref: request.attempt_ref,
      outcome: "blocked", code: "login_required", evidence_kind: "metadata_only", scope: "source", recovery: "needs_action", retry_after_ms: null,
      metadata: { title: "Only a title", description: null, author: null, published_at: null }, attempts: [{ method: "static", duration_ms: 1 }] }));
    const run = createWebsiteSourceEvidenceRun(runIdentity, () => new Date(time));
    expect(await run.readCollectionSource(context, { collection_id: ids.collection, attempt_ref: "a" }, deps)).toMatchObject({ code: "login_required" });
    expect(() => run.evidenceFor(ids.content)).toThrow("source_evidence_required");
    await expect(run.readCollectionSource(context, { collection_id: ids.collection, attempt_ref: "a", evidence_kind: "article" }, deps)).rejects.toThrow();
  });
  it("rejects expired, wrong-owner/run and body-bearing persisted evidence", () => {
    const value = attestation();
    expect(() => assertWebsiteSourceAttestation(value, runIdentity, new Date(value.expiresAt))).toThrow("source_evidence_expired");
    expect(() => assertWebsiteSourceAttestation(value, { ...runIdentity, authSessionId: ids.run }, new Date(time))).toThrow("source_evidence_changed");
    expect(() => parseWebsiteSourceAttestation({ ...value, temporary_text: "forged raw text" })).toThrow("source_evidence_invalid");
    expect(() => parseWebsiteSourceAttestation({ ...value, extractionMethod: "metadata" })).toThrow("source_evidence_invalid");
    expect(() => parseWebsiteSourceAttestation({ ...value, expiresAt: "2026-11-10T12:02:01.000Z" })).toThrow("source_evidence_invalid");
  });
  it("does not permit a reader to mint fresh authority for old evidence", async () => {
    const { context, deps } = fixture();
    const run = createWebsiteSourceEvidenceRun(runIdentity, () => new Date("2026-11-10T12:03:00.000Z"));
    expect(await run.readCollectionSource(context, { collection_id: ids.collection, attempt_ref: "a" }, deps)).toMatchObject({ outcome: "ready" });
    expect(() => run.evidenceFor(ids.content)).toThrow("source_evidence_expired");
  });
});
