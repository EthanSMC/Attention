import { z } from "zod";

export const ReadMethodSchema = z.enum(["static", "browser"]);
export type ReadMethod = z.infer<typeof ReadMethodSchema>;

export const ReadFailureCodeSchema = z.enum([
  "reader_unsupported",
  "render_required",
  "network_timeout",
  "dns_failure",
  "upstream_5xx",
  "rate_limited",
  "source_content_pending",
  "login_required",
  "verification_required",
  "access_denied",
  "source_not_found",
  "source_gone",
  "unsafe_source",
  "permission_revoked",
  "content_ineligible",
  "evidence_insufficient",
  "unknown_reader_error",
  "reader_not_configured",
  "browser_backend_unavailable",
]);
export type ReadFailureCode = z.infer<typeof ReadFailureCodeSchema>;

export const ReadRecoverySchema = z.enum([
  "switch_reader",
  "retry_later",
  "needs_action",
  "pause",
  "stop",
]);
export type ReadRecovery = z.infer<typeof ReadRecoverySchema>;

export const ReadFailureScopeSchema = z.enum([
  "reader",
  "source",
  "dependency",
  "security",
]);
export type ReadFailureScope = z.infer<typeof ReadFailureScopeSchema>;

export const SourceKindSchema = z.enum([
  "generic_web",
  "wechat_official_article",
  "xiaohongshu",
  "douyin",
]);
export type SourceKind = z.infer<typeof SourceKindSchema>;

export const ExtractionMethodSchema = z.enum([
  "readability",
  "json_ld",
  "semantic_html",
  "body",
  "metadata",
  "none",
]);
export type ExtractionMethod = z.infer<typeof ExtractionMethodSchema>;

export const SafeReferenceSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

const SafePublicUrlSchema = z.string().min(1).max(4_096).superRefine((value, context) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    context.addIssue({ code: "custom", message: "Expected an absolute HTTP(S) URL" });
    return;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    context.addIssue({ code: "custom", message: "Expected an HTTP(S) URL without credentials" });
  }
});

export const ReadAttemptSchema = z.object({
  duration_ms: z.number().finite().int().nonnegative().max(90_000),
  method: ReadMethodSchema,
}).strict();
export type ReadAttempt = z.infer<typeof ReadAttemptSchema>;

const ReadAttemptsSchema = z.array(ReadAttemptSchema).max(2).superRefine((attempts, context) => {
  if (new Set(attempts.map((attempt) => attempt.method)).size !== attempts.length) {
    context.addIssue({ code: "custom", message: "A read method can only be attempted once" });
  }
});

function metadataText(maxLength: number) {
  return z.string().min(1).max(maxLength).refine((value) => value.trim().length > 0).nullable();
}

export const ReadMetadataSchema = z.object({
  author: metadataText(1_024),
  description: metadataText(4_096),
  published_at: z.string().max(64).datetime({ offset: true }).nullable(),
  title: metadataText(4_096),
}).strict();
export type ReadMetadata = z.infer<typeof ReadMetadataSchema>;

const ReadBaseShape = {
  attempt_ref: SafeReferenceSchema,
  request_ref: SafeReferenceSchema,
  schema_version: z.literal(1),
};

const ReadyReadResultSchema = z.object({
  ...ReadBaseShape,
  attempts: ReadAttemptsSchema.refine((attempts) => attempts.length > 0),
  evidence_kind: z.literal("article"),
  extraction_method: ExtractionMethodSchema.exclude(["metadata", "none"]),
  final_public_url: SafePublicUrlSchema,
  metadata: ReadMetadataSchema,
  outcome: z.literal("ready"),
  read_at: z.string().max(64).datetime({ offset: true }),
  source_kind: SourceKindSchema,
  temporary_text: z.string().min(1).max(12_000).refine((value) => value.trim().length > 0),
  truncated: z.boolean(),
}).strict();

const FailedReadResultSchema = z.object({
  ...ReadBaseShape,
  attempts: ReadAttemptsSchema,
  code: ReadFailureCodeSchema,
  evidence_kind: z.enum(["metadata_only", "none"]),
  metadata: ReadMetadataSchema,
  outcome: z.enum(["blocked", "failed"]),
  recovery: ReadRecoverySchema,
  retry_after_ms: z.number().finite().int().positive().max(900_000).nullable(),
  scope: ReadFailureScopeSchema,
}).strict();

const SkippedReadResultSchema = z.object({
  ...ReadBaseShape,
  attempts: z.array(ReadAttemptSchema).max(0),
  outcome: z.literal("skipped"),
  reason: z.enum(["already_ready", "not_eligible"]),
}).strict();

const FAILURE_POLICIES = {
  access_denied: { allowedRecoveries: ["pause"], recovery: "pause", scope: "source" },
  browser_backend_unavailable: {
    allowedRecoveries: ["pause", "retry_later"], recovery: "pause", scope: "dependency",
  },
  content_ineligible: { allowedRecoveries: ["stop"], recovery: "stop", scope: "security" },
  dns_failure: {
    allowedRecoveries: ["retry_later", "pause"], recovery: "retry_later", scope: "dependency",
  },
  evidence_insufficient: {
    allowedRecoveries: ["switch_reader", "pause"], recovery: "switch_reader", scope: "source",
  },
  login_required: {
    allowedRecoveries: ["needs_action", "pause"], recovery: "needs_action", scope: "source",
  },
  network_timeout: {
    allowedRecoveries: ["retry_later", "pause"], recovery: "retry_later", scope: "dependency",
  },
  permission_revoked: { allowedRecoveries: ["stop"], recovery: "stop", scope: "security" },
  rate_limited: {
    allowedRecoveries: ["retry_later", "pause"], recovery: "retry_later", scope: "dependency",
  },
  reader_not_configured: {
    allowedRecoveries: ["pause"], recovery: "pause", scope: "dependency",
  },
  reader_unsupported: {
    allowedRecoveries: ["switch_reader", "pause"], recovery: "switch_reader", scope: "reader",
  },
  render_required: {
    allowedRecoveries: ["switch_reader", "pause"], recovery: "switch_reader", scope: "reader",
  },
  source_content_pending: {
    allowedRecoveries: ["retry_later", "pause"], recovery: "retry_later", scope: "source",
  },
  source_gone: { allowedRecoveries: ["stop"], recovery: "stop", scope: "source" },
  source_not_found: { allowedRecoveries: ["stop"], recovery: "stop", scope: "source" },
  unknown_reader_error: {
    allowedRecoveries: ["retry_later", "pause"], recovery: "retry_later", scope: "reader",
  },
  unsafe_source: { allowedRecoveries: ["stop"], recovery: "stop", scope: "security" },
  upstream_5xx: {
    allowedRecoveries: ["retry_later", "pause"], recovery: "retry_later", scope: "dependency",
  },
  verification_required: {
    allowedRecoveries: ["needs_action", "pause"], recovery: "needs_action", scope: "source",
  },
} as const satisfies Record<ReadFailureCode, {
  allowedRecoveries: readonly ReadRecovery[];
  recovery: ReadRecovery;
  scope: ReadFailureScope;
}>;

export function readFailurePolicy(code: ReadFailureCode): {
  allowedRecoveries: readonly ReadRecovery[];
  recovery: ReadRecovery;
  scope: ReadFailureScope;
} {
  return FAILURE_POLICIES[code];
}

export function isReaderFailureCode(value: unknown): value is ReadFailureCode {
  return ReadFailureCodeSchema.safeParse(value).success;
}

const ReadResultBranches = z.discriminatedUnion("outcome", [ReadyReadResultSchema, FailedReadResultSchema, SkippedReadResultSchema]);
function validateReadPolicy(result: z.infer<typeof ReadResultBranches>, context: z.RefinementCtx) {
  if (result.outcome === "ready" || result.outcome === "skipped") return;
  const policy = readFailurePolicy(result.code);
  if (result.attempts.length === 0 && (
    !["rate_limited", "reader_not_configured", "permission_revoked", "content_ineligible",
      "unsafe_source"].includes(result.code) || result.evidence_kind !== "none"
  )) {
    context.addIssue({code: "custom", path: ["attempts"], message: "Only evidence-free preflight failures may omit attempts"});
  }
  if (result.scope !== policy.scope) {
    context.addIssue({ code: "custom", path: ["scope"], message: "Scope conflicts with code" });
  }
  if (!policy.allowedRecoveries.includes(result.recovery)) {
    context.addIssue({
      code: "custom",
      path: ["recovery"],
      message: "Recovery conflicts with code",
    });
  }
  if (result.recovery !== "retry_later" && result.retry_after_ms !== null) {
    context.addIssue({
      code: "custom",
      path: ["retry_after_ms"],
      message: "Retry-After is only valid for retry_later failures",
    });
  }
  const hasMetadata = Object.values(result.metadata).some((value) => value !== null);
  if ((result.evidence_kind === "metadata_only") !== hasMetadata) {
    context.addIssue({
      code: "custom",
      path: ["evidence_kind"],
      message: "Evidence kind conflicts with metadata",
    });
  }
}
export const ReadResultSchema = ReadResultBranches.superRefine(validateReadPolicy);
const ownedShape = {collection_id: z.string().uuid()};
export const OwnedReadResultSchema = z.discriminatedUnion("outcome", [
  ReadyReadResultSchema.extend(ownedShape), FailedReadResultSchema.extend(ownedShape), SkippedReadResultSchema.extend(ownedShape),
]).superRefine(validateReadPolicy);
export type OwnedReadResult = z.infer<typeof OwnedReadResultSchema>;
export type ReadResult = z.infer<typeof ReadResultSchema>;
export type ReadBase = Pick<ReadResult, "schema_version" | "request_ref" | "attempt_ref" | "attempts">;

export const ReadRequestSchema = z.object({
  attempt_ref: SafeReferenceSchema,
  request_ref: SafeReferenceSchema,
  sourceKind: SourceKindSchema,
  url: SafePublicUrlSchema,
}).strict();
export type ReadRequest = z.infer<typeof ReadRequestSchema>;
