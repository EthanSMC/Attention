import "server-only";

import { createHash } from "node:crypto";

import {
  and,
  eq,
  lt,
  mcpRateLimitBuckets,
  setAccountContext,
  sql,
  type AttentionDatabase,
} from "@attention/db";

import type { CloudPrincipal } from "./cloud-credentials";

const WINDOW_MS = 60_000;
const RETENTION_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_REQUESTS_PER_MINUTE = 120;
const MIN_REQUESTS_PER_MINUTE = 10;
const MAX_REQUESTS_PER_MINUTE = 1_000;

export interface McpRateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

export function mcpRequestsPerMinute(
  rawValue = process.env.ATTENTION_MCP_REQUESTS_PER_MINUTE,
): number {
  if (!rawValue?.trim()) return DEFAULT_REQUESTS_PER_MINUTE;
  const parsed = Number(rawValue);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < MIN_REQUESTS_PER_MINUTE ||
    parsed > MAX_REQUESTS_PER_MINUTE
  ) {
    throw new Error(
      `ATTENTION_MCP_REQUESTS_PER_MINUTE must be an integer from ${MIN_REQUESTS_PER_MINUTE} to ${MAX_REQUESTS_PER_MINUTE}`,
    );
  }
  return parsed;
}

export function mcpRateLimitClientKey(principal: CloudPrincipal): string {
  return createHash("sha256")
    .update("attention:mcp-rate-limit:v1\0")
    .update(principal.credentialKind)
    .update("\0")
    .update(principal.clientId ?? "pat")
    .digest("hex");
}

export async function consumeMcpRequestBudget(
  db: AttentionDatabase,
  principal: CloudPrincipal,
  options: { limit?: number; now?: Date } = {},
): Promise<McpRateLimitDecision> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? mcpRequestsPerMinute();
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("invalid_mcp_rate_limit");
  }
  const windowStartedAt = new Date(
    Math.floor(now.getTime() / WINDOW_MS) * WINDOW_MS,
  );
  const expiresAt = new Date(windowStartedAt.getTime() + WINDOW_MS);
  const retentionCutoff = new Date(now.getTime() - RETENTION_MS);
  const clientKey = mcpRateLimitClientKey(principal);

  const requestCount = await db.transaction(async (tx) => {
    await setAccountContext(tx, principal.accountId);
    await tx
      .delete(mcpRateLimitBuckets)
      .where(
        and(
          eq(mcpRateLimitBuckets.accountId, principal.accountId),
          lt(mcpRateLimitBuckets.windowStartedAt, retentionCutoff),
        ),
      );
    const [bucket] = await tx
      .insert(mcpRateLimitBuckets)
      .values({
        accountId: principal.accountId,
        clientKey,
        credentialId: principal.credentialId,
        requestCount: 1,
        updatedAt: now,
        windowStartedAt,
      })
      .onConflictDoUpdate({
        set: {
          requestCount: sql`${mcpRateLimitBuckets.requestCount} + 1`,
          updatedAt: now,
        },
        target: [
          mcpRateLimitBuckets.accountId,
          mcpRateLimitBuckets.credentialId,
          mcpRateLimitBuckets.clientKey,
          mcpRateLimitBuckets.windowStartedAt,
        ],
      })
      .returning({ requestCount: mcpRateLimitBuckets.requestCount });
    if (!bucket) throw new Error("mcp_rate_limit_bucket_missing");
    return bucket.requestCount;
  });

  return {
    allowed: requestCount <= limit,
    limit,
    remaining: Math.max(0, limit - requestCount),
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((expiresAt.getTime() - now.getTime()) / 1_000),
    ),
  };
}
