import { classifyDocument, evidenceMetadata, evidenceToReadResult, parseRetryAfter, type DocumentEvidence } from "@attention/content-reader";
export { parseRetryAfter } from "@attention/content-reader";
import { ReadResultSchema, readFailurePolicy, type ReadRequest, type ReadResult,
  type ReadFailureCode, type ReadAttempt, type ReadMetadata } from "@attention/content-reader-contracts";
import { FetcherError } from "./errors.js";
import type { safeFetch } from "./safe-fetch.js";
import { assertNoHttpsDowngrade, parseAndValidateUrl } from "./url-policy.js";

export interface BrowserReader {
  // Must settle only after the renderer and all broker operations are cleaned up.
  read(input: {url: string; sourceKind: ReadRequest["sourceKind"]; signal: AbortSignal; renderer_ref?: string}):
    Promise<{html: string; finalUrl: string; status: number}>;
}

export class BrowserUnavailableError extends Error {
  constructor(readonly configured: boolean) { super("Browser backend unavailable"); }
}
export class BrowserCapacityError extends Error {
  constructor(readonly retryAfterMs: number) {super("reader_capacity_limited");}
}

function failureCode(error: unknown): ReadFailureCode {
  if (error instanceof BrowserCapacityError) return "rate_limited";
  if (error instanceof BrowserUnavailableError) return "browser_backend_unavailable";
  if (!(error instanceof FetcherError)) return "unknown_reader_error";
  switch (error.code) {
    case "timeout": return "network_timeout";
    case "dns_failure": return "dns_failure";
    case "unsupported_content_type": return "reader_unsupported";
    case "invalid_url": case "unsupported_protocol": case "unsupported_port":
    case "unsafe_credentials": case "unsafe_hostname": case "unsafe_address":
    case "https_downgrade": return "unsafe_source";
    default: return "unknown_reader_error";
  }
}

export async function readDocument(input: ReadRequest & {signal: AbortSignal}, deps: {
  staticRead: typeof safeFetch; browser: BrowserReader | null; now: () => number;
}): Promise<ReadResult> {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, input.signal]);
  const timer = setTimeout(() => controller.abort(), 90_000);
  const attempts: ReadAttempt[] = [];
  let metadata: ReadMetadata = {title: null, author: null, description: null, published_at: null};
  let evidence: DocumentEvidence | null = null;
  let retryAfter: number | null = null;
  const base = {schema_version: 1 as const, request_ref: input.request_ref, attempt_ref: input.attempt_ref, attempts};
  const failed = (code: ReadFailureCode, pause = false): ReadResult => {
    const policy = readFailurePolicy(code);
    const recovery = pause && policy.allowedRecoveries.includes("pause") ? "pause" : policy.recovery;
    return ReadResultSchema.parse({...base, outcome: evidence?.kind === "blocked" ? "blocked" : "failed", code,
      recovery, scope: policy.scope, retry_after_ms: recovery === "retry_later" ? retryAfter : null,
      metadata, evidence_kind: Object.values(metadata).some(v => v !== null) ? "metadata_only" : "none"});
  };
  try {
    for (const method of ["static", "browser"] as const) {
      const start = deps.now();
      let finalUrl: string;
      try {
        signal.throwIfAborted();
        const initial = parseAndValidateUrl(input.url, input.sourceKind);
        const response = method === "static"
          ? await deps.staticRead(input.url, input.sourceKind, "read", {signal})
          : await deps.browser!.read({url: input.url, sourceKind: input.sourceKind, signal});
        signal.throwIfAborted();
        const target = parseAndValidateUrl(response.finalUrl, input.sourceKind);
        assertNoHttpsDowngrade(initial, target);
        finalUrl = target.toString();
        const html = "html" in response ? response.html : response.body ?? "";
        if (Buffer.byteLength(html) > 2 * 1024 * 1024) throw new FetcherError("response_too_large", "Snapshot exceeds limit");
        retryAfter = "retryAfter" in response && typeof response.retryAfter === "string" ? parseRetryAfter(response.retryAfter, deps.now()) : null;
        evidence = classifyDocument({html, finalUrl, sourceKind: input.sourceKind, status: response.status});
        metadata = evidenceMetadata(evidence);
      } catch (error) {
        if (error instanceof BrowserCapacityError) retryAfter = error.retryAfterMs;
        attempts.push({method, duration_ms: Math.min(90_000, Math.max(0, Math.round(deps.now() - start)))});
        const code = error instanceof BrowserUnavailableError ? failureCode(error)
          : signal.aborted ? "network_timeout" : failureCode(error);
        if (method === "static" && code === "reader_unsupported") {
          if (!deps.browser) return failed("browser_backend_unavailable", true);
          continue;
        }
        const result = failed(code);
        if (error instanceof BrowserUnavailableError && error.configured && result.outcome === "failed") {
          return {...result, recovery: "retry_later"};
        }
        return result;
      }
      attempts.push({method, duration_ms: Math.min(90_000, Math.max(0, Math.round(deps.now() - start)))});
      if (evidence.kind === "article") {
        return evidenceToReadResult(evidence, {...base, finalUrl, sourceKind: input.sourceKind, readAt: new Date(deps.now()).toISOString()});
      }
      const code = evidence.code ?? "unknown_reader_error";
      const canSwitch = evidence.kind !== "blocked" && ["render_required", "reader_unsupported", "evidence_insufficient"].includes(code);
      if (method === "browser" || !canSwitch) return failed(code, canSwitch);
      if (!deps.browser) return failed("browser_backend_unavailable", true);
    }
    return failed("unknown_reader_error");
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
