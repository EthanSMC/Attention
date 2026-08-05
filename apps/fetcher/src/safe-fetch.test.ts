import { describe, expect, it } from "vitest";

import { FetcherError } from "./errors.js";
import { safeFetch, type AddressResolver } from "./safe-fetch.js";

describe("safeFetch deadline", () => {
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
