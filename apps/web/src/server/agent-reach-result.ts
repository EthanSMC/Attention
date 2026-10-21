import "server-only";

import {
  ReadResultSchema,
  SafeReferenceSchema,
  readFailurePolicy,
  type ReadFailureCode,
  type ReadMetadata,
  type ReadRequest,
  type ReadResult,
} from "@attention/content-reader-contracts";
import { z } from "zod";

const MAX_PROVIDER_BYTES = 2 * 1024 * 1024;
const EMPTY_METADATA: ReadMetadata = { author: null, description: null, published_at: null, title: null };
const WorkerFailureSchema = z.enum([
  "invalid_request", "invalid_url", "unsafe_url", "reader_not_configured",
  "upstream_unavailable", "upstream_incompatible", "upstream_timeout", "upstream_failed",
  "upstream_output_too_large", "upstream_empty", "upstream_policy_blocked",
]);
const WorkerBase = {
  schema_version: z.literal(1), request_ref: SafeReferenceSchema, attempt_ref: SafeReferenceSchema,
  upstream_version: z.literal("1.5.0"),
};
const WorkerResponseSchema = z.discriminatedUnion("outcome", [
  z.object({ ...WorkerBase, outcome: z.literal("ok"), text: z.string().max(MAX_PROVIDER_BYTES) }).strict(),
  z.object({ ...WorkerBase, outcome: z.literal("failed"), code: WorkerFailureSchema }).strict(),
]);
const FAILURE_CODES = {
  invalid_request: "unknown_reader_error",
  invalid_url: "unsafe_source",
  unsafe_url: "unsafe_source",
  reader_not_configured: "reader_not_configured",
  upstream_unavailable: "reader_not_configured",
  upstream_incompatible: "reader_not_configured",
  upstream_timeout: "network_timeout",
  upstream_failed: "unknown_reader_error",
  upstream_output_too_large: "evidence_insufficient",
  upstream_empty: "evidence_insufficient",
  upstream_policy_blocked: "unsafe_source",
} as const satisfies Record<z.infer<typeof WorkerFailureSchema>, ReadFailureCode>;

function comparableUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!/^https?:$/u.test(url.protocol) || url.username || url.password) return null;
    url.hash = "";
    return url.href;
  } catch { return null; }
}

/** Recognize the provider's text envelope only; article extraction stays upstream. */
function unpackProviderText(text: string, requestedUrl: string): { title: string | null; body: string } | null {
  const normalized = text.replace(/\r\n/gu, "\n");
  const marker = "\nMarkdown Content:\n";
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex < 0 || markerIndex > 8_192) return null;
  const header = normalized.slice(0, markerIndex);
  const titles = [...header.matchAll(/^Title:([^\n]*)$/gmu)];
  const sources = [...header.matchAll(/^URL Source:([^\n]*)$/gmu)];
  // Warning/status lines can describe challenge or failed pages despite long content.
  if (titles.length !== 1 || sources.length !== 1 ||
    header.split("\n").some(line => line.trim() && !/^(?:Title|URL Source|Published Time):/u.test(line))) return null;
  const source = comparableUrl(sources[0]![1]!.trim());
  if (!source || source !== comparableUrl(requestedUrl)) return null;
  const title = titles[0]![1]!.trim().slice(0, 4_096) || null;
  return { title, body: normalized.slice(markerIndex + marker.length).trim() };
}

function gateCode(title: string | null, body: string): ReadFailureCode | null {
  // Only page titles and the first primary heading/notice are gate signals. A normal
  // article discussing authentication is still evidence, never an instruction source.
  const firstLine = body.split("\n").find(line => line.trim())?.replace(/^#{1,6}\s+/u, "")
    .replace(/^\*\*(.*)\*\*$/u, "$1").trim() ?? "";
  const labels = [title ?? "", firstLine];
  const has = (pattern: RegExp) => labels.some(label => pattern.test(label));
  if (has(/^(?:verify (?:that )?you are human|security check|verification required|just a moment(?:\.\.\.)?|attention required!?\s*\|\s*cloudflare|checking your browser|please enable javascript and cookies to continue|captcha|人机验证|安全验证|请完成验证)[.!。！]?$/iu)) return "verification_required";
  if (has(/^(?:(?:sign in|log in|login)(?: (?:to continue(?: reading)?|required))?|登录|登录后(?:继续)?阅读|请登录后阅读)[.!。！]?$/iu)) return "login_required";
  if (has(/^(?:access denied|forbidden|permission denied|subscribe to (?:continue reading|read (?:this|the) article)|subscription required|访问被拒绝|禁止访问|订阅后(?:继续)?阅读|请订阅后阅读)[.!。！]?$/iu)) return "access_denied";
  if (has(/^(?:(?:404[ :–-]*)?(?:page )?not found|页面不存在|网页不存在)[.!。！]?$/iu)) return "source_not_found";
  if (has(/^(?:(?:error|internal server error|service unavailable|bad gateway|请求失败|系统错误)(?:[ :–-].*)?)$/iu)) return "evidence_insufficient";
  return null;
}

function hasProse(body: string): boolean {
  // This is a conservative evidence gate, not a local article parser. A list of
  // navigation links, title-only preview or repeated notice is insufficient.
  const paragraphs = body.split(/\n\s*\n/gu).map(part => part.trim()).filter(part =>
    part.length >= 80 && !/^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|!\[|\[)/u.test(part));
  const distinct = [...new Set(paragraphs)];
  return distinct.length >= 2 && distinct.join(" ").replace(/[^\p{L}\p{N}]/gu, "").length >= 280;
}

/** The caller validates the requested public URL and owns process isolation. */
export function adaptAgentReachResult(raw: unknown, request: ReadRequest, durationMs: number): ReadResult {
  const base = { schema_version: 1 as const, request_ref: request.request_ref, attempt_ref: request.attempt_ref,
    attempts: [{ method: "agent_reach" as const, duration_ms: Number.isFinite(durationMs)
      ? Math.min(90_000, Math.max(0, Math.round(durationMs))) : 0 }] };
  function fail(code: ReadFailureCode, metadata = EMPTY_METADATA): ReadResult {
    const policy = readFailurePolicy(code);
    return ReadResultSchema.parse({ ...base, outcome: policy.scope === "security" ||
      ["login_required", "verification_required", "access_denied", "source_not_found"].includes(code) ? "blocked" : "failed",
    code, scope: policy.scope, recovery: policy.recovery === "switch_reader" ? "pause" : policy.recovery,
    retry_after_ms: null, metadata, evidence_kind: metadata.title ? "metadata_only" : "none" });
  }
  const parsed = WorkerResponseSchema.safeParse(raw);
  if (!parsed.success || parsed.data.request_ref !== request.request_ref || parsed.data.attempt_ref !== request.attempt_ref) {
    return fail("unknown_reader_error");
  }
  if (parsed.data.outcome === "failed") return fail(FAILURE_CODES[parsed.data.code]);
  if (Buffer.byteLength(parsed.data.text, "utf8") > MAX_PROVIDER_BYTES) return fail("evidence_insufficient");
  const evidence = unpackProviderText(parsed.data.text, request.url);
  if (!evidence) return fail("evidence_insufficient");
  const metadata = { ...EMPTY_METADATA, title: evidence.title };
  const gate = gateCode(evidence.title, evidence.body);
  if (gate) return fail(gate, metadata);
  const temporaryText = evidence.body.slice(0, 12_000);
  // Evidence outside the returned window must not make a navigation-only prefix
  // eligible for summarization.
  if (!hasProse(temporaryText)) return fail("evidence_insufficient", metadata);
  return ReadResultSchema.parse({ ...base, outcome: "ready", evidence_kind: "article", metadata,
    extraction_method: "agent_reach", temporary_text: temporaryText,
    truncated: evidence.body.length > 12_000,
    // WebChannel does not report a verified redirect destination. Retain only the
    // authorized request URL; never adopt a destination claimed by page content.
    final_public_url: request.url, source_kind: request.sourceKind, read_at: new Date().toISOString() });
}
