import {
  AttentionToolStructuredErrorSchema,
  AttentionToolSuccessOutputSchemas,
  ReadFailureCodeSchema,
  readFailurePolicy,
} from "@attention/contracts";
import type { CollectionReplyControl } from "./collection-reply-control";

/** Safe transient facts only. Opaque errors have unknown, not empty, methods. */
export interface ReadAttemptControl {
  readonly collectionId: string;
  readonly attemptRef: string;
  readonly outcome: "ready" | "blocked" | "failed" | "skipped";
  readonly methods: readonly ("static" | "browser")[] | null;
  readonly failureCode: string | null;
  readonly failureScope: "reader" | "source" | "dependency" | "security" | null;
  readonly recovery: "switch_reader" | "retry_later" | "needs_action" | "pause" | "stop" | null;
  readonly retryAfterMs: number | null;
}

/** The persisted projection is strict and never accepts a source payload. */
export function normalizeReadAttemptControl(value: unknown): ReadAttemptControl | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (Object.keys(r).sort().join() !== "attemptRef,collectionId,failureCode,failureScope,methods,outcome,recovery,retryAfterMs") return null;
  if (typeof r.collectionId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(r.collectionId) ||
    typeof r.attemptRef !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(r.attemptRef)) return null;
  if (!["ready", "blocked", "failed", "skipped"].includes(String(r.outcome))) return null;
  if (r.methods !== null && (!Array.isArray(r.methods) || r.methods.length > 2 || new Set(r.methods).size !== r.methods.length || !r.methods.every((m) => m === "static" || m === "browser"))) return null;
  if (r.retryAfterMs !== null && (typeof r.retryAfterMs !== "number" || !Number.isSafeInteger(r.retryAfterMs) || r.retryAfterMs <= 0 || r.retryAfterMs > 900000 || r.recovery !== "retry_later")) return null;
  if (r.outcome === "ready" || r.outcome === "skipped") {
    if (r.failureCode !== null || r.failureScope !== null || r.retryAfterMs !== null || (r.recovery !== null && !(r.outcome === "skipped" && r.recovery === "stop"))) return null;
    if (!Array.isArray(r.methods) || (r.outcome === "ready" ? r.methods.length === 0 : r.methods.length !== 0)) return null;
  } else {
    const code = ReadFailureCodeSchema.safeParse(r.failureCode);
    if (code.success) {
      const policy = readFailurePolicy(code.data);
      if (r.failureScope !== policy.scope || !policy.allowedRecoveries.some((recovery) => recovery === r.recovery)) return null;
    } else {
      if (!["fetcher_unavailable", "fetcher_timeout", "invalid_fetcher_response", "bridge_dependency_unavailable"].includes(String(r.failureCode)) || r.methods !== null) return null;
      if (r.failureScope !== (r.failureCode === "invalid_fetcher_response" ? "reader" : "dependency") || !["retry_later", "needs_action", "pause"].includes(String(r.recovery))) return null;
    }
  }
  return { ...r, methods: Array.isArray(r.methods) ? [...r.methods] : null } as unknown as ReadAttemptControl;
}

export function collectionControlFromRead(
  current: CollectionReplyControl | null,
  read: ReadAttemptControl | null,
): CollectionReplyControl {
  if (!read) return current ?? { kind: "fixed", reply: "收藏状态无法确认，请稍后重试。" };
  if (current && current.kind !== "fixed" && current.collectionId === read.collectionId) return current;
  return {
    kind: "recovery",
    collectionId: read.collectionId,
    enrichmentAction: "generate_summary",
    enrichmentCompleted: false,
    summaryStatus: "pending",
  };
}

/** Called only by the host protocol adapter with the same tool call's input. */
export function applyReadToolResult(
  current: ReadAttemptControl | null,
  toolName: string,
  payload: unknown,
  input?: unknown,
): ReadAttemptControl | null {
  if (toolName.replace(/^mcp__attention__/u, "") !== "attention_read_collection_source") return current;
  if (!input || typeof input !== "object") return current;
  const args = input as Record<string, unknown>;
  if (
    typeof args.collection_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(args.collection_id) ||
    typeof args.attempt_ref !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(args.attempt_ref)
  ) return current;
  const parsed = AttentionToolSuccessOutputSchemas.attention_read_collection_source.safeParse(payload);
  if (parsed.success) {
    const result = parsed.data;
    if (result.collection_id !== args.collection_id || result.attempt_ref !== args.attempt_ref) return current;
    const failed = result.outcome === "failed" || result.outcome === "blocked";
    return {
      collectionId: result.collection_id,
      attemptRef: result.attempt_ref,
      outcome: result.outcome,
      methods: result.attempts.map((attempt) => attempt.method),
      failureCode: failed ? result.code : null,
      failureScope: failed ? result.scope : null,
      recovery: failed ? result.recovery : result.outcome === "skipped" && result.reason === "not_eligible" ? "stop" : null,
      retryAfterMs: failed ? result.retry_after_ms : null,
    };
  }
  const error = AttentionToolStructuredErrorSchema.safeParse(payload);
  if (!error.success) return current;
  const code = error.data.error.code;
  const dependency = code === "fetcher_unavailable" || code === "fetcher_timeout";
  return {
    collectionId: args.collection_id,
    attemptRef: args.attempt_ref,
    outcome: "failed",
    methods: null,
    failureCode: dependency || code === "permission_revoked" || code === "invalid_fetcher_response" ? code : "unknown_reader_error",
    failureScope: dependency ? "dependency" : code === "permission_revoked" ? "security" : "reader",
    recovery: code === "permission_revoked" ? "stop" : "retry_later",
    retryAfterMs: null,
  };
}
