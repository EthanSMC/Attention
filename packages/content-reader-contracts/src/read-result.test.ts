import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as contracts from "./read-result";

import {
  isReaderFailureCode,
  ReadRequestSchema,
  ReadResultSchema,
  readFailurePolicy,
} from "./read-result";

const metadata = {
  author: "Example Author",
  description: "A literal article description.",
  published_at: "2026-09-07T08:00:00.000Z",
  title: "Example article",
};

const readyResult = {
  attempt_ref: "attempt-1",
  attempts: [{ duration_ms: 25, method: "static" }],
  evidence_kind: "article",
  extraction_method: "readability",
  final_public_url: "https://example.com/article",
  metadata,
  outcome: "ready",
  read_at: "2026-09-07T08:00:01.000Z",
  request_ref: "request-1",
  schema_version: 1,
  source_kind: "generic_web",
  temporary_text: "A concrete paragraph that can ground a summary.",
  truncated: false,
} as const;

describe("read result contract", () => {
  it("allows truthful preflight failures without inventing reader evidence", () => {
    const failure = {schema_version: 1, request_ref: "request-1", attempt_ref: "attempt-1",
      attempts: [], outcome: "failed", code: "rate_limited", scope: "dependency",
      recovery: "retry_later", retry_after_ms: 1000, evidence_kind: "none",
      metadata: {author: null, description: null, published_at: null, title: null}};
    expect(ReadResultSchema.safeParse(failure).success).toBe(true);
    expect(ReadResultSchema.safeParse({...failure, code: "upstream_5xx"}).success).toBe(false);
    expect(ReadResultSchema.safeParse({...failure, metadata, evidence_kind: "metadata_only"}).success).toBe(false);
  });
  it("extends owned results without dropping strict policy validation or JSON schema", () => {
    expect(contracts).toHaveProperty("OwnedReadResultSchema");
    const schema = (contracts as unknown as {OwnedReadResultSchema: z.ZodType}).OwnedReadResultSchema;
    const owned = {...readyResult, collection_id: "00000000-0000-4000-8000-000000000001"};
    expect(schema.safeParse(owned).success).toBe(true);
    expect(schema.safeParse({...owned, secret: "bad"}).success).toBe(false);
    expect(schema.safeParse({schema_version: 1, request_ref: "request-1", attempt_ref: "attempt-1",
      collection_id: owned.collection_id, attempts: [], outcome: "failed", code: "permission_revoked",
      scope: "dependency", recovery: "retry_later", retry_after_ms: 1000, evidence_kind: "none",
      metadata: {author: null, description: null, published_at: null, title: null}}).success).toBe(false);
    expect(() => z.toJSONSchema(schema, {target: "draft-7"})).not.toThrow();
  });
  it("accepts a strict article-evidence result", () => {
    expect(ReadResultSchema.parse(readyResult)).toEqual(readyResult);
  });

  it("rejects ready results without nonempty article text", () => {
    expect(ReadResultSchema.safeParse({ ...readyResult, temporary_text: "   " }).success)
      .toBe(false);
  });

  it("rejects unknown failure codes", () => {
    expect(ReadResultSchema.safeParse({
      attempt_ref: "attempt-1",
      attempts: [{ duration_ms: 25, method: "static" }],
      code: "made_up_failure",
      evidence_kind: "none",
      metadata: { author: null, description: null, published_at: null, title: null },
      outcome: "failed",
      recovery: "retry_later",
      request_ref: "request-1",
      retry_after_ms: null,
      schema_version: 1,
      scope: "dependency",
    }).success).toBe(false);
    expect(isReaderFailureCode("made_up_failure")).toBe(false);
  });

  it("rejects a failure whose scope or recovery conflicts with its code policy", () => {
    expect(ReadResultSchema.safeParse({
      attempt_ref: "attempt-1",
      attempts: [{ duration_ms: 25, method: "static" }],
      code: "verification_required",
      evidence_kind: "metadata_only",
      metadata,
      outcome: "blocked",
      recovery: "retry_later",
      request_ref: "request-1",
      retry_after_ms: 1_000,
      schema_version: 1,
      scope: "dependency",
    }).success).toBe(false);
    expect(readFailurePolicy("verification_required")).toMatchObject({
      allowedRecoveries: ["needs_action", "pause"],
      recovery: "needs_action",
      scope: "source",
    });
  });

  it("allows only contextual recoveries enumerated by the stable failure policy", () => {
    const backendFailure = {
      attempt_ref: "attempt-1",
      attempts: [{ duration_ms: 25, method: "browser" }],
      code: "browser_backend_unavailable",
      evidence_kind: "none",
      metadata: { author: null, description: null, published_at: null, title: null },
      outcome: "failed",
      request_ref: "request-1",
      retry_after_ms: 5_000,
      schema_version: 1,
      scope: "dependency",
    } as const;
    expect(ReadResultSchema.safeParse({ ...backendFailure, recovery: "retry_later" }).success)
      .toBe(true);
    expect(ReadResultSchema.safeParse({
      ...backendFailure,
      recovery: "needs_action",
      retry_after_ms: null,
    }).success).toBe(false);
  });

  it("rejects more than the static and browser attempts", () => {
    expect(ReadResultSchema.safeParse({
      ...readyResult,
      attempts: [
        { duration_ms: 10, method: "static" },
        { duration_ms: 20, method: "browser" },
        { duration_ms: 30, method: "browser" },
      ],
    }).success).toBe(false);
  });

  it("requires an actual unique reader attempt for ready and failed outcomes", () => {
    expect(ReadResultSchema.safeParse({ ...readyResult, attempts: [] }).success).toBe(false);
    expect(ReadResultSchema.safeParse({
      ...readyResult,
      attempts: [
        { duration_ms: 10, method: "static" },
        { duration_ms: 20, method: "static" },
      ],
    }).success).toBe(false);
  });

  it("rejects empty metadata strings instead of relabeling them as evidence", () => {
    expect(ReadResultSchema.safeParse({
      ...readyResult,
      metadata: { ...metadata, description: "   " },
    }).success).toBe(false);
  });

  it("rejects raw exception fields from every result branch", () => {
    expect(ReadResultSchema.safeParse({
      ...readyResult,
      error: "private upstream exception",
      stack: "secret stack",
    }).success).toBe(false);
  });

  it.each([
    { ...readyResult, final_public_url: "https://user:secret@example.com/article" },
    { ...readyResult, final_public_url: "file:///tmp/private" },
    { ...readyResult, extraction_method: "arbitrary_script" },
    { ...readyResult, source_kind: "unknown_source" },
    { ...readyResult, attempts: [{ duration_ms: Number.POSITIVE_INFINITY, method: "static" }] },
  ])("rejects unsafe or unbounded ready data", (candidate) => {
    expect(ReadResultSchema.safeParse(candidate).success).toBe(false);
  });

  it("accepts only the trusted internal request fields", () => {
    const request = {
      attempt_ref: "attempt-1",
      request_ref: "request-1",
      sourceKind: "wechat_official_article",
      url: "https://mp.weixin.qq.com/s/example",
    } as const;
    expect(ReadRequestSchema.parse(request)).toEqual(request);
    expect(ReadRequestSchema.safeParse({ ...request, headers: { cookie: "private" } }).success)
      .toBe(false);
    expect(ReadRequestSchema.safeParse({
      ...request,
      url: "https://user:secret@example.com/article",
    }).success).toBe(false);
  });

  it.each([
    { request_ref: "private/url?token=value" },
    { attempt_ref: "a".repeat(129) },
    { temporary_text: "a".repeat(12_001) },
    { metadata: { ...metadata, author: "a".repeat(1_025) } },
    { attempts: [{ duration_ms: -1, method: "static" }] },
    { attempts: [{ duration_ms: 90_001, method: "static" }] },
  ])("enforces bounded references, evidence and reader duration", (invalidFields) => {
    expect(ReadResultSchema.safeParse({ ...readyResult, ...invalidFields }).success).toBe(false);
  });

  it("accepts an already-ready skip without executing a reader", () => {
    const skipped = {
      schema_version: 1,
      request_ref: "request-1",
      attempt_ref: "attempt-1",
      attempts: [],
      outcome: "skipped",
      reason: "already_ready",
    };
    expect(ReadResultSchema.parse(skipped)).toEqual(skipped);
    expect(ReadResultSchema.safeParse({ ...skipped, error: "private" }).success).toBe(false);
  });

  it.each([0, -1, 900_001, Number.POSITIVE_INFINITY])("rejects invalid retry delay %s", (retry_after_ms) => {
    expect(ReadResultSchema.safeParse({
      schema_version: 1,
      request_ref: "request-1",
      attempt_ref: "attempt-1",
      attempts: [{ duration_ms: 10, method: "static" }],
      outcome: "failed",
      code: "rate_limited",
      scope: "dependency",
      recovery: "retry_later",
      evidence_kind: "none",
      metadata: { author: null, title: null, description: null, published_at: null },
      retry_after_ms,
    }).success).toBe(false);
  });
});
