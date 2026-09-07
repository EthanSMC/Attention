import type {
  ExtractionMethod,
  ReadFailureCode,
  SourceKind,
} from "@attention/content-reader-contracts";
import { parseHTML } from "linkedom/worker";

import { extractDocumentWithDetails } from "./document-extractor.js";

export interface DocumentEvidence {
  author: string | null;
  code: ReadFailureCode | null;
  description: string | null;
  extractionMethod: ExtractionMethod;
  kind: "article" | "metadata_only" | "blocked" | "empty";
  publishedAt: Date | null;
  text: string | null;
  title: string | null;
  truncated: boolean;
}

export interface ClassifyDocumentInput {
  finalUrl: string;
  html: string;
  sourceKind: SourceKind;
  status: number;
}

function statusFailure(status: number): ReadFailureCode | null {
  if (status >= 200 && status < 300) return null;
  if (status === 401) return "login_required";
  if (status === 403) return "access_denied";
  if (status === 404) return "source_not_found";
  if (status === 410) return "source_gone";
  if (status === 429) return "rate_limited";
  if (status >= 500 && status < 600) return "upstream_5xx";
  return "reader_unsupported";
}

function challengeCode(html: string, hasReadableArticle: boolean): ReadFailureCode | null {
  const { document } = parseHTML(html);
  const verificationControl = document.querySelector([
    "input[name*='captcha' i]",
    "input[name*='turnstile' i]",
    "iframe[src*='captcha' i]",
    "iframe[src*='challenge' i]",
    "form[action*='challenge' i]",
    "form[id*='challenge' i]",
    ".g-recaptcha, .h-captcha, .cf-turnstile",
  ].join(","));

  const loginForm = document.querySelector("form input[type='password']") ??
    document.querySelector("form[action*='login' i], form[action*='signin' i], form[action*='sign-in' i]");

  const title = document.querySelector("title")?.textContent?.replace(/\s+/gu, " ").trim() ?? "";
  const heading = document.querySelector("h1")?.textContent?.replace(/\s+/gu, " ").trim() ?? "";
  const verificationTitle = /^(?:verify (?:that )?you are human|security check|verification required|人机验证|安全验证)$/iu;
  if (verificationTitle.test(title) || verificationTitle.test(heading)) {
    return "verification_required";
  }
  if (/^(?:access denied|forbidden|permission denied|访问被拒绝|禁止访问)$/iu.test(title) ||
    /^(?:access denied|forbidden|permission denied|访问被拒绝|禁止访问)$/iu.test(heading)) {
    return "access_denied";
  }
  // Widgets beside an already-readable article do not gate access to its evidence.
  if (!hasReadableArticle) {
    if (verificationControl) return "verification_required";
    if (loginForm) return "login_required";
  }
  return null;
}

function hasMetadata(evidence: ReturnType<typeof extractDocumentWithDetails>): boolean {
  return evidence.author !== null || evidence.description !== null ||
    evidence.publishedAt !== null || evidence.title !== null;
}

function words(value: string): Set<string> {
  const ignored = new Set(["after", "and", "for", "from", "in", "of", "the", "to", "with"]);
  return new Set((value.normalize("NFKC").toLocaleLowerCase("en-US")
    .match(/[\p{Letter}\p{Number}]{2,}/gu) ?? []).filter((word) => !ignored.has(word)));
}

function bodiesDisagree(structured: string | null, visible: string | null): boolean {
  if (!structured || !visible || structured.length < 40 || visible.length < 40) return false;
  if (structured.includes(visible) || visible.includes(structured)) return false;
  const structuredWords = words(structured);
  const visibleWords = words(visible);
  if (structuredWords.size === 0 || visibleWords.size === 0) return false;
  let shared = 0;
  for (const word of structuredWords) if (visibleWords.has(word)) shared += 1;
  return shared / Math.min(structuredWords.size, visibleWords.size) < 0.2;
}

function isDynamicShell(html: string): boolean {
  const { document } = parseHTML(html);
  const appRoot = document.querySelector("#app, #root, #__next, [data-reactroot]");
  return appRoot !== null && appRoot.textContent?.trim() === "" &&
    document.querySelector("script[src], script[type='module']") !== null;
}

export function classifyDocument(input: ClassifyDocumentInput): DocumentEvidence {
  const extracted = extractDocumentWithDetails(input.html);
  const base = {
    author: extracted.author,
    description: extracted.description,
    publishedAt: extracted.publishedAt,
    title: extracted.title,
  };
  const httpFailure = statusFailure(input.status);
  if (httpFailure) {
    return {
      ...base,
      code: httpFailure,
      extractionMethod: hasMetadata(extracted) ? "metadata" : "none",
      kind: "blocked",
      text: null,
      truncated: false,
    };
  }

  const pageBlock = challengeCode(input.html, Boolean(extracted.hasArticleStructure && extracted.visibleText));
  if (pageBlock) {
    return {
      ...base,
      code: pageBlock,
      extractionMethod: hasMetadata(extracted) ? "metadata" : "none",
      kind: "blocked",
      text: null,
      truncated: false,
    };
  }

  if (bodiesDisagree(extracted.structuredText, extracted.visibleText)) {
    return {
      ...base,
      code: "evidence_insufficient",
      extractionMethod: hasMetadata(extracted) ? "metadata" : "none",
      kind: hasMetadata(extracted) ? "metadata_only" : "empty",
      text: null,
      truncated: false,
    };
  }

  if (extracted.text && extracted.hasArticleStructure) {
    return {
      ...base,
      code: null,
      extractionMethod: extracted.extractionMethod,
      kind: "article",
      text: extracted.text,
      truncated: extracted.truncated,
    };
  }

  const metadata = hasMetadata(extracted);
  const renderRequired = isDynamicShell(input.html);
  return {
    ...base,
    code: renderRequired ? "render_required" : "evidence_insufficient",
    extractionMethod: metadata ? "metadata" : "none",
    kind: metadata ? "metadata_only" : "empty",
    text: null,
    truncated: false,
  };
}
