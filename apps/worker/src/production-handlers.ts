import {randomUUID} from "node:crypto";
import {
  AiProviderError,
  createConfiguredAiProvider,
  type StructuredChatProvider,
} from "@attention/ai";
import { classifyDocument, type DocumentEvidence } from "@attention/content-reader";
import {
  readFailurePolicy,
  ReadRequestSchema,
  ReadResultSchema,
  type ReadResult,
  type ReadFailureCode,
  type SourceKind,
} from "@attention/content-reader-contracts";
import { normalizeCredentialEndpoint } from "@attention/contracts";

import type { MetadataResult, SummaryResult } from "./contracts.js";
import { JobExecutionError } from "./errors.js";
import type { ContentHandlerContext, JobHandlers } from "./handlers.js";

export { extractDocument } from "./document-extractor.js";

export interface LoadedDocument {
  readResult?: ReadResult;
  finalUrl: string;
  html: string;
  status: number;
}

export interface ContentDocumentLoader {
  load(context: ContentHandlerContext): Promise<LoadedDocument | null>;
}

function deterministicTitle(context: ContentHandlerContext): string {
  if (context.title?.trim()) return context.title.trim();
  try {
    const url = new URL(context.outboundUrl);
    const finalSegment = decodeURIComponent(url.pathname)
      .split("/")
      .filter(Boolean)
      .at(-1)
      ?.replace(/[-_]+/gu, " ")
      .trim();
    return finalSegment || url.hostname.replace(/^www\./u, "");
  } catch {
    return context.source || "网页内容";
  }
}

function sourceKind(source: string): SourceKind {
  return source === "douyin" || source === "xiaohongshu" ||
    source === "wechat_official_article"
    ? source
    : "generic_web";
}

function readerFailure(
  code: ReadFailureCode,
  retryAfterMs: number | null = null,
): JobExecutionError {
  return new JobExecutionError(code, {
    retryAfterMs,
    retryable: readFailurePolicy(code).allowedRecoveries.includes("retry_later"),
  });
}

function responseRetryAfterMs(response: Response): number | null {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw) return null;
  const seconds = /^\d+$/u.test(raw) ? Number(raw) : null;
  const milliseconds = seconds === null
    ? Date.parse(raw) - Date.now()
    : seconds * 1_000;
  return Number.isFinite(milliseconds) && milliseconds > 0
    ? Math.min(Math.round(milliseconds), 900_000)
    : null;
}

async function fetcherFailure(response: Response): Promise<JobExecutionError> {
  const retryAfterMs = responseRetryAfterMs(response);
  if (response.status === 429) return readerFailure("rate_limited", retryAfterMs);
  if (response.status === 404) return readerFailure("reader_unsupported");
  if (response.status === 401 || response.status === 403) {
    return readerFailure("reader_not_configured");
  }
  let fetcherCode: unknown;
  try {
    const payload = await response.json() as { error?: { code?: unknown } };
    fetcherCode = payload.error?.code;
  } catch {
    await response.body?.cancel().catch(() => undefined);
  }
  if (fetcherCode === "timeout") return readerFailure("network_timeout", retryAfterMs);
  if (fetcherCode === "dns_failure") return readerFailure("dns_failure", retryAfterMs);
  if (typeof fetcherCode === "string" && fetcherCode.startsWith("unsafe_")) {
    return readerFailure("unsafe_source");
  }
  return readerFailure("unknown_reader_error", retryAfterMs);
}

export function createFetcherDocumentLoader(
  env: NodeJS.ProcessEnv = process.env,
  fetchImplementation: typeof fetch = fetch,
): ContentDocumentLoader | null {
  const baseUrl = env.FETCHER_BASE_URL?.trim();
  const secret = env.FETCHER_SHARED_SECRET?.trim();
  if (!baseUrl || !secret || secret.length < 32) return null;
  const endpoint = `${normalizeCredentialEndpoint(baseUrl, "FETCHER_BASE_URL", {
    allowedInsecureHosts: ["fetcher"],
  })}`;

  return {
    async load(context) {
      if (context.signal.aborted) throw readerFailure("permission_revoked");
      const request = ReadRequestSchema.parse({request_ref: context.requestRef ?? randomUUID(),
        attempt_ref: context.attemptRef ?? randomUUID(), sourceKind: sourceKind(context.source), url: context.outboundUrl});
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(90_000)]);
      let response: Response;
      try {
        const init = {
          headers: {
            authorization: `Bearer ${secret}`,
            "content-type": "application/json",
          },
          method: "POST",
          redirect: "error" as const,
          signal,
        };
        response = await fetchImplementation(`${endpoint}/v1/read`, {...init, body: JSON.stringify(request)});
        if (response.status !== 404) {
          if (!response.ok) throw await fetcherFailure(response);
          const parsed = ReadResultSchema.safeParse(await boundedJson(response, 256 * 1024, signal));
          if (!parsed.success) throw readerFailure("unknown_reader_error");
          const result = parsed.data;
          if (result.request_ref !== request.request_ref || result.attempt_ref !== request.attempt_ref ||
            (result.outcome === "ready" && (result.source_kind !== request.sourceKind ||
              (new URL(request.url).protocol === "https:" && new URL(result.final_public_url).protocol !== "https:")))) {
            throw readerFailure("unknown_reader_error");
          }
          if (context.signal.aborted) throw readerFailure("permission_revoked");
          return {readResult: result, html: "", status: 200,
            finalUrl: result.outcome === "ready" ? result.final_public_url : context.outboundUrl};
        }
        await response.body?.cancel();
        response = await fetchImplementation(`${endpoint}/v1/fetch`, {...init,
          body: JSON.stringify({mode: "metadata", sourceKind: request.sourceKind, url: request.url})});
      } catch (error) {
        if (context.signal.aborted) throw readerFailure("permission_revoked");
        if (error instanceof JobExecutionError) throw error;
        if (error instanceof Error &&
          (error.name === "AbortError" || error.name === "TimeoutError")) {
          throw readerFailure("network_timeout");
        }
        throw readerFailure("unknown_reader_error");
      }
      if (!response.ok) {
        throw await fetcherFailure(response);
      }
      const payload = await boundedJson(response, 3 * 1024 * 1024, signal).catch(() => null) as {
        body?: unknown;
        finalUrl?: unknown;
        status?: unknown;
      } | null;
      if (!payload || typeof payload.status !== "number" ||
        !Number.isInteger(payload.status) || payload.status < 100 || payload.status > 599 ||
        (payload.body !== undefined && typeof payload.body !== "string") ||
        typeof payload.finalUrl !== "string" ||
        (typeof payload.body === "string" && Buffer.byteLength(payload.body) > 2 * 1024 * 1024)) {
        throw readerFailure("unknown_reader_error");
      }
      if (context.signal.aborted) throw readerFailure("permission_revoked");
      return { finalUrl: payload.finalUrl, html: payload.body ?? "", status: payload.status };
    },
  };
}

async function boundedJson(response: Response, limit: number, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw readerFailure("unknown_reader_error");
  const chunks: Uint8Array[] = []; let length = 0;
  const cancel = () => {void reader.cancel().catch(() => undefined);};
  signal.addEventListener("abort", cancel, {once: true});
  try {
    signal.throwIfAborted();
    while (true) {
      const item = await reader.read(); signal.throwIfAborted();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > limit) {await reader.cancel(); throw readerFailure("unknown_reader_error");}
      chunks.push(item.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {signal.removeEventListener("abort", cancel); reader.releaseLock();}
}

function providerUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "unavailable";
  }
}

function parseGeneratedSummary(value: Record<string, unknown>): SummaryResult {
  if (typeof value.summary !== "string" || !value.summary.trim()) {
    throw new AiProviderError("ai_invalid_response", { retryable: true });
  }
  const rawTags = value.tags;
  if (!Array.isArray(rawTags) || rawTags.some((tag) => typeof tag !== "string")) {
    throw new AiProviderError("ai_invalid_response", { retryable: true });
  }
  return {
    status: "ready",
    summary: value.summary.trim(),
    tags: [...new Set(rawTags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 8),
  };
}

async function loadDocument(
  loader: ContentDocumentLoader | null,
  context: ContentHandlerContext,
): Promise<LoadedDocument> {
  if (!loader) throw readerFailure("reader_not_configured");
  const document = await loader.load(context);
  if (!document) throw readerFailure("unknown_reader_error");
  return document;
}

function classifyLoadedDocument(
  document: LoadedDocument,
  context: ContentHandlerContext,
): DocumentEvidence {
  if (document.readResult) {
    const result = document.readResult;
    const metadata = result.outcome === "skipped" ? null : result.metadata;
    // Failed is not a security classification: strict results can carry blocked codes too.
    const safeMetadata = result.outcome === "failed" && result.evidence_kind === "metadata_only" &&
      ["evidence_insufficient", "render_required", "reader_unsupported", "browser_backend_unavailable"].includes(result.code);
    return {kind: result.outcome === "ready" ? "article" : safeMetadata ? "metadata_only" : "blocked",
      code: result.outcome === "ready" ? null : result.outcome === "skipped" ? "content_ineligible" : result.code,
      author: metadata?.author ?? null, title: metadata?.title ?? null, description: metadata?.description ?? null,
      publishedAt: metadata?.published_at ? new Date(metadata.published_at) : null,
      text: result.outcome === "ready" ? result.temporary_text : null,
      extractionMethod: result.outcome === "ready" ? result.extraction_method : "none",
      truncated: result.outcome === "ready" && result.truncated};
  }
  return classifyDocument({
    finalUrl: document.finalUrl,
    html: document.html,
    sourceKind: sourceKind(context.source),
    status: document.status,
  });
}

export function createProductionHandlers(options: {
  documentLoader?: ContentDocumentLoader | null;
  provider?: StructuredChatProvider | null;
} = {}): JobHandlers {
  const documentLoader = options.documentLoader ?? null;
  const provider = options.provider ?? null;
  return {
    async metadata(context): Promise<MetadataResult> {
      if (!documentLoader) {
        return {
          author: context.author,
          cachedFaviconAssetKey: null,
          publishedAt: context.publishedAt,
          title: deterministicTitle(context),
        };
      }
      const evidence = classifyLoadedDocument(await loadDocument(documentLoader, context), context);
      const extracted = evidence.kind === "blocked" ? null : evidence;
      return {
        author: extracted?.author ?? context.author,
        cachedFaviconAssetKey: null,
        publishedAt: extracted?.publishedAt ?? context.publishedAt,
        title: extracted?.title ?? deterministicTitle(context),
      };
    },
    async summary(context): Promise<SummaryResult> {
      const title = deterministicTitle(context);
      if (!provider) {
        throw new JobExecutionError("summary_handler_not_configured", { retryable: false });
      }
      const document = await loadDocument(documentLoader, context);
      if (context.signal.aborted) throw readerFailure("permission_revoked");
      const read = document.readResult;
      if (read && read.outcome !== "ready") {
        if (read.outcome === "skipped") throw readerFailure("content_ineligible");
        throw new JobExecutionError(read.code, {retryable: read.recovery === "retry_later", retryAfterMs: read.retry_after_ms});
      }
      const extracted = classifyLoadedDocument(document, context);
      if (extracted.kind !== "article" || !extracted.text) {
        throw readerFailure(extracted.code ?? "evidence_insufficient");
      }
      try {
        const generated = await provider.completeJson({
          signal: context.signal,
          system: [
            "You create grounded metadata for a saved link.",
            "Return JSON with summary (concise Chinese, 80-150 Chinese characters when evidence permits) and tags (1-8 short strings).",
            "Use only supplied metadata and temporary page text. Do not claim the collector read, endorsed, or agreed with the page.",
            "Summarize only the supplied portion. When evidenceBoundary.truncated is true, do not claim whole-document coverage or infer omitted content.",
            "If evidence is thin, explicitly say the summary is based on limited page metadata. Do not invent facts.",
          ].join(" "),
          user: JSON.stringify({
            evidenceBoundary: {kind: "article", truncated: extracted.truncated},
            author: extracted?.author ?? context.author,
            description: extracted?.description,
            publishedAt: (extracted?.publishedAt ?? context.publishedAt)?.toISOString() ?? null,
            source: context.source,
            temporaryPageText: extracted?.text,
            title: extracted?.title ?? title,
            url: providerUrl(document?.finalUrl ?? context.outboundUrl),
          }),
        });
        if (context.signal.aborted) throw readerFailure("permission_revoked");
        return parseGeneratedSummary(generated);
      } catch (error) {
        if (error instanceof JobExecutionError) throw error;
        if (error instanceof AiProviderError) {
          throw new JobExecutionError(error.code, { retryable: error.retryable });
        }
        throw new JobExecutionError("ai_provider_failed", { retryable: true });
      }
    },
    summaryConfigured: provider !== null,
  };
}

export function createConfiguredProductionHandlers(
  env: NodeJS.ProcessEnv = process.env,
  fetchImplementation: typeof fetch = fetch,
): JobHandlers {
  return createProductionHandlers({
    documentLoader: createFetcherDocumentLoader(env, fetchImplementation),
    provider: createConfiguredAiProvider(env, fetchImplementation),
  });
}
