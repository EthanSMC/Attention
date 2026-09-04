import { describe, expect, it } from "vitest";

import {
  applyAttentionToolResult,
  attentionResultSensitiveFragments,
  collectionControlResult,
  safeCollectionReply,
} from "./collection-reply-control";

const COLLECTION_ID = "11111111-1111-4111-8111-111111111111";

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
        collection: { collection_id: COLLECTION_ID },
        content: {
          content_id: "content-1",
          enrichment_action: "generate_summary",
          public_read_url: "https://example.org/article",
          summary_status: "pending",
        },
      },
    );

    expect(pending).toEqual({
      collectionId: COLLECTION_ID,
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
      collectionId: COLLECTION_ID,
      enrichmentAction: "generate_summary",
      enrichmentCompleted: true,
      kind: "recovery",
      summaryStatus: "pending",
    });
    expect(
      safeCollectionReply(completed!, "摘要已经补全。", {
        phase: "ordinary",
        sensitiveFragments: [],
      }),
    ).toEqual({ accepted: true, reason: null, text: "摘要已经补全。" });
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
          collection: { collection_id: COLLECTION_ID },
          content: {
            content_id: "content-1",
            enrichment_action: enrichmentAction,
            public_read_url: null,
            summary_status: summaryStatus,
          },
        },
      );
      expect(control).not.toBeNull();
      expect(
        safeCollectionReply(control!, expected, {
          phase: "ordinary",
          sensitiveFragments: [],
        }).text,
      ).toBe(expected);
    },
  );

  it("retains only a valid collection id in an established control", () => {
    const control = applyAttentionToolResult(
      null,
      "attention_collect_content",
      {
        collection_id: COLLECTION_ID,
        display_title: "RAW TITLE",
        enrichment_action: "generate_summary",
        public_read_url: "https://example.org/raw",
        status: "accepted",
      },
    );

    expect(control).toEqual({
      collectionId: COLLECTION_ID,
      collectionStatus: "accepted",
      enrichmentAction: "generate_summary",
      enrichmentCompleted: false,
      kind: "established",
    });
    expect(JSON.stringify(control)).not.toMatch(/RAW TITLE|https?:\/\//u);
  });

  it("fails closed when a retryable collection result has no valid UUID", () => {
    expect(
      applyAttentionToolResult(null, "attention_collect_content", {
        collection_id: "collection-1",
        enrichment_action: "generate_summary",
        status: "accepted",
      }),
    ).toEqual({
      kind: "fixed",
      reply: "收藏结果无法确认，请稍后重试。",
    });
  });

  it.each([
    [
      {
        collectionId: COLLECTION_ID,
        collectionStatus: "accepted",
        enrichmentAction: "generate_summary",
        enrichmentCompleted: false,
        kind: "established",
      },
      "retryable_incomplete",
    ],
    [
      {
        collectionId: COLLECTION_ID,
        enrichmentAction: "generate_summary",
        enrichmentCompleted: true,
        kind: "recovery",
        summaryStatus: "pending",
      },
      "completed",
    ],
    [
      {
        collectionId: COLLECTION_ID,
        enrichmentAction: "reuse_summary",
        enrichmentCompleted: false,
        kind: "recovery",
        summaryStatus: "ready",
      },
      "ready",
    ],
    [
      {
        collectionId: COLLECTION_ID,
        enrichmentAction: "none",
        enrichmentCompleted: false,
        kind: "recovery",
        summaryStatus: "hidden",
      },
      "terminal",
    ],
  ] as const)("classifies collection control as %s", (control, expected) => {
    expect(collectionControlResult(control)).toBe(expected);
  });

  it("accepts concise natural prose that honestly schedules the first retry", () => {
    const control = applyAttentionToolResult(
      null,
      "attention_collect_content",
      {
        collection_id: COLLECTION_ID,
        enrichment_action: "generate_summary",
        status: "accepted",
      },
    );
    expect(
      safeCollectionReply(
        control!,
        "收藏成功，这次没补全摘要，约 2 分钟后会自动重试。",
        { phase: "initial_incomplete", sensitiveFragments: [] },
      ),
    ).toEqual({
      accepted: true,
      reason: null,
      text: "收藏成功，这次没补全摘要，约 2 分钟后会自动重试。",
    });
  });

  it.each([
    ["正文见 https://example.org/raw", "reply_contains_url"],
    ["联系 raw@example.org", "reply_contains_email"],
    [`收藏 ${COLLECTION_ID}`, "reply_contains_uuid"],
    ["```json\n{}\n```", "reply_contains_code_block"],
    ['{"tool":"attention_collect_content"}', "reply_contains_tool_shape"],
    ["标题：RAW TITLE", "reply_contains_content_payload"],
    ["收藏成功，RAW_TITLE_SENTINEL", "reply_contains_sensitive_fragment"],
    ["收藏成功，摘要还没好。", "reply_missing_retry_plan"],
  ] as const)("rejects unsafe natural reply: %s", (candidate, reason) => {
    const control = applyAttentionToolResult(
      null,
      "attention_collect_content",
      {
        collection_id: COLLECTION_ID,
        enrichment_action: "generate_summary",
        status: "accepted",
      },
    );
    const result = safeCollectionReply(control!, candidate, {
      phase: "initial_incomplete",
      sensitiveFragments: ["RAW_TITLE_SENTINEL"],
    });
    expect(result).toMatchObject({ accepted: false, reason });
    expect(result.text).toBe(
      "已收藏，但这次没有补全摘要；约 2 分钟后会自动重试。",
    );
  });

  it("extracts bounded sensitive MCP fields without walking arbitrary text", () => {
    expect(
      attentionResultSensitiveFragments({
        collection_id: COLLECTION_ID,
        display_title: "RAW_TITLE_SENTINEL",
        ignored_page_body: "RAW_BODY_SENTINEL",
        nested: {
          original_url: "https://example.org/raw",
          tags: ["RAW_TAG_SENTINEL"],
        },
      }),
    ).toEqual([
      COLLECTION_ID,
      "RAW_TITLE_SENTINEL",
      "https://example.org/raw",
      "RAW_TAG_SENTINEL",
    ]);
  });
});
