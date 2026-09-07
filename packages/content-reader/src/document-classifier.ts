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
  const gateControl = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
    .find((control) => {
      for (let ancestor: HTMLElement | null = control; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor.hidden || ancestor.getAttribute("aria-hidden") === "true" ||
          ancestor.style.display === "none" || ancestor.style.visibility === "hidden") return false;
      }
      return !hasReadableArticle || !control.closest("aside, nav, footer, [role='complementary'], [role='navigation']");
    });
  const verificationControl = gateControl([
    "input[name*='captcha' i]",
    "input[name*='turnstile' i]",
    "iframe[src*='captcha' i]",
    "iframe[src*='challenge' i]",
    "form[action*='challenge' i]",
    "form[id*='challenge' i]",
    ".g-recaptcha, .h-captcha, .cf-turnstile",
  ].join(","));

  const loginForm = gateControl("form input[type='password'], form[action*='login' i], form[action*='signin' i], form[action*='sign-in' i]");

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
  // Primary-content gates remain gates even when their notice contains readable paragraphs.
  if (verificationControl) return "verification_required";
  if (loginForm) return "login_required";
  // A primary notice with an explicit access action is not article evidence.
  // Heading/action structure keeps discussions of login and incidental sidebars readable.
  const primaryHeading = gateControl("h1");
  const primary = primaryHeading?.closest("article, main, [role='main']") ?? primaryHeading?.parentElement;
  const noticeHeading = primaryHeading?.textContent?.replace(/\s+/gu, " ").trim() ?? "";
  const primaryActions = [...primary?.querySelectorAll<HTMLElement>("a[href]") ?? []].filter(link => {
    if (link.closest("aside, nav, footer, [role='complementary'], [role='navigation']")) return false;
    for (let ancestor: HTMLElement | null = link; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.hidden || ancestor.getAttribute("aria-hidden") === "true" ||
        ancestor.style.display === "none" || ancestor.style.visibility === "hidden") return false;
    }
    return true;
  });
  if (primary && /^(?:(?:sign in|log in|login) (?:to continue(?: reading)?|required)|登录后(?:继续)?阅读|请登录后阅读)[.!。！]?$/iu.test(noticeHeading) &&
    primaryActions.some(link => /^(?:sign in|log in|login|登录)$/iu.test(link.textContent?.trim() ?? ""))) return "login_required";
  if (primary && /^(?:subscribe to (?:continue reading|read (?:this|the) article)|subscription required|订阅后(?:继续)?阅读|请订阅后阅读)[.!。！]?$/iu.test(noticeHeading) &&
    primaryActions.some(link => /^(?:subscribe|subscribe now|订阅|立即订阅)$/iu.test(link.textContent?.trim() ?? ""))) return "access_denied";
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

  const pageBlock = challengeCode(input.html, Boolean(extracted.hasArticleEvidence && extracted.visibleText));
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

  if (extracted.text && extracted.hasArticleEvidence) {
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
