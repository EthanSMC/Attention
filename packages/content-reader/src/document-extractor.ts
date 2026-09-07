import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom/worker";

import type { ExtractionMethod } from "@attention/content-reader-contracts";

const MAX_DOCUMENT_TEXT = 12_000;
const MAX_METADATA_TEXT = 4_096;
const ARTICLE_TYPES = new Set([
  "Article", "NewsArticle", "BlogPosting", "TechArticle", "ScholarlyArticle",
  "Report", "SocialMediaPosting", "DiscussionForumPosting",
]);

export interface ExtractedDocument {
  author: string | null;
  description: string | null;
  publishedAt: Date | null;
  text: string | null;
  title: string | null;
}

export interface ExtractedDocumentDetails extends ExtractedDocument {
  extractionMethod: ExtractionMethod;
  hasArticleStructure: boolean;
  structuredText: string | null;
  truncated: boolean;
  visibleText: string | null;
}

interface BoundedText {
  text: string | null;
  truncated: boolean;
}

function cleanText(value: unknown, maxLength = MAX_METADATA_TEXT): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function boundedArticleText(value: unknown): BoundedText {
  if (typeof value !== "string") return { text: null, truncated: false };
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized || /^(?:loading(?:\s+(?:article|content|page))?|(?:正在)?加载(?:中)?)[\s.…。]*$/iu.test(normalized)) {
    return { text: null, truncated: false };
  }
  return {
    text: normalized.slice(0, MAX_DOCUMENT_TEXT),
    truncated: normalized.length > MAX_DOCUMENT_TEXT,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function structuredArticle(document: Document): Record<string, unknown> | null {
  for (const script of document.querySelectorAll("script[type='application/ld+json']")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(script.textContent ?? "");
    } catch {
      continue;
    }
    const pending: unknown[] = [parsed];
    for (let index = 0; index < pending.length; index += 1) {
      const value = pending[index];
      if (Array.isArray(value)) {
        for (const child of value) pending.push(child);
        continue;
      }
      const node = record(value);
      if (!node) continue;
      const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
      if (types.some((type) => typeof type === "string" &&
        ARTICLE_TYPES.has(type.replace(/^https?:\/\/schema\.org\//u, "")))) {
        return node;
      }
      if (node["@graph"]) pending.push(node["@graph"]);
      if (node.mainEntity) pending.push(node.mainEntity);
    }
  }
  return null;
}

function structuredAuthor(value: unknown): string | null {
  const authors = Array.isArray(value) ? value : [value];
  return cleanText(authors.map((author) =>
    cleanText(typeof author === "string" ? author : record(author)?.name),
  ).filter(Boolean).join(", "));
}

function metadataValue(document: Document, names: readonly string[]): string | null {
  const tags = document.querySelectorAll("meta");
  for (const name of names) {
    for (const tag of tags) {
      const key = (tag.getAttribute("property") ?? tag.getAttribute("name"))?.toLowerCase();
      const value = key === name ? cleanText(tag.getAttribute("content")) : null;
      if (value) return value;
    }
  }
  return null;
}

function safeDate(value: unknown): Date | null {
  const text = cleanText(value);
  if (!text) return null;
  const parsed = new Date(text);
  const year = parsed.getUTCFullYear();
  return year >= 1970 && year <= 2200 ? parsed : null;
}

function removeNonContent(document: Document): void {
  for (const node of document.querySelectorAll([
    "script", "style", "noscript", "svg", "template", "title", "nav", "aside", "footer", "form",
    "[role='navigation']", "[role='banner']", "[hidden]", "[aria-hidden='true']",
  ].join(","))) node.remove();
  for (const node of document.querySelectorAll<HTMLElement>("[style]")) {
    if (node.style.display === "none" || node.style.visibility === "hidden") node.remove();
  }
}

function bodyText(element: HTMLElement | null): BoundedText {
  return boundedArticleText(element?.innerText);
}

function parsedDocument(html: string): Document {
  let { document } = parseHTML(html);
  if (document.documentElement?.tagName !== "HTML") {
    document = parseHTML(`<html><head></head><body>${html}</body></html>`).document;
  }
  return document;
}

export function extractDocumentWithDetails(html: string): ExtractedDocumentDetails {
  const document = parsedDocument(html);
  const structured = structuredArticle(document);
  const hasArticleStructure = structured?.articleBody !== undefined ||
    document.querySelector("article, [itemprop='articleBody']") !== null ||
    document.querySelector("main p, [role='main'] p") !== null;
  const metadata = {
    author: structuredAuthor(structured?.author) ??
      metadataValue(document, ["author", "article:author", "og:article:author"]),
    description: cleanText(structured?.description) ??
      metadataValue(document, ["description", "og:description", "twitter:description"]),
    publishedAt: safeDate(structured?.datePublished) ?? safeDate(metadataValue(document, [
      "article:published_time", "date", "datepublished", "publishdate",
    ])),
    title: cleanText(structured?.headline) ?? cleanText(structured?.name) ??
      metadataValue(document, ["og:title", "twitter:title"]) ??
      cleanText(document.querySelector("title")?.textContent),
  };
  removeNonContent(document);

  let article: ReturnType<Readability<HTMLElement>["parse"]> = null;
  try {
    article = new Readability<HTMLElement>(document.cloneNode(true) as Document, {
      disableJSONLD: true,
      serializer: (node) => node as HTMLElement,
    }).parse();
  } catch {
    // Malformed pages can still supply bounded metadata and semantic HTML.
  }
  for (const node of document.querySelectorAll("head, title")) node.remove();
  const semantic = document.querySelector<HTMLElement>("article, main, [role='main']");
  const fallback = semantic ?? document.body;
  const readabilityText = bodyText(article?.content ?? null);
  const semanticText = bodyText(semantic);
  const fallbackText = bodyText(fallback);
  const visible = readabilityText.text ? readabilityText
    : semanticText.text ? semanticText
    : fallbackText;
  const structuredText = boundedArticleText(structured?.articleBody);
  const useStructured = (structuredText.text?.length ?? 0) > (visible.text?.length ?? 0);
  const selected = useStructured ? structuredText : visible;
  const extractionMethod: ExtractionMethod = useStructured
    ? "json_ld"
    : readabilityText.text
      ? "readability"
      : semanticText.text
        ? "semantic_html"
        : fallbackText.text
          ? "body"
          : "none";
  return {
    author: metadata.author ?? cleanText(article?.byline),
    description: metadata.description,
    extractionMethod,
    hasArticleStructure,
    publishedAt: metadata.publishedAt,
    structuredText: structuredText.text,
    text: selected.text,
    title: metadata.title ?? cleanText(article?.title),
    truncated: selected.truncated,
    visibleText: visible.text,
  };
}

export function extractDocument(html: string): ExtractedDocument {
  const result = extractDocumentWithDetails(html);
  return {
    author: result.author,
    description: result.description,
    publishedAt: result.publishedAt,
    text: result.text,
    title: result.title,
  };
}
