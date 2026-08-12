import {
  CollectorResponseSchema,
  InputEnvelopeSchema
} from "@attention/contracts";
import { describe, expect, it } from "vitest";

const metadata = {
  channel: "web" as const,
  sender_account_id: "account-1",
  channel_message_id: "attempt-1",
  received_at: "2026-07-31T10:00:00+08:00",
  parser_version: "v1"
};

describe("InputEnvelopeSchema", () => {
  it("accepts text, URL and structured link-card payloads", () => {
    expect(
      InputEnvelopeSchema.parse({
        ...metadata,
        payload_type: "text",
        raw_payload: "分享 https://example.com"
      }).payload_type
    ).toBe("text");

    expect(
      InputEnvelopeSchema.parse({
        ...metadata,
        payload_type: "url",
        raw_payload: "https://example.com"
      }).payload_type
    ).toBe("url");

    expect(
      InputEnvelopeSchema.parse({
        ...metadata,
        payload_type: "link_card",
        raw_payload: {
          url: "https://mp.weixin.qq.com/s/example",
          title: "低可信标题",
          description: "低可信描述"
        }
      }).payload_type
    ).toBe("link_card");
  });

  it("rejects a payload whose shape does not match payload_type", () => {
    expect(() =>
      InputEnvelopeSchema.parse({
        ...metadata,
        payload_type: "link_card",
        raw_payload: "https://example.com"
      })
    ).toThrow();
  });
});

describe("CollectorResponseSchema", () => {
  it("parses established collection responses with current visibility", () => {
    const response = CollectorResponseSchema.parse({
      attempt_id: "attempt-1",
      received_at: metadata.received_at,
      status: "already_collected",
      content_id: "content-1",
      collection_id: "collection-1",
      source: "generic_web",
      content_type: "web_page",
      current_visibility: "private",
      enrichment_action: "generate_summary",
      public_read_url: "https://example.com/article",
      summary_status: "pending"
    });

    expect(response.status).toBe("already_collected");
    if (response.status === "already_collected") {
      expect(response.current_visibility).toBe("private");
      expect(response.public_read_url).toBe("https://example.com/article");
    }
  });

  it("requires at least two safe display candidates for ambiguity", () => {
    expect(() =>
      CollectorResponseSchema.parse({
        attempt_id: "attempt-1",
        received_at: metadata.received_at,
        status: "ambiguous",
        candidates: [
          {
            candidate_id: "candidate-1",
            source: "generic_web",
            content_type: "web_page",
            display_host: "example.com"
          }
        ],
        selection_token: "x".repeat(32),
        selection_expires_at: "2026-08-01T10:00:00+08:00"
      })
    ).toThrow();
  });

  it("does not accept a raw URL in an unsafe response", () => {
    expect(() =>
      CollectorResponseSchema.parse({
        attempt_id: "attempt-1",
        received_at: metadata.received_at,
        status: "unsafe",
        error_code: "credential_in_url",
        unsafe_url: "https://example.com/?token=secret"
      })
    ).toThrow();
  });
});
