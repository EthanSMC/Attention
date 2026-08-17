import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { z } from "zod";

import { FetcherError } from "./errors.js";
import { safeFetch } from "./safe-fetch.js";

const DEFAULT_MAX_CONCURRENCY = 16;
const DEFAULT_MAX_QUEUE = 32;
const DEFAULT_QUEUE_TIMEOUT_MS = 1_000;
const MAX_REQUEST_BODY_BYTES = 16 * 1024;

const envSchema = z.object({
  FETCHER_HOST: z.string().default("127.0.0.1"),
  FETCHER_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(128)
    .default(DEFAULT_MAX_CONCURRENCY),
  FETCHER_MAX_QUEUE: z.coerce.number().int().min(0).max(512).default(DEFAULT_MAX_QUEUE),
  FETCHER_PORT: z.coerce.number().int().min(1).max(65_535).default(4100),
  FETCHER_QUEUE_TIMEOUT_MS: z.coerce.number().int().min(50).max(8_000)
    .default(DEFAULT_QUEUE_TIMEOUT_MS),
  FETCHER_SHARED_SECRET: z.string().min(32)
});

const requestSchema = z.object({
  mode: z.enum(["resolve", "metadata"]).default("resolve"),
  sourceKind: z
    .enum(["douyin", "xiaohongshu", "wechat_official_article", "generic_web"])
    .default("generic_web"),
  url: z.string().min(1).max(4_096)
});

function isAuthorized(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice("Bearer ".length));
  const target = Buffer.from(expected);
  return actual.length === target.length && timingSafeEqual(actual, target);
}

class RequestBodyTooLargeError extends Error {}

function safeTargetLogFields(rawUrl: string): {
  host: string | null;
  pathFingerprint: string | null;
} {
  try {
    const url = new URL(rawUrl);
    return {
      host: url.hostname.toLowerCase().replace(/\.+$/u, ""),
      pathFingerprint: createHash("sha256")
        .update(url.pathname)
        .digest("hex")
        .slice(0, 16),
    };
  } catch {
    return { host: null, pathFingerprint: null };
  }
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  await body?.cancel().catch(() => undefined);
}

async function readLimitedJson(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && /^\d+$/u.test(declaredLength) &&
    Number(declaredLength) > MAX_REQUEST_BODY_BYTES) {
    await cancelBody(request.body);
    throw new RequestBodyTooLargeError();
  }
  if (!request.body) return undefined;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new RequestBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
}

type ReleaseCapacity = () => void;

interface CapacityWaiter {
  abort: (() => void) | null;
  resolve: (release: ReleaseCapacity | null) => void;
  signal: AbortSignal | null;
  timeout: ReturnType<typeof setTimeout>;
}

class CapacityLimiter {
  private active = 0;
  private readonly queue: CapacityWaiter[] = [];

  constructor(
    private readonly maxConcurrency: number,
    private readonly maxQueue: number,
    private readonly queueTimeoutMs: number,
  ) {}

  async acquire(signal?: AbortSignal): Promise<ReleaseCapacity | null> {
    if (signal?.aborted) return null;
    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return this.releaseHandle();
    }
    if (this.queue.length >= this.maxQueue) return null;

    return await new Promise<ReleaseCapacity | null>((resolve) => {
      const waiter: CapacityWaiter = {
        abort: null,
        resolve,
        signal: signal ?? null,
        timeout: setTimeout(() => this.rejectWaiter(waiter), this.queueTimeoutMs),
      };
      if (signal) {
        waiter.abort = (): void => this.rejectWaiter(waiter);
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      this.queue.push(waiter);
    });
  }

  private cleanupWaiter(waiter: CapacityWaiter): void {
    clearTimeout(waiter.timeout);
    if (waiter.signal && waiter.abort) {
      waiter.signal.removeEventListener("abort", waiter.abort);
    }
  }

  private dispatchNext(): void {
    while (this.active < this.maxConcurrency) {
      const waiter = this.queue.shift();
      if (!waiter) return;
      this.cleanupWaiter(waiter);
      if (waiter.signal?.aborted) {
        waiter.resolve(null);
        continue;
      }
      this.active += 1;
      waiter.resolve(this.releaseHandle());
    }
  }

  private rejectWaiter(waiter: CapacityWaiter): void {
    const index = this.queue.indexOf(waiter);
    if (index < 0) return;
    this.queue.splice(index, 1);
    this.cleanupWaiter(waiter);
    waiter.resolve(null);
  }

  private releaseHandle(): ReleaseCapacity {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.dispatchNext();
    };
  }
}

export interface FetcherAppOptions {
  fetchOperation?: typeof safeFetch;
  maxConcurrency?: number;
  maxQueue?: number;
  queueTimeoutMs?: number;
}

export function createApp(sharedSecret: string, options: FetcherAppOptions = {}): Hono {
  const app = new Hono();
  const capacity = new CapacityLimiter(
    options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
    options.maxQueue ?? DEFAULT_MAX_QUEUE,
    options.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS,
  );
  const fetchOperation = options.fetchOperation ?? safeFetch;

  app.get("/health", (context) => context.json({ status: "ok" }));

  app.post("/v1/fetch", async (context) => {
    if (!isAuthorized(context.req.header("authorization"), sharedSecret)) {
      await cancelBody(context.req.raw.body);
      return context.json({ error: { code: "unauthorized" } }, 401);
    }

    const release = await capacity.acquire(context.req.raw.signal);
    if (!release) {
      await cancelBody(context.req.raw.body);
      context.header("Cache-Control", "no-store");
      context.header("Retry-After", "1");
      return context.json({ error: { code: "overloaded" } }, 503);
    }

    const requestId = randomUUID();
    context.header("X-Request-Id", requestId);
    let requestForLog: z.infer<typeof requestSchema> | null = null;
    try {
      let payload: unknown;
      try {
        payload = await readLimitedJson(context.req.raw);
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) {
          context.header("Cache-Control", "no-store");
          return context.json({ error: { code: "request_too_large" } }, 413);
        }
        return context.json({ error: { code: "invalid_request" } }, 400);
      }
      const parsed = requestSchema.safeParse(payload);
      if (!parsed.success) {
        return context.json({ error: { code: "invalid_request" } }, 400);
      }
      requestForLog = parsed.data;

      return context.json(
        await fetchOperation(parsed.data.url, parsed.data.sourceKind, parsed.data.mode)
      );
    } catch (error) {
      if (error instanceof FetcherError) {
        const target = requestForLog
          ? safeTargetLogFields(requestForLog.url)
          : { host: null, pathFingerprint: null };
        console.warn(JSON.stringify({
          code: error.code,
          event: "fetcher.request_rejected",
          host: target.host,
          mode: requestForLog?.mode ?? null,
          path_fingerprint: target.pathFingerprint,
          request_id: requestId,
          source_kind: requestForLog?.sourceKind ?? null,
        }));
        return context.json(
          { error: { code: error.code, request_id: requestId } },
          422,
        );
      }
      console.error(JSON.stringify({
        event: "fetcher.request_failed",
        request_id: requestId,
      }));
      return context.json({ error: { code: "internal_error" } }, 500);
    } finally {
      release();
    }
  });

  return app;
}

if (process.env.NODE_ENV !== "test") {
  const env = envSchema.parse(process.env);
  serve({
    fetch: createApp(env.FETCHER_SHARED_SECRET, {
      maxConcurrency: env.FETCHER_MAX_CONCURRENCY,
      maxQueue: env.FETCHER_MAX_QUEUE,
      queueTimeoutMs: env.FETCHER_QUEUE_TIMEOUT_MS,
    }).fetch,
    hostname: env.FETCHER_HOST,
    port: env.FETCHER_PORT
  });
}
