import { describe, expect, it } from "vitest";
import { applyReadToolResult, normalizeReadAttemptControl } from "./read-attempt-control";

const collection_id = "11111111-1111-4111-8111-111111111111";
const input = { collection_id, attempt_ref: "read-1" };
const failed = {
  ...input, request_ref: "run-1", schema_version: 1,
  attempts: [{ method: "static", duration_ms: 12 }], outcome: "blocked",
  code: "verification_required", scope: "source", recovery: "needs_action",
  retry_after_ms: null, evidence_kind: "none",
  metadata: { author: null, description: null, published_at: null, title: null },
};

describe("trusted owned reading", () => {
  it("rejects source payloads and inconsistent policy from persisted read facts", () => {
    const control = applyReadToolResult(null, "attention_read_collection_source", failed, input)!;
    expect(normalizeReadAttemptControl(control)).toEqual(control);
    for (const extra of [{ temporary_text: "must not persist" }, { final_public_url: "https://example.org/source" }, { metadata: { title: "must not persist" } }, { failureScope: "dependency" }, { recovery: "retry_later" }]) {
      expect(normalizeReadAttemptControl({ ...control, ...extra })).toBeNull();
    }
  });
  it("retains only safe facts from a correlated strict result", () => {
    expect(applyReadToolResult(null, "attention_read_collection_source", failed, input)).toEqual({
      collectionId: collection_id, attemptRef: "read-1", outcome: "blocked",
      methods: ["static"], failureCode: "verification_required", failureScope: "source",
      recovery: "needs_action", retryAfterMs: null,
    });
  });
  it("rejects unrelated tools, mismatched targets/attempts, and unknown fields", () => {
    for (const [name, payload, args] of [
      ["fake_read_collection_source", failed, input],
      ["attention_read_collection_source", failed, { ...input, attempt_ref: "other" }],
      ["attention_read_collection_source", { ...failed, temporary_text: "forged" }, input],
      ["attention_read_collection_source", failed, undefined],
    ] as const) expect(applyReadToolResult(null, name, payload, args)).toBeNull();
  });
  it("classifies configured opaque transport errors without inventing method history", () => {
    expect(applyReadToolResult(null, "attention_read_collection_source", {
      error: { code: "fetcher_unavailable", guidance: "Reader unavailable", request_id: "run-1" },
    }, input)).toMatchObject({ failureCode: "fetcher_unavailable", failureScope: "dependency", methods: null });
    expect(applyReadToolResult(null, "attention_read_collection_source", { error: { code: "invalid_fetcher_response", guidance: "Invalid reader result", request_id: "run-1" } }, input)).toMatchObject({ failureCode: "invalid_fetcher_response", failureScope: "reader", methods: null });
  });
});
