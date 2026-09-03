import { describe, expect, it } from "vitest";

import {
  classifyAttentionMcpFailure,
  defaultAttentionMcpCheckpoint,
  parseAttentionAccountProbe,
} from "./mcp-readiness";

describe("Attention MCP readiness", () => {
  it("parses the structured attention_get_my_account contract", () => {
    expect(
      parseAttentionAccountProbe({
        capabilities: { is_filter: true, is_member: true },
        profile: {
          attention_id: "ethan_01",
          display_name: "Ethan",
          has_avatar: true,
        },
      }),
    ).toEqual({
      attentionId: "ethan_01",
      displayName: "Ethan",
      isFilter: true,
      isMember: true,
    });
  });

  it("accepts an account without a public Attention ID", () => {
    expect(
      parseAttentionAccountProbe({
        capabilities: { is_filter: false, is_member: true },
        profile: {
          attention_id: null,
          display_name: "Member",
          has_avatar: false,
        },
      }),
    ).toEqual({
      attentionId: null,
      displayName: "Member",
      isFilter: false,
      isMember: true,
    });
  });

  it("rejects model prose and malformed account payloads", () => {
    expect(parseAttentionAccountProbe("ATTENTION_ACCOUNT_OK")).toBeNull();
    expect(
      parseAttentionAccountProbe({ profile: { display_name: "Ethan" } }),
    ).toBeNull();
  });

  it.each([
    ["OAuth authorization required", "mcp_auth_required", false],
    ["refresh token rejected: invalid_grant", "mcp_token_refresh_failed", false],
    ["connect ECONNREFUSED 127.0.0.1", "mcp_server_unreachable", true],
    ["HTTP 503 Service Unavailable", "mcp_server_unreachable", true],
    ["initialize request timed out", "mcp_protocol_failed", true],
    ["unexpected tool response", "mcp_account_probe_failed", false],
  ] as const)(
    "classifies a redacted failure: %s",
    (message, errorCode, retryable) => {
      expect(classifyAttentionMcpFailure({ message })).toEqual({
        errorCode,
        retryable,
      });
    },
  );

  it("classifies a structured OAuth error without retaining its request payload", () => {
    expect(
      classifyAttentionMcpFailure({
        error: {
          code: "invalid_token",
          guidance: "Authorize again",
          request_id: "request-private",
        },
      }),
    ).toEqual({ errorCode: "mcp_auth_required", retryable: false });
  });

  it("creates an unknown checkpoint without identity or diagnostic data", () => {
    expect(defaultAttentionMcpCheckpoint()).toEqual({
      lastCheckedAt: null,
      lastErrorCode: null,
      lastReadyAt: null,
      nextRetryAt: null,
      retryAttempt: 0,
      status: "unknown",
    });
  });
});
