import {
  AiProviderError,
  createConfiguredAiProvider,
  type StructuredChatProvider,
} from "@attention/ai";
import { normalizeCredentialEndpoint } from "@attention/contracts";

import type { MetadataResult, SummaryResult } from "./contracts.js";
import { JobExecutionError } from "./errors.js";
import type { ContentHandlerContext, JobHandlers } from "./handlers.js";

const MAX_DOCUMENT_TEXT = 12_000;

export interface LoadedDocument {
  finalUrl: string;
  html: string;
}

export interface ContentDocumentLoader {
  load(context: ContentHandlerContext): Promise<LoadedDocument | null>;
}

interface ExtractedDocument {
  author: string | null;
  description: string | null;
  publishedAt: Date | null;
  text: string | null;
  title: string | null;
}

function decodeHtml(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  const codePoint = (raw: string, radix: number, entity: string): string => {
    const point = Number.parseInt(raw, radix);
    return Number.isFinite(point) && point >= 0 && point <= 0x10ffff &&
      (point < 0xd800 || point > 0xdfff)
      ? String.fromCodePoint(point)
      : entity;
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (entity, token: string) => {
    if (token.startsWith("#x")) {
      return codePoint(token.slice(2), 16, entity);
    }
    if (token.startsWith("#")) {
      return codePoint(token.slice(1), 10, entity);
    }
    return named[token.toLowerCase()] ?? entity;
  });
}

function cleanText(value: string | null | undefined, maxLength: number): string | null {
  if (!value) return null;
  const normalized = decodeHtml(value).replace(/\s+/gu, " ").trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function tagAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gu)) {
    const name = match[1]?.toLowerCase();
    const value = match[2] ?? match[3] ?? match[4];
    if (name && value !== undefined) attributes.set(name, value);
  }
  return attributes;
}

function metadataValue(html: string, names: readonly string[]): string | null {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const tag of html.match(/<meta\b[^>]*>/giu) ?? []) {
    const attributes = tagAttributes(tag);
    const key = (attributes.get("property") ?? attributes.get("name"))?.toLowerCase();
    if (key && wanted.has(key)) return cleanText(attributes.get("content"), 4_096);
  }
  return null;
}

function safeDate(value: string | null): Date | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const parsed = new Date(timestamp);
  const year = parsed.getUTCFullYear();
  return year >= 1970 && year <= 2200 ? parsed : null;
}

export function extractDocument(html: string): ExtractedDocument {
  const withoutNonContent = html
    .replace(/<(?:script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|svg|template)>/giu, " ")
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/iu, " ");
  const visibleText = cleanText(withoutNonContent.replace(/<[^>]+>/gu, " "), MAX_DOCUMENT_TEXT);
  const htmlTitle = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/iu)?.[1];
  return {
    author: metadataValue(html, ["author", "article:author", "og:article:author"]),
    description: metadataValue(html, ["description", "og:description", "twitter:description"]),
    publishedAt: safeDate(metadataValue(html, [
      "article:published_time",
      "date",
      "datepublished",
      "publishdate",
    ])),
    text: visibleText,
    title: metadataValue(html, ["og:title", "twitter:title"]) ?? cleanText(htmlTitle, 4_096),
  };
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

function deterministicTags(context: ContentHandlerContext, title: string): string[] {
  const ignored = new Set(["http", "https", "html", "www", "com", "网页", "内容"]);
  const tokens = `${title} ${context.source}`.normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .match(/[\p{Script=Han}]{2,8}|[a-z][a-z0-9+._-]{2,31}/gu) ?? [];
  return [...new Set(tokens.filter((token) => !ignored.has(token)))].slice(0, 6);
}

function sourceKind(source: string): string {
  return source === "douyin" || source === "xiaohongshu" ||
    source === "wechat_official_article"
    ? source
    : "generic_web";
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
  })}/v1/fetch`;

  return {
    async load(context) {
      let response: Response;
      try {
        response = await fetchImplementation(endpoint, {
          body: JSON.stringify({
            mode: "metadata",
            sourceKind: sourceKind(context.source),
            url: context.outboundUrl,
          }),
          headers: {
            authorization: `Bearer ${secret}`,
            "content-type": "application/json",
          },
          method: "POST",
          redirect: "error",
          signal: AbortSignal.any([context.signal, AbortSignal.timeout(12_000)]),
        });
      } catch {
        return null;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      const payload = await response.json().catch(() => null) as {
        body?: unknown;
        finalUrl?: unknown;
      } | null;
      if (!payload || typeof payload.body !== "string" ||
        typeof payload.finalUrl !== "string" || payload.body.length > 2 * 1024 * 1024) {
        return null;
      }
      return { finalUrl: payload.finalUrl, html: payload.body };
    },
  };
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

async function loadDocumentSafely(
  loader: ContentDocumentLoader | null,
  context: ContentHandlerContext,
): Promise<LoadedDocument | null> {
  if (!loader) return null;
  try {
    return await loader.load(context);
  } catch {
    return null;
  }
}

export function createProductionHandlers(options: {
  documentLoader?: ContentDocumentLoader | null;
  provider?: StructuredChatProvider | null;
} = {}): JobHandlers {
  const documentLoader = options.documentLoader ?? null;
  const provider = options.provider ?? null;
  return {
    async metadata(context): Promise<MetadataResult> {
      const document = await loadDocumentSafely(documentLoader, context);
      const extracted = document ? extractDocument(document.html) : null;
      return {
        author: extracted?.author ?? context.author,
        cachedFaviconAssetKey: null,
        publishedAt: extracted?.publishedAt ?? context.publishedAt,
        title: extracted?.title ?? deterministicTitle(context),
      };
    },
    async summary(context): Promise<SummaryResult> {
      const title = deterministicTitle(context);
      const fallbackTags = deterministicTags(context, title);
      if (!provider) {
        return { status: "unavailable", summary: null, tags: fallbackTags };
      }
      const document = await loadDocumentSafely(documentLoader, context);
      const extracted = document ? extractDocument(document.html) : null;
      try {
        const generated = await provider.completeJson({
          signal: context.signal,
          system: [
            "You create grounded metadata for a saved link.",
            "Return JSON with summary (concise Chinese, 80-150 Chinese characters when evidence permits) and tags (1-8 short strings).",
            "Use only supplied metadata and temporary page text. Do not claim the collector read, endorsed, or agreed with the page.",
            "If evidence is thin, explicitly say the summary is based on limited page metadata. Do not invent facts.",
          ].join(" "),
          user: JSON.stringify({
            author: extracted?.author ?? context.author,
            description: extracted?.description,
            publishedAt: (extracted?.publishedAt ?? context.publishedAt)?.toISOString() ?? null,
            source: context.source,
            temporaryPageText: extracted?.text,
            title: extracted?.title ?? title,
            url: providerUrl(document?.finalUrl ?? context.outboundUrl),
          }),
        });
        return parseGeneratedSummary(generated);
      } catch (error) {
        if (error instanceof AiProviderError) {
          throw new JobExecutionError(error.code, { retryable: error.retryable });
        }
        throw new JobExecutionError("ai_provider_failed", { retryable: true });
      }
    },
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
