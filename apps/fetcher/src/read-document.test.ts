import { describe, expect, it, vi } from "vitest";
import { ReadResultSchema } from "@attention/content-reader-contracts";
import { readDocument, parseRetryAfter, BrowserUnavailableError } from "./read-document.js";

const input = {url: "https://example.com/article", sourceKind: "generic_web" as const,
  request_ref: "request1", attempt_ref: "attempt1", signal: new AbortController().signal};
const shell = {body: '<html><body><div id="app"></div><script src="/app.js"></script></body></html>',
  contentType: "text/html", finalUrl: input.url, status: 200, redirects: []};
const article = {html: "<html><body><article><p>A controlled synthetic article about public reading and bounded resource handling.</p></article></body></html>", finalUrl: input.url, status: 200};

describe("readDocument", () => {
  it.each([429, 503])("retains new-reader dependency retry and source Retry-After for HTTP %s", async status => {
    const read = vi.fn(async () => article);
    expect(await readDocument(input, {staticRead: async () => ({...shell, status, body: "", retryAfter: "30"}), browser: {read}, now: () => 100}))
      .toMatchObject({recovery: "retry_later", scope: "dependency", retry_after_ms: 30000, attempts: [{method: "static"}]});
    expect(read).not.toHaveBeenCalled();
  });
  it("extracts actual browser article evidence after one static shell", async () => {
    const result = await readDocument(input, {staticRead: async () => shell,
      browser: {read: async () => article}, now: () => 100});
    expect(result).toMatchObject({outcome: "ready", temporary_text: expect.stringContaining("controlled synthetic article"),
      attempts: [{method: "static"}, {method: "browser"}]});
    expect(ReadResultSchema.safeParse(result).success).toBe(true);
  });
  it("pauses when browser evidence is still empty without a second render", async () => {
    const read = vi.fn(async () => ({...article, html: shell.body}));
    expect(await readDocument(input, {staticRead: async () => shell, browser: {read}, now: () => 100}))
      .toMatchObject({code: "render_required", recovery: "pause", attempts: [{method: "static"}, {method: "browser"}]});
    expect(read).toHaveBeenCalledTimes(1);
  });
  it.each([[403, "", "access_denied"], [429, "", "rate_limited"],
    [200, "<h1>Verification required</h1>", "verification_required"]])("does not render source refusal %s", async (status, body, code) => {
    const read = vi.fn(async () => article);
    expect(await readDocument(input, {staticRead: async () => ({...shell, status: Number(status), body: String(body)}), browser: {read}, now: () => 100}))
      .toMatchObject({code, attempts: [{method: "static"}]});
    expect(read).not.toHaveBeenCalled();
  });
  it("rejects unsafe input before static or browser requests", async () => {
    const staticRead = vi.fn(async () => shell);
    expect(await readDocument({...input, url: "http://169.254.169.254/"}, {staticRead, browser: null, now: () => 100}))
      .toMatchObject({code: "unsafe_source", recovery: "stop"});
    expect(staticRead).not.toHaveBeenCalled();
  });
  it("pauses when no browser backend exists", async () => {
    expect(await readDocument(input, {staticRead: async () => shell, browser: null, now: () => 100}))
      .toMatchObject({code: "browser_backend_unavailable", recovery: "pause"});
  });
  it.each(["static", "browser"])("propagates cancellation during %s", async (phase) => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const pending = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      seen = signal; signal.addEventListener("abort", () => reject(new Error("cancelled")), {once: true});
      controller.abort();
    });
    const result = await readDocument({...input, signal: controller.signal}, {
      staticRead: async (_url, _kind, _mode, options) => phase === "static" ? pending(options!.signal!) : shell,
      browser: {read: async ({signal}) => pending(signal)}, now: () => 100});
    expect(seen?.aborted).toBe(true);
    expect(result).toMatchObject({code: "network_timeout"});
  });
  it("never returns article content from an unsafe final URL", async () => {
    expect(await readDocument(input, {staticRead: async () => ({...shell, body: article.html, finalUrl: "http://127.0.0.1/"}), browser: null, now: () => 100}))
      .toMatchObject({code: "unsafe_source"});
  });
  it("keeps cleanup uncertainty paused even when the caller also cancelled", async () => {
    const abort = new AbortController();
    expect(await readDocument({...input, signal: abort.signal}, {staticRead: async () => shell,
      browser: {read: async () => {abort.abort(); throw new BrowserUnavailableError(false);}}, now: () => 100}))
      .toMatchObject({code: "browser_backend_unavailable", recovery: "pause"});
  });
});

it("parses bounded delta and HTTP-date Retry-After without guessing malformed values", () => {
  expect(parseRetryAfter("30", 0)).toBe(30_000);
  expect(parseRetryAfter("Thu, 01 Jan 1970 00:01:00 GMT", 0)).toBe(60_000);
  expect(parseRetryAfter("9999999999", 0)).toBe(900_000);
  expect(parseRetryAfter("tomorrow", 0)).toBeNull();
});
