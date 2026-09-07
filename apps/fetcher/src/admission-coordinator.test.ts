import {randomUUID} from "node:crypto";
import {describe, expect, it, vi} from "vitest";
import {readDocument} from "./read-document.js";
import {withBrowserAdmission} from "./browser-reader.js";
import type {safeFetch} from "./safe-fetch.js";

describe("fixed authenticated admission coordinator client", () => {
  it("preserves a full active global capacity denial as retryable rate limiting through the renderer adapter", async () => {
    const module = await import("./admission-coordinator.js");
    const admission = module.createAdmissionCoordinator({origin: "https://attention.test", secret: "s".repeat(32)},
      vi.fn(async () => Response.json({code: "rate_limited", retry_after_ms: 1000}, {status: 429})) as typeof fetch);
    const request = {url: "https://example.com/article", sourceKind: "generic_web" as const, request_ref: "r", attempt_ref: "a"};
    const render = vi.fn();
    const browser = withBrowserAdmission({read: render}, admission, randomUUID(), request);
    const result = await readDocument({...request, signal: new AbortController().signal}, {browser, now: Date.now,
      staticRead: vi.fn(async () => ({status: 200, finalUrl: request.url, body: '<div id="root"></div><script src="/app.js"></script>'})) as unknown as typeof safeFetch});
    expect(result).toMatchObject({code: "rate_limited", recovery: "retry_later", retry_after_ms: 1000});
    expect(render).not.toHaveBeenCalled();
  });
  it("binds consume and exact cleanup proof and aborts on status loss", async () => {
    const module = await import("./admission-coordinator.js").catch(() => undefined);
    expect(module).toBeDefined();
    const requests: {url: string; body: Record<string, unknown>}[] = [];
    const claim = randomUUID();
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      requests.push({url, body: JSON.parse(String(init.body))});
      if (url.endsWith("consume")) return Response.json({claim});
      if (url.endsWith("release")) return Response.json({released: true});
      return Response.json({active: false});
    });
    const admission = module!.createAdmissionCoordinator({origin: "https://attention.test", secret: "s".repeat(32)}, fetcher as typeof fetch);
    const input = {reference: randomUUID(), request_ref: "request-1", attempt_ref: "attempt-1", source_fingerprint: "b".repeat(64),
      renderer_ref: `attention-reader-${randomUUID()}`, signal: new AbortController().signal};
    const lease = await admission.consume(input); expect(lease).not.toBeNull();
    await vi.waitFor(() => expect(lease!.signal.aborted).toBe(true), {timeout: 1500});
    await lease!.release();
    expect(requests.map(x => x.url)).toEqual([
      "https://attention.test/api/internal/source-reader/consume", "https://attention.test/api/internal/source-reader/status",
      "https://attention.test/api/internal/source-reader/release"]);
    expect(requests[2]!.body).toMatchObject({claim, reference: input.reference, renderer_ref: input.renderer_ref});
    expect(requests[0]!.body).not.toHaveProperty("signal");
  });
  it("rejects insecure/mutable operator targets and keeps unverified backend disabled", async () => {
    const module = await import("./admission-coordinator.js").catch(() => undefined);
    expect(module).toBeDefined();
    expect(() => module!.createAdmissionCoordinator({origin: "http://example.test", secret: "s".repeat(32)})).toThrow();
    expect(() => module!.createAdmissionCoordinator({origin: "https://user:secret@example.test/path", secret: "s".repeat(32)})).toThrow();
    expect(module!.readerStartupOptions({})).toEqual({});
    expect(() => module!.readerStartupOptions({ATTENTION_READER_BACKEND: "isolated_oci"})).toThrow();
  });
});
