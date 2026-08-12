import { describe, expect, it } from "vitest";

import { applyAttentionToolResult } from "./collection-reply-control";

describe("collection reply control", () => {
  it.each([
    ["attention_collect_content", { error: "backend_failed", title: "RAW TITLE" }, "direct error envelope"],
    ["attention_select_collection_candidate", { error: "backend_failed", title: "RAW TITLE" }, "selected error envelope"],
    ["attention_collect_content", { status: "accepted", title: "RAW TITLE" }, "direct missing action"],
    ["attention_select_collection_candidate", { status: "accepted", title: "RAW TITLE" }, "selected missing action"],
    ["attention_collect_content", { enrichment_action: "generate_summary", status: "unexpected" }, "direct unknown status"],
    ["attention_select_collection_candidate", { enrichment_action: "generate_summary", status: "unexpected" }, "selected unknown status"],
  ] as const)("fails closed for a parseable %s", (toolName, payload, _label) => {
    expect(
      applyAttentionToolResult(
        null,
        toolName,
        payload,
      ),
    ).toEqual({
      kind: "fixed",
      reply: "收藏结果无法确认，请稍后重试。",
    });
  });

  it.each([
    "attention_collect_content",
    "attention_select_collection_candidate",
  ] as const)("fails closed for a null %s result", (toolName) => {
    expect(applyAttentionToolResult(null, toolName, null)).toEqual({
      kind: "fixed",
      reply: "收藏结果无法确认，请稍后重试。",
    });
  });

  it("allows ambiguous to continue without replacing the candidate prompt", () => {
    expect(
      applyAttentionToolResult(null, "attention_collect_content", {
        candidates: [{ candidate_id: "candidate-1" }],
        status: "ambiguous",
      }),
    ).toBeNull();
  });
});
