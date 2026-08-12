import { describe, expect, it } from "vitest";

import {
  AcceptedResponseSchema,
  AlreadyCollectedResponseSchema,
  MergedWithExistingContentResponseSchema,
} from "./collector-response";
import { AttentionToolSuccessOutputSchemas } from "./attention-tool-output";

const establishedBase = {
  attempt_id: "attempt-1",
  collection_id: "collection-1",
  content_id: "content-1",
  content_type: "article" as const,
  current_visibility: "private" as const,
  received_at: "2026-08-12T00:00:00.000Z",
  source: "generic_web" as const,
};

describe("collector enrichment response contract", () => {
  it.each([
    { label: "accepted", schema: AcceptedResponseSchema, status: "accepted" },
    {
      label: "already collected",
      schema: AlreadyCollectedResponseSchema,
      status: "already_collected",
    },
    {
      label: "merged content",
      schema: MergedWithExistingContentResponseSchema,
      status: "merged_with_existing_content",
    },
  ] as const)("requires enrichment fields for $label", ({ schema, status }) => {
    const withoutEnrichment = schema.safeParse({
      ...establishedBase,
      status,
    });
    expect(withoutEnrichment.success).toBe(false);

    expect(
      schema.parse({
        ...establishedBase,
        enrichment_action: "generate_summary",
        status,
        summary_status: "pending",
      }),
    ).toMatchObject({
      enrichment_action: "generate_summary",
      summary_status: "pending",
    });
  });

  it("accepts only canonical summary statuses and enrichment actions", () => {
    const schema = AcceptedResponseSchema;
    for (const summaryStatus of [
      "ready",
      "pending",
      "unavailable",
      "hidden",
    ] as const) {
      expect(
        schema.safeParse({
          ...establishedBase,
          enrichment_action: "none",
          status: "accepted",
          summary_status: summaryStatus,
        }).success,
      ).toBe(true);
    }
    for (const enrichmentAction of [
      "reuse_summary",
      "generate_summary",
      "none",
    ] as const) {
      expect(
        schema.safeParse({
          ...establishedBase,
          enrichment_action: enrichmentAction,
          status: "accepted",
          summary_status: "pending",
        }).success,
      ).toBe(true);
    }
    expect(
      schema.safeParse({
        ...establishedBase,
        enrichment_action: "overwrite_summary",
        status: "accepted",
        summary_status: "processing",
      }).success,
    ).toBe(false);
  });

  it("defines a strict successful content-enrichment tool output", () => {
    const schema =
      AttentionToolSuccessOutputSchemas.attention_submit_content_enrichment;
    const contentId = "00000000-0000-4000-8000-000000000001";

    expect(
      schema.parse({
        content_id: contentId,
        status: "enriched",
        summary_status: "ready",
      }),
    ).toEqual({
      content_id: contentId,
      status: "enriched",
      summary_status: "ready",
    });
    expect(
      schema.parse({
        content_id: contentId,
        status: "already_enriched",
        summary_status: "ready",
      }),
    ).toMatchObject({ status: "already_enriched" });
    expect(
      schema.safeParse({
        content_id: contentId,
        status: "enriched",
        summary_status: "pending",
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        content_id: contentId,
        status: "overwritten",
        summary_status: "ready",
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        content_id: contentId,
        status: "enriched",
        summary_status: "ready",
        summary: "must not leak through this action response",
      }).success,
    ).toBe(false);
  });
});
