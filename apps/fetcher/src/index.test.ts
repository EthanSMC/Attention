import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "./index.js";

const secret = "test-fetcher-secret-that-is-long-enough";

function authorizedRequest(url = "https://example.com"): RequestInit {
  return {
    body: JSON.stringify({ url }),
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json"
    },
    method: "POST"
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetcher API", () => {
  it("requires the shared secret", async () => {
    const response = await createApp(secret).request("/v1/fetch", {
      body: JSON.stringify({ url: "https://example.com" }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });

    expect(response.status).toBe(401);
  });

  it("rejects private literal addresses without issuing a request", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await createApp(secret).request("/v1/fetch", {
      body: JSON.stringify({ url: "http://127.0.0.1/private" }),
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json"
      },
      method: "POST"
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "unsafe_address",
        request_id: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      },
    });
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(
      '"event":"fetcher.request_rejected"',
    ));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(
      '"code":"unsafe_address"',
    ));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(
      '"host":"127.0.0.1"',
    ));
    expect(warning).not.toHaveBeenCalledWith(expect.stringContaining("/private"));
  });

  it("does not echo unsafe credentials", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await createApp(secret).request("/v1/fetch", {
      body: JSON.stringify({
        url: "https://example.com/?access_token=never-echo-this"
      }),
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json"
      },
      method: "POST"
    });

    expect(response.status).toBe(422);
    expect(await response.text()).not.toContain("never-echo-this");
    expect(warning).not.toHaveBeenCalledWith(
      expect.stringContaining("never-echo-this"),
    );
  });

  it("cancels an oversized chunked body at 16 KiB and returns 413", async () => {
    let cancelled = false;
    let chunk = 0;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      pull(controller) {
        chunk += 1;
        controller.enqueue(new TextEncoder().encode(
          chunk === 1 ? "x".repeat(12 * 1024) : "internal-secret-sentinel".repeat(256),
        ));
      },
    });
    const fetchOperation = vi.fn();
    const request = new Request("http://fetcher.test/v1/fetch", {
      body,
      duplex: "half",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      method: "POST",
    } as RequestInit & { duplex: "half" });

    const response = await createApp(secret, { fetchOperation }).request(request);
    const responseBody = await response.text();

    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(fetchOperation).not.toHaveBeenCalled();
    expect(responseBody).toBe('{"error":{"code":"request_too_large"}}');
    expect(responseBody).not.toContain("internal-secret-sentinel");
  });

  it("returns 503 immediately when the concurrency limit is saturated", async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let finishFirst: (() => void) | undefined;
    const firstFinished = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const fetchOperation = vi.fn(async () => {
      markStarted?.();
      await firstFinished;
      return { finalUrl: "https://example.com/", redirects: [], status: 200 };
    });
    const app = createApp(secret, {
      fetchOperation,
      maxConcurrency: 1,
      maxQueue: 0,
      queueTimeoutMs: 100,
    });

    const first = app.request("/v1/fetch", authorizedRequest());
    await started;
    const overloaded = await app.request("/v1/fetch", authorizedRequest());

    expect(overloaded.status).toBe(503);
    expect(overloaded.headers.get("retry-after")).toBe("1");
    await expect(overloaded.json()).resolves.toEqual({ error: { code: "overloaded" } });

    finishFirst?.();
    expect((await first).status).toBe(200);
    expect(fetchOperation).toHaveBeenCalledTimes(1);
  });

  it("times out queued requests and releases capacity for later work", async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let finishFirst: (() => void) | undefined;
    const firstFinished = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    let calls = 0;
    const fetchOperation = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        markStarted?.();
        await firstFinished;
      }
      return { finalUrl: "https://example.com/", redirects: [], status: 200 };
    });
    const app = createApp(secret, {
      fetchOperation,
      maxConcurrency: 1,
      maxQueue: 1,
      queueTimeoutMs: 30,
    });

    const first = app.request("/v1/fetch", authorizedRequest());
    await started;
    const queued = await app.request("/v1/fetch", authorizedRequest());

    expect(queued.status).toBe(503);
    await expect(queued.json()).resolves.toEqual({ error: { code: "overloaded" } });
    finishFirst?.();
    expect((await first).status).toBe(200);

    const later = await app.request("/v1/fetch", authorizedRequest());
    expect(later.status).toBe(200);
    expect(fetchOperation).toHaveBeenCalledTimes(2);
  });
});
