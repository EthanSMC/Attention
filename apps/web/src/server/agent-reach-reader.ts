import "server-only";

import { ReadRequestSchema, ReadResultSchema, readFailurePolicy, type ReadFailureCode,
  type ReadRequest, type ReadResult } from "@attention/content-reader-contracts";
import { parseAndValidateUrl } from "@attention/fetcher/url-policy";
import { adaptAgentReachResult } from "./agent-reach-result";
import { AGENT_REACH_IMAGE_PATTERN, AgentReachProcessError, runAgentReachProcess } from "./agent-reach-process";
import { readExternalSource } from "./fetcher-client";

type ReadOptions = { signal: AbortSignal; admissionReference: string };

/** Called only after Core has resolved ownership, eligibility and admission. Unset means the existing reader. */
export async function readConfiguredCollectionSource(request: ReadRequest, options: ReadOptions): Promise<ReadResult> {
  const image = process.env.ATTENTION_AGENT_REACH_IMAGE;
  if (!image) return readExternalSource(request, options);
  return readAgentReachSource(request, options, image);
}

export async function readAgentReachSource(request: ReadRequest, options: ReadOptions, image: string,
  run: typeof runAgentReachProcess = runAgentReachProcess): Promise<ReadResult> {
  const valid = ReadRequestSchema.parse(request);
  const started = performance.now();
  const failure = (code: ReadFailureCode, attempted = false): ReadResult => {
    const policy = readFailurePolicy(code);
    return ReadResultSchema.parse({schema_version: 1, request_ref: valid.request_ref, attempt_ref: valid.attempt_ref,
      attempts: attempted ? [{method: "agent_reach", duration_ms: Math.min(90_000, Math.round(performance.now() - started))}] : [],
      outcome: "failed", code, scope: policy.scope, recovery: policy.recovery, retry_after_ms: null,
      evidence_kind: "none", metadata: {author: null, title: null, description: null, published_at: null}});
  };
  options.signal.throwIfAborted();
  let url: URL;
  try { url = parseAndValidateUrl(valid.url, valid.sourceKind); }
  catch { return failure("unsafe_source"); }
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (valid.sourceKind === "xiaohongshu" || /(^|\.)(xiaohongshu\.com|xhslink\.com)$/u.test(host)) {
    return failure("reader_not_configured");
  }
  if (!AGENT_REACH_IMAGE_PATTERN.test(image)) return failure("reader_not_configured");
  // Only the public source and opaque references cross the process boundary, never principal or admission credentials.
  url.hash = "";
  const input = JSON.stringify({schema_version: 1, url: url.toString(), source_kind: valid.sourceKind,
    request_ref: valid.request_ref, attempt_ref: valid.attempt_ref});
  try {
    const result = await run(input, image, options.signal);
    options.signal.throwIfAborted();
    return adaptAgentReachResult(result, {...valid, url: url.toString()}, Math.round(performance.now() - started));
  } catch (error) {
    if (error instanceof AgentReachProcessError && error.cleanupUnconfirmed) {
      // A stable operational signal only: no source, account, container ID or third-party diagnostics.
      console.error("attention_agent_reach_cleanup_unconfirmed");
    }
    options.signal.throwIfAborted();
    return failure(error instanceof AgentReachProcessError ? error.code : "unknown_reader_error", true);
  }
}
