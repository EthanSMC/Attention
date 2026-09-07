import {afterEach, describe, expect, it, vi} from "vitest";
import * as client from "./fetcher-client";

afterEach(() => {vi.unstubAllEnvs(); vi.unstubAllGlobals();});
describe("trusted source reader client", () => {
  it("rejects a ready response for a different source kind without legacy fallback", async () => {
    vi.stubEnv("FETCHER_BASE_URL", "https://fetcher.example.test"); vi.stubEnv("FETCHER_SHARED_SECRET", "s".repeat(32));
    const fetch = vi.fn(async () => Response.json({schema_version: 1, request_ref: "r", attempt_ref: "a", outcome: "ready",
      attempts: [{method: "static", duration_ms: 5}], temporary_text: "Synthetic article evidence.", evidence_kind: "article",
      extraction_method: "readability", final_public_url: "https://example.com/article", source_kind: "douyin",
      read_at: "2026-09-07T00:00:00.000Z", truncated: false,
      metadata: {author: null, title: null, description: null, published_at: null}}));
    vi.stubGlobal("fetch", fetch);
    await expect(client.readExternalSource({request_ref: "r", attempt_ref: "a", sourceKind: "generic_web", url: "https://example.com/article"},
      {signal: new AbortController().signal, admissionReference: "reference-1"})).rejects.toMatchObject({code: "invalid_fetcher_response"});
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([403, 404])("classifies legacy target HTTP %s as source evidence without a browser attempt", async status => {
    vi.stubEnv("FETCHER_BASE_URL", "https://fetcher.example.test"); vi.stubEnv("FETCHER_SHARED_SECRET", "s".repeat(32));
    const fetch = vi.fn().mockResolvedValueOnce(new Response("missing", {status: 404})).mockResolvedValueOnce(Response.json({
      body: "<h1>Unavailable</h1>", finalUrl: "https://example.com/article", status,
    })); vi.stubGlobal("fetch", fetch);
    const result = await client.readExternalSource({request_ref: "r", attempt_ref: "a", sourceKind: "generic_web", url: "https://example.com/article"},
      {signal: new AbortController().signal, admissionReference: "reference-1"});
    expect(result).toMatchObject({code: status === 403 ? "access_denied" : "source_not_found", attempts: [{method: "static", duration_ms: expect.any(Number)}]});
    expect(result).not.toHaveProperty("temporary_text"); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([{invalid: "private error"}, {schema_version: 1, request_ref: "different", attempt_ref: "a", attempts: [], outcome: "skipped", reason: "already_ready"}])("rejects malformed or miscorrelated current responses without fallback or fabricated method history", async payload => {
      vi.stubEnv("FETCHER_BASE_URL", "https://fetcher.example.test"); vi.stubEnv("FETCHER_SHARED_SECRET", "s".repeat(32));
      const fetch = vi.fn(async () => Response.json(payload)); vi.stubGlobal("fetch", fetch);
      await expect(client.readExternalSource({request_ref: "r", attempt_ref: "a", sourceKind: "generic_web", url: "https://example.com"},
        {signal: new AbortController().signal, admissionReference: "reference-1"})).rejects.toMatchObject({code: "invalid_fetcher_response"});
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  it.each([403, 500])("does not fall back for HTTP %s and reports a bounded transport error", async status => {
    vi.stubEnv("FETCHER_BASE_URL", "https://fetcher.example.test"); vi.stubEnv("FETCHER_SHARED_SECRET", "s".repeat(32));
    const fetch = vi.fn(async () => new Response("private details", {status})); vi.stubGlobal("fetch", fetch);
    await expect(client.readExternalSource({request_ref: "r", attempt_ref: "a", sourceKind: "generic_web", url: "https://example.com"},
      {signal: new AbortController().signal, admissionReference: "reference-1"})).rejects.toMatchObject({code: "fetcher_unavailable"});
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("falls back only for endpoint 404 to classified static legacy evidence", async () => {
    vi.stubEnv("FETCHER_BASE_URL", "https://fetcher.example.test"); vi.stubEnv("FETCHER_SHARED_SECRET", "s".repeat(32));
    const request = {request_ref: "r", attempt_ref: "a", sourceKind: "generic_web" as const, url: "https://example.com/article"};
    const html = `<article><h1>Fixture article</h1>${"<p>A synthetic article explains a specific experiment, its collected observations and measured conclusions. The evidence was checked against independent controls and reported with explicit limits.</p>".repeat(12)}</article>`;
    const fetch = vi.fn().mockResolvedValueOnce(new Response("missing", {status: 404})).mockResolvedValueOnce(Response.json({
      finalUrl: "https://example.com/final", body: html, status: 200, redirects: [],
    }));
    vi.stubGlobal("fetch", fetch);
    const result = await client.readExternalSource(request, {signal: new AbortController().signal, admissionReference: "reference-1"});
    expect(result).toMatchObject({outcome: "ready", request_ref: "r", attempt_ref: "a", final_public_url: "https://example.com/final",
      attempts: [{method: "static", duration_ms: expect.any(Number)}]});
    expect(fetch.mock.calls[1]).toEqual(["https://fetcher.example.test/v1/fetch", expect.objectContaining({body: JSON.stringify({mode: "metadata", sourceKind: "generic_web", url: request.url})})]);
    expect(fetch.mock.calls[1]![1].headers).not.toHaveProperty("x-reader-admission");
  });
  it("uses /v1/read with a separate server admission header and preserves strict correlation", async () => {
    expect(client).toHaveProperty("readExternalSource");
    vi.stubEnv("FETCHER_BASE_URL", "https://fetcher.example.test"); vi.stubEnv("FETCHER_SHARED_SECRET", "s".repeat(32));
    const request = {request_ref: "request-1", attempt_ref: "attempt-1", sourceKind: "generic_web" as const, url: "https://example.test/article"};
    const fetch = vi.fn(async () => Response.json({schema_version: 1, ...request, url: undefined, sourceKind: undefined,
      attempts: [], outcome: "skipped", reason: "already_ready"}));
    vi.stubGlobal("fetch", fetch);
    expect(await client.readExternalSource(request, {signal: new AbortController().signal, admissionReference: "reference-1"})).toMatchObject({outcome: "skipped"});
    expect(fetch.mock.calls[0]).toEqual(["https://fetcher.example.test/v1/read", expect.objectContaining({
      body: JSON.stringify(request), headers: expect.objectContaining({"x-reader-admission": "reference-1"}), redirect: "error"})]);
  });
  it("returns a truthful empty preflight when no Fetcher is configured", async () => {
    expect(client).toHaveProperty("readExternalSource");
    vi.stubEnv("FETCHER_BASE_URL", ""); vi.stubEnv("FETCHER_SHARED_SECRET", "");
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(await client.readExternalSource({request_ref: "r", attempt_ref: "a", sourceKind: "generic_web", url: "https://example.test"},
      {signal: new AbortController().signal, admissionReference: "reference-1"})).toMatchObject({code: "reader_not_configured", attempts: []});
    expect(fetch).not.toHaveBeenCalled();
  });
});
