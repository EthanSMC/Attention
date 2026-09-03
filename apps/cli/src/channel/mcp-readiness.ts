import {
  AttentionToolStructuredErrorSchema,
  AttentionToolSuccessOutputSchemas,
} from "@attention/contracts";

export type AttentionMcpStatus =
  | "unknown"
  | "checking"
  | "ready"
  | "reconnecting"
  | "auth_required"
  | "unreachable"
  | "tool_error";

export type AttentionMcpErrorCode =
  | "mcp_auth_required"
  | "mcp_token_refresh_failed"
  | "mcp_server_unreachable"
  | "mcp_protocol_failed"
  | "mcp_account_probe_failed";

export interface VerifiedAttentionAccount {
  attentionId: string | null;
  displayName: string;
  isFilter: boolean;
  isMember: boolean;
}

export interface AttentionMcpFailure {
  errorCode: AttentionMcpErrorCode;
  retryable: boolean;
}

export type AttentionMcpProbeResult =
  | { account: VerifiedAttentionAccount; ok: true }
  | ({ ok: false } & AttentionMcpFailure);

export interface AttentionMcpCheckpoint {
  lastCheckedAt: string | null;
  lastErrorCode: AttentionMcpErrorCode | null;
  lastReadyAt: string | null;
  nextRetryAt: string | null;
  retryAttempt: number;
  status: AttentionMcpStatus;
}

export function defaultAttentionMcpCheckpoint(): AttentionMcpCheckpoint {
  return {
    lastCheckedAt: null,
    lastErrorCode: null,
    lastReadyAt: null,
    nextRetryAt: null,
    retryAttempt: 0,
    status: "unknown",
  };
}

export function parseAttentionAccountProbe(
  value: unknown,
): VerifiedAttentionAccount | null {
  const parsed =
    AttentionToolSuccessOutputSchemas.attention_get_my_account.safeParse(value);
  if (!parsed.success) return null;
  return {
    attentionId: parsed.data.profile.attention_id,
    displayName: parsed.data.profile.display_name,
    isFilter: parsed.data.capabilities.is_filter,
    isMember: parsed.data.capabilities.is_member,
  };
}

export function classifyAttentionMcpFailure(
  value: unknown,
): AttentionMcpFailure {
  const structured = AttentionToolStructuredErrorSchema.safeParse(value);
  const structuredCode = structured.success ? structured.data.error.code : "";
  const message = failureText(value);
  const evidence = `${structuredCode} ${message}`.toLowerCase();

  if (/invalid_grant|refresh[ _-]?token|token refresh/u.test(evidence)) {
    return { errorCode: "mcp_token_refresh_failed", retryable: false };
  }
  if (
    /invalid[ _-]?token|oauth.{0,32}required|authorization required|authentication required|unauthori[sz]ed|missing oauth|\b401\b/u.test(
      evidence,
    )
  ) {
    return { errorCode: "mcp_auth_required", retryable: false };
  }
  if (
    /econnrefused|econnreset|enotfound|dns|network|fetch failed|connection (?:closed|failed|refused|reset)|service unavailable|bad gateway|gateway timeout|\b50[234]\b/u.test(
      evidence,
    )
  ) {
    return { errorCode: "mcp_server_unreachable", retryable: true };
  }
  if (
    /initialize|initialization|handshake|protocol|tool discovery|tools\/list|timed? out|timeout/u.test(
      evidence,
    )
  ) {
    return { errorCode: "mcp_protocol_failed", retryable: true };
  }
  return { errorCode: "mcp_account_probe_failed", retryable: false };
}

function failureText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return "";
  const record = value as Readonly<Record<string, unknown>>;
  const direct = [record.code, record.message, record.error]
    .filter((item): item is string => typeof item === "string")
    .join(" ");
  if (direct) return direct;
  if (record.error !== null && typeof record.error === "object") {
    const error = record.error as Readonly<Record<string, unknown>>;
    return [error.code, error.message, error.guidance]
      .filter((item): item is string => typeof item === "string")
      .join(" ");
  }
  return "";
}
