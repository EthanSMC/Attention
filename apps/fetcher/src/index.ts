import { timingSafeEqual } from "node:crypto";

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { z } from "zod";

import { FetcherError } from "./errors.js";
import { safeFetch } from "./safe-fetch.js";

const envSchema = z.object({
  FETCHER_HOST: z.string().default("127.0.0.1"),
  FETCHER_PORT: z.coerce.number().int().min(1).max(65_535).default(4100),
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

export function createApp(sharedSecret: string): Hono {
  const app = new Hono();

  app.get("/health", (context) => context.json({ status: "ok" }));

  app.post("/v1/fetch", async (context) => {
    if (!isAuthorized(context.req.header("authorization"), sharedSecret)) {
      return context.json({ error: { code: "unauthorized" } }, 401);
    }

    const parsed = requestSchema.safeParse(await context.req.json().catch(() => undefined));
    if (!parsed.success) {
      return context.json({ error: { code: "invalid_request" } }, 400);
    }

    try {
      return context.json(
        await safeFetch(parsed.data.url, parsed.data.sourceKind, parsed.data.mode)
      );
    } catch (error) {
      if (error instanceof FetcherError) {
        return context.json({ error: { code: error.code } }, 422);
      }
      return context.json({ error: { code: "internal_error" } }, 500);
    }
  });

  return app;
}

if (process.env.NODE_ENV !== "test") {
  const env = envSchema.parse(process.env);
  serve({
    fetch: createApp(env.FETCHER_SHARED_SECRET).fetch,
    hostname: env.FETCHER_HOST,
    port: env.FETCHER_PORT
  });
}
