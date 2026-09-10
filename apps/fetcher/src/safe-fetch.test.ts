import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Undici from "undici";
const remote = vi.hoisted(() => ({fetch: vi.fn(), connector: vi.fn()}));
vi.mock("undici", async (original) => ({...await original<typeof Undici>(), fetch: remote.fetch,
  buildConnector: remote.connector,
  Agent: class {
    constructor(readonly options: {connect: (options: unknown, callback: (error: Error | null, socket: unknown) => void) => void}) {}
    async destroy() {}
  },
}));

import { FetcherError } from "./errors.js";
import { safeFetch, safeFetchResource, readLimitedBytes, type AddressResolver } from "./safe-fetch.js";
afterEach(() => vi.resetAllMocks());
const publicResolver: AddressResolver = async () => [{address: "93.184.216.34", family: 4}];

it("reports the WeChat captcha redirect without following or accepting its token URL", async () => {
  remote.fetch.mockImplementation(async () => new Response(null, { status: 302, headers: {
    location: "https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha?poc_token=synthetic&target_url=synthetic",
  } }));
  await expect(safeFetch("https://mp.weixin.qq.com/s/example", "wechat_official_article", "read", { resolveAddresses: publicResolver }))
    .rejects.toMatchObject({ code: "verification_required" });
  expect(remote.fetch).toHaveBeenCalledOnce();
  await expect(safeFetch("https://mp.weixin.qq.com/s/example", "wechat_official_article", "metadata", { resolveAddresses: publicResolver }))
    .rejects.toMatchObject({ code: "unsafe_credentials" });
  expect(remote.fetch).toHaveBeenCalledTimes(2);
});

it("preserves target refusal status for read mode while preserving legacy HTML rejection", async () => {
  remote.fetch.mockImplementation(async () => new Response("refused", {status: 429, headers: {"content-type": "application/json", "retry-after": "30"}}));
  await expect(safeFetch("https://example.com/", "generic_web", "read", {resolveAddresses: publicResolver}))
    .resolves.toMatchObject({status: 429, retryAfter: "30", body: ""});
  await expect(safeFetch("https://example.com/", "generic_web", "metadata", {resolveAddresses: publicResolver}))
    .rejects.toMatchObject({code: "unsupported_content_type"});
});
it("reads binary resource bytes and blocks a redirect to metadata IP before another request", async () => {
  remote.fetch.mockImplementationOnce(async () => new Response(new Uint8Array([0, 255, 1]), {headers: {"content-type": "application/octet-stream"}}));
  expect((await safeFetchResource("https://example.com/app.js", "generic_web", {resolveAddresses: publicResolver})).bytes)
    .toEqual(new Uint8Array([0, 255, 1]));
  remote.fetch.mockImplementationOnce(async () => new Response(null, {status: 302, headers: {location: "http://169.254.169.254/latest"}}));
  await expect(safeFetchResource("https://example.com/app.js", "generic_web", {resolveAddresses: publicResolver}))
    .rejects.toMatchObject({code: "unsafe_address"});
  expect(remote.fetch).toHaveBeenCalledTimes(2);
});
it("rejects mixed public/private DNS answers without sending a request", async () => {
  await expect(safeFetchResource("https://example.com/a", "generic_web", {resolveAddresses: async () => [
    {address: "93.184.216.34", family: 4}, {address: "127.0.0.1", family: 4}]})).rejects.toMatchObject({code: "unsafe_address"});
  expect(remote.fetch).not.toHaveBeenCalled();
});
it("destroys a connected peer that differs from the pinned public address", async () => {
  const destroy = vi.fn();
  remote.connector.mockReturnValue((_options: unknown, callback: (error: null, socket: unknown) => void) => callback(null, {remoteAddress: "127.0.0.1", destroy}));
  remote.fetch.mockImplementation(async (_url, {dispatcher}) => {
    await new Promise((resolve, reject) => dispatcher.options.connect({}, (error: Error | null, socket: unknown) => error ? reject(error) : resolve(socket)));
    return new Response("unexpected");
  });
  await expect(safeFetchResource("https://example.com/a", "generic_web", {resolveAddresses: publicResolver})).rejects.toMatchObject({code: "fetch_failed"});
  expect(destroy).toHaveBeenCalledOnce();
});
it("rechecks DNS on every redirected resource hop", async () => {
  const resolveAddresses = vi.fn().mockResolvedValueOnce([{address: "93.184.216.34", family: 4}]).mockResolvedValueOnce([{address: "169.254.169.254", family: 4}]);
  remote.fetch.mockImplementation(async () => new Response(null, {status: 302, headers: {location: "https://example.com/next"}}));
  await expect(safeFetchResource("https://example.com/start", "generic_web", {resolveAddresses})).rejects.toMatchObject({code: "unsafe_address"});
  expect(resolveAddresses).toHaveBeenCalledTimes(2);
  expect(remote.fetch).toHaveBeenCalledOnce();
});
it("cancels stalled body consumption when the caller aborts", async () => {
  const abort = new AbortController();
  let cancelled = false;
  const response = new Response(new ReadableStream({cancel() {cancelled = true;}}));
  const result = readLimitedBytes(response, 10, abort.signal);
  abort.abort();
  await expect(result).rejects.toMatchObject({name: "AbortError"});
  expect(cancelled).toBe(true);
});
it("cancels the stream when byte limit is exceeded", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({start(controller) {controller.enqueue(new Uint8Array(11));}, cancel() {cancelled = true;}}));
  await expect(readLimitedBytes(response, 10, new AbortController().signal)).rejects.toMatchObject({code: "response_too_large"});
  expect(cancelled).toBe(true);
});

describe("safeFetch deadline", () => {
  it("propagates caller cancellation through DNS", async () => {
    const controller = new AbortController();
    let observed: AbortSignal | undefined;
    const request = safeFetch("https://example.com/article", "generic_web", "read", {
      signal: controller.signal,
      resolveAddresses: async (_host, signal) => { observed = signal; return await new Promise(() => undefined); },
    });
    controller.abort();
    await expect(request).rejects.toMatchObject({code: "timeout"});
    expect(observed?.aborted).toBe(true);
  });
  it("includes DNS resolution in the total deadline and aborts the resolver", async () => {
    const observed: { signal?: AbortSignal } = {};
    const slowResolver: AddressResolver = async (_hostname, signal) => {
      observed.signal = signal;
      return await new Promise(() => undefined);
    };
    const startedAt = Date.now();

    let caught: unknown;
    try {
      await safeFetch("https://example.com/article", "generic_web", "resolve", {
        resolveAddresses: slowResolver,
        timeoutMs: 30,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(FetcherError);
    expect((caught as FetcherError).code).toBe("timeout");
    expect(observed.signal).toBeDefined();
    expect(observed.signal?.aborted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
