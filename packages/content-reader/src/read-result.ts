import { ReadResultSchema, readFailurePolicy, type ReadBase, type ReadResult, type ReadMetadata,
  type SourceKind } from "@attention/content-reader-contracts";
import type { DocumentEvidence } from "./document-classifier.js";

/** Only a trusted upstream Retry-After value, never a transport-wrapper header. */
export function parseRetryAfter(value: string | undefined, now: number): number | null {
  if (!value || value.length > 128) return null;
  const delay = /^\d+$/u.test(value) ? Number(value) * 1_000
    : /^[A-Za-z]{3}, /u.test(value) ? Date.parse(value) - now : NaN;
  return Number.isFinite(delay) && delay > 0 ? Math.min(900_000, Math.ceil(delay)) : null;
}

export function evidenceMetadata(evidence: DocumentEvidence): ReadMetadata {
  return {title: evidence.title, author: evidence.author?.slice(0, 1_024) ?? null,
    description: evidence.description, published_at: evidence.publishedAt?.toISOString() ?? null};
}

/** Pure formatting only. The caller must validate finalUrl's public-network policy. */
export function evidenceToReadResult(evidence: DocumentEvidence, context: ReadBase & {
  sourceKind: SourceKind; finalUrl: string; readAt: string; exhausted?: boolean; retryAfterMs?: number | null;
}): ReadResult {
  const {schema_version, request_ref, attempt_ref, attempts} = context;
  const base = {schema_version, request_ref, attempt_ref, attempts};
  const metadata = evidenceMetadata(evidence);
  if (evidence.kind === "article") {
    return ReadResultSchema.parse({...base, outcome: "ready", evidence_kind: "article", metadata,
      extraction_method: evidence.extractionMethod, temporary_text: evidence.text, truncated: evidence.truncated,
      final_public_url: context.finalUrl, source_kind: context.sourceKind, read_at: context.readAt});
  }
  const code = evidence.code ?? "unknown_reader_error";
  const policy = readFailurePolicy(code);
  const recovery = context.exhausted && policy.recovery === "switch_reader" ? "pause" : policy.recovery;
  return ReadResultSchema.parse({...base, outcome: evidence.kind === "blocked" ? "blocked" : "failed", code,
    scope: policy.scope, recovery, retry_after_ms: recovery === "retry_later" ? context.retryAfterMs ?? null : null,
    metadata, evidence_kind: Object.values(metadata).some(value => value !== null) ? "metadata_only" : "none"});
}
