import { describe, expect, it } from "vitest";

import {
  applyAttentionToolResult,
  safeCollectionReply,
} from "./collection-reply-control";

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

  it("turns an eligible pending status into automatic enrichment recovery", () => {
    const pending = applyAttentionToolResult(
      null,
      "attention_get_collection_status",
      {
        attempt: null,
        collection: { collection_id: "collection-1" },
        content: {
          content_id: "content-1",
          enrichment_action: "generate_summary",
          public_read_url: "https://example.org/article",
          summary_status: "pending",
        },
      },
    );

    expect(pending).toEqual({
      enrichmentAction: "generate_summary",
      enrichmentCompleted: false,
      kind: "recovery",
      summaryStatus: "pending",
    });
    const completed = applyAttentionToolResult(
      pending,
      "attention_submit_content_enrichment",
      { status: "enriched", summary_status: "ready" },
    );
    expect(completed).toEqual({
      enrichmentAction: "generate_summary",
      enrichmentCompleted: true,
      kind: "recovery",
      summaryStatus: "pending",
    });
    expect(safeCollectionReply(completed!)).toBe("摘要已补全。");
  });

  it.each([
    ["reuse_summary", "ready", "摘要已经就绪。"],
    ["none", "unavailable", "摘要当前无法补全。"],
    ["none", "hidden", "摘要不可用。"],
  ] as const)(
    "returns a fixed content-free recovery reply for %s/%s",
    (enrichmentAction, summaryStatus, expected) => {
      const control = applyAttentionToolResult(
        null,
        "attention_get_collection_status",
        {
          attempt: null,
          collection: { collection_id: "collection-1" },
          content: {
            content_id: "content-1",
            enrichment_action: enrichmentAction,
            public_read_url: null,
            summary_status: summaryStatus,
          },
        },
      );
      expect(control).not.toBeNull();
      expect(safeCollectionReply(control!)).toBe(expected);
    },
  );
});
