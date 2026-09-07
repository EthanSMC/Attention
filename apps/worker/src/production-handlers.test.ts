import { describe, expect, it, vi } from "vitest";

import type { ContentHandlerContext } from "./handlers";
import {
  createFetcherDocumentLoader,
  createProductionHandlers,
  extractDocument,
} from "./production-handlers";

function context(overrides: Partial<ContentHandlerContext> = {}): ContentHandlerContext {
  return {
    author: null,
    contentId: "00000000-0000-4000-8000-000000000001",
    outboundUrl: "https://example.com/deep-learning-notes?tracking=secret",
    publishedAt: null,
    signal: new AbortController().signal,
    source: "generic_web",
    title: null,
    ...overrides,
  };
}

describe("production enrichment handlers", () => {
  const fetcherEnv = {
    FETCHER_BASE_URL: "http://127.0.0.1:4100",
    FETCHER_SHARED_SECRET: "s".repeat(32),
  };

  it.each([403, 404, 429, 503, 302])(
    "retains upstream status %s from an HTTP 200 Fetcher envelope",
    async (status) => {
      const loader = createFetcherDocumentLoader(fetcherEnv, async () => Response.json({
        status,
        finalUrl: "https://example.com/article",
        redirects: [],
        contentType: "text/html",
        body: "<html><head><title>Access denied</title></head><body>Please verify your browser</body></html>",
      }));

      await expect(loader!.load(context())).resolves.toMatchObject({ status });
    },
  );

  it.each([undefined, "200", 200.5])(
    "rejects malformed upstream status %s",
    async (status) => {
      const loader = createFetcherDocumentLoader(fetcherEnv, async () => Response.json({
        status,
        finalUrl: "https://example.com/article",
        redirects: [],
        contentType: "text/html",
        body: "<html><body>Malformed envelope.</body></html>",
      }));

      await expect(loader!.load(context())).rejects.toMatchObject({
        code: "unknown_reader_error",
      });
    },
  );

  it("loads a successful upstream HTML response", async () => {
    const loader = createFetcherDocumentLoader(fetcherEnv, async () => Response.json({
      status: 200,
      finalUrl: "https://example.com/article",
      redirects: [],
      contentType: "text/html; charset=utf-8",
      body: "<html><body>Article evidence.</body></html>",
    }));

    await expect(loader!.load(context())).resolves.toEqual({
      finalUrl: "https://example.com/article",
      html: "<html><body>Article evidence.</body></html>",
      status: 200,
    });
  });

  it("retains a transport timeout as a typed reader failure", async () => {
    const loader = createFetcherDocumentLoader(fetcherEnv, async () => {
      throw new DOMException("request timed out", "TimeoutError");
    });

    await expect(loader!.load(context())).rejects.toMatchObject({
      code: "network_timeout",
      readerFailure: true,
      retryable: true,
    });
  });

  it("retains an HTTP 429 and bounded Retry-After as a typed reader failure", async () => {
    const loader = createFetcherDocumentLoader(fetcherEnv, async () => new Response(
      JSON.stringify({ error: { code: "overloaded" } }),
      { headers: { "retry-after": "120" }, status: 429 },
    ));

    await expect(loader!.load(context())).rejects.toMatchObject({
      code: "rate_limited",
      readerFailure: true,
      retryAfterMs: 120_000,
      retryable: true,
    });
  });

  it("preserves existing metadata and does not generate a summary from an upstream error page", async () => {
    const completeJson = vi.fn().mockResolvedValue({ summary: "Invented summary", tags: ["AI"] });
    const handlers = createProductionHandlers({
      documentLoader: createFetcherDocumentLoader(fetcherEnv, async () => Response.json({
        status: 403,
        finalUrl: "https://example.com/article",
        redirects: [],
        contentType: "text/html",
        body: "<html><head><title>Access denied</title></head><body>Verify your browser</body></html>",
      })),
      provider: { completeJson },
    });

    await expect(handlers.metadata(context({ title: "Original title" })))
      .resolves.toMatchObject({ title: "Original title" });
    await expect(handlers.summary(context())).rejects.toMatchObject({ code: "access_denied" });
    expect(completeJson).not.toHaveBeenCalled();
  });

  it("does not generate a summary from a title-only rendering shell", async () => {
    const completeJson = vi.fn().mockResolvedValue({ summary: "Invented summary", tags: ["AI"] });
    const handlers = createProductionHandlers({
      documentLoader: {
        load: async () => ({
          finalUrl: "https://example.com/article",
          html: "<html><head><title>Loading</title></head><body><div id=\"app\"></div><script src=\"/app.js\"></script></body></html>",
          status: 200,
        }),
      },
      provider: { completeJson },
    });

    await expect(handlers.summary(context())).rejects.toMatchObject({ code: "render_required" });
    expect(completeJson).not.toHaveBeenCalled();
  });

  it("does not generate a summary from metadata-only evidence", async () => {
    const completeJson = vi.fn().mockResolvedValue({ summary: "Invented", tags: ["AI"] });
    const handlers = createProductionHandlers({
      documentLoader: {
        load: async () => ({
          finalUrl: "https://example.com/article",
          html: `<html><head><title>Article preview</title>
            <meta name="description" content="Preview metadata only"></head>
            <body><div id="app"></div><script src="/app.js"></script></body></html>`,
          status: 200,
        }),
      },
      provider: { completeJson },
    });

    await expect(handlers.summary(context())).rejects.toMatchObject({ code: "render_required" });
    expect(completeJson).not.toHaveBeenCalled();
  });

  it("does not generate a summary from a 200 verification challenge", async () => {
    const completeJson = vi.fn().mockResolvedValue({ summary: "Invented", tags: ["AI"] });
    const handlers = createProductionHandlers({
      documentLoader: {
        load: async () => ({
          finalUrl: "https://example.com/article",
          html: `<html><body><form id="challenge-form" action="/challenge">
            <input name="cf-turnstile-response"><p>Complete the security check.</p></form></body></html>`,
          status: 200,
        }),
      },
      provider: { completeJson },
    });

    await expect(handlers.summary(context())).rejects.toMatchObject({
      code: "verification_required",
    });
    expect(completeJson).not.toHaveBeenCalled();
  });

  it("rejects a remote clear-text Fetcher endpoint before sending its bearer secret", () => {
    expect(() => createFetcherDocumentLoader({
      FETCHER_BASE_URL: "http://fetcher.example/v1",
      FETCHER_SHARED_SECRET: "s".repeat(32),
    })).toThrow(/HTTPS/u);
  });

  it("extracts necessary metadata and temporary text without returning HTML", () => {
    const result = extractDocument(`<!doctype html><html><head>
      <meta property="og:title" content="&quot;Grounded&quot; Notes">
      <meta name="author" content="Example Author">
      <meta property="article:published_time" content="2026-08-01T10:00:00Z">
      <meta name="description" content="A useful description">
      <script>privateBody()</script></head><body><p>Visible page text</p></body></html>`);
    expect(result).toMatchObject({
      author: "Example Author",
      description: "A useful description",
      text: "Visible page text",
      title: '"Grounded" Notes',
    });
    expect(result).not.toHaveProperty("html");
  });

  it("reports that hosted summary execution is not configured when no provider exists", async () => {
    const handlers = createProductionHandlers();
    expect(handlers.summaryConfigured).toBe(false);
    await expect(handlers.metadata(context())).resolves.toMatchObject({
      author: null,
      title: "deep learning notes",
    });
    await expect(handlers.summary(context())).rejects.toMatchObject({
      code: "summary_handler_not_configured",
      retryable: false,
    });
  });

  it("generates summary and tags from provider output while stripping URL query data", async () => {
    const completeJson = vi.fn().mockResolvedValue({
      summary: "这是一段仅根据可用页面证据生成的摘要。",
      tags: ["AI", "知识管理", "AI"],
    });
    const handlers = createProductionHandlers({
      documentLoader: {
        load: vi.fn().mockResolvedValue({
          finalUrl: "https://example.com/article?private=value",
          html: "<title>Article</title><body><article><p>Evidence from the page.</p></article></body>",
          status: 200,
        }),
      },
      provider: { completeJson },
    });
    expect(handlers.summaryConfigured).toBe(true);

    await expect(handlers.summary(context())).resolves.toEqual({
      status: "ready",
      summary: "这是一段仅根据可用页面证据生成的摘要。",
      tags: ["AI", "知识管理"],
    });
    const prompt = completeJson.mock.calls[0]?.[0].user as string;
    expect(prompt).toContain("Evidence from the page.");
    expect(prompt).toContain("https://example.com/article");
    expect(prompt).not.toContain("private=value");
  });
});
