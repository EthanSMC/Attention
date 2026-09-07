import {describe, expect, it, vi} from "vitest";
import {ReadResultSchema, readFailurePolicy} from "@attention/content-reader-contracts";
import {createApp} from "../../fetcher/src/index";
import {createFetcherDocumentLoader, createProductionHandlers} from "./production-handlers";
import type {ContentHandlerContext} from "./handlers";
import type {StructuredChatProvider} from "@attention/ai";

const context: ContentHandlerContext = {contentId: "00000000-0000-4000-8000-000000000001",
  source: "generic_web", outboundUrl: "https://example.com/article", title: null, author: null,
  publishedAt: null, signal: new AbortController().signal, requestRef: "request", attemptRef: "attempt"};
const secret = "synthetic-reader-secret-long-enough";
const env = {FETCHER_BASE_URL: "http://127.0.0.1:4100", FETCHER_SHARED_SECRET: secret};
function fixture(html: string, legacy = false) {
  const app = createApp(secret, {browser: null, fetchOperation: async () => ({body: html, status: 200,
    finalUrl: context.outboundUrl, redirects: [], contentType: "text/html"})});
  const completeJson = vi.fn(async (_input: Parameters<StructuredChatProvider["completeJson"]>[0]) => ({summary: "A grounded synthetic summary.", tags: ["fixture"]}));
  const handlers = createProductionHandlers({provider: {completeJson}, documentLoader: createFetcherDocumentLoader(env,
    async (url, init) => legacy && String(url).endsWith("/v1/read") ? new Response(null, {status: 404}) : app.request(String(url), init))});
  return {handlers, completeJson};
}

describe("reviewed production reader boundaries", () => {
  it.each([
    ['<article><h1>Sign in to continue</h1><p>Please sign in to continue reading this article.</p><a href="/login">Sign in</a></article>', "login_required"],
    ['<article><h1>Subscribe to continue reading</h1><p>A subscription is required to read this article.</p><a href="/subscribe">Subscribe</a></article>', "access_denied"],
  ])("never sends a primary access gate to the provider", async (html, code) => {
    for (const legacy of [false, true]) {
      const {handlers, completeJson} = fixture(html, legacy);
      await expect(handlers.summary(context)).rejects.toMatchObject({code});
      expect(completeJson).not.toHaveBeenCalled();
    }
  });
  it.each([false, true])("keeps safe metadata parity across endpoints (shell=%s)", async shell => {
    const html = '<html><head><title>Verified metadata title</title><meta name="author" content="Writer"><meta property="article:published_time" content="2026-09-01T00:00:00.000Z"></head><body>' +
      (shell ? '<div id="app"></div><script src="/app.js"></script>' : '') + '</body></html>';
    const current = fixture(html), legacy = fixture(html, true);
    const expected = {title: "Verified metadata title", author: "Writer", publishedAt: new Date("2026-09-01T00:00:00.000Z")};
    expect(await current.handlers.metadata(context)).toMatchObject(expected);
    expect(await legacy.handlers.metadata(context)).toMatchObject(expected);
    for (const test of [current, legacy]) {
      await expect(test.handlers.summary(context)).rejects.toBeDefined();
      expect(test.completeJson).not.toHaveBeenCalled();
    }
  });
  it.each(["login_required", "verification_required", "access_denied", "unsafe_source", "content_ineligible"] as const)("does not trust typed failed %s metadata", async code => {
    const policy = readFailurePolicy(code);
    const read = ReadResultSchema.parse({schema_version: 1, request_ref: "request", attempt_ref: "attempt",
      outcome: "failed", code, scope: policy.scope, recovery: policy.recovery, retry_after_ms: null,
      attempts: [{method: "static", duration_ms: 1}], evidence_kind: "metadata_only",
      metadata: {title: "Gate title", author: "Gate author", description: null, published_at: "2026-09-01T00:00:00.000Z"}});
    const completeJson = vi.fn();
    const handlers = createProductionHandlers({provider: {completeJson}, documentLoader: createFetcherDocumentLoader(env, async () => Response.json(read))});
    expect(await handlers.metadata(context)).toMatchObject({title: "article", author: null, publishedAt: null});
    await expect(handlers.summary(context)).rejects.toMatchObject({code});
    expect(completeJson).not.toHaveBeenCalled();
  });
  it.each([false, true])("retains a provider-visible article boundary (truncated=%s)", async truncated => {
    const {handlers, completeJson} = fixture(`<article><p>${"Grounded sentence with concrete evidence. ".repeat(truncated ? 500 : 1)}</p></article>`);
    await expect(handlers.summary(context)).resolves.toMatchObject({status: "ready", tags: ["fixture"]});
    const call = completeJson.mock.calls[0]![0];
    expect(JSON.parse(call.user)).toMatchObject({evidenceBoundary: {kind: "article", truncated}});
    expect(call.system).toMatch(/supplied portion/u);
    expect(call.system).toMatch(/whole.document coverage/u);
  });
});
