import { hostname } from "node:os";

import { ENRICHMENT_QUEUE } from "./contracts.js";

export interface WorkerConfig {
  baseRetryMs: number;
  concurrency: number;
  databaseUrl: string;
  digestBatchSize: number;
  digestEnabled: boolean;
  digestMaxAttempts: number;
  digestPollIntervalMs: number;
  leaseMs: number;
  maxRetryMs: number;
  pollIntervalMs: number;
  publicOrigin: string;
  queue: string;
  workerId: string;
}

function parseInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  range: { max: number; min: number },
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < range.min || value > range.max) {
    throw new Error(`${name} must be an integer between ${range.min} and ${range.max}`);
  }
  return value;
}

function normalizeWorkerId(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._:-]/gu, "-").slice(0, 60);
  if (!normalized) throw new Error("WORKER_ID must contain a safe identifier");
  return normalized;
}

function parseBoolean(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false`);
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const databaseUrl = env.WORKER_DATABASE_URL ?? env.DATABASE_URL;
  if (!databaseUrl?.trim()) {
    throw new Error("WORKER_DATABASE_URL or DATABASE_URL is required");
  }
  if (env.NODE_ENV === "production") {
    const expectedRole =
      env.ATTENTION_WORKER_DATABASE_ROLE?.trim() || "attention_worker_runtime";
    let username: string;
    try {
      username = decodeURIComponent(new URL(databaseUrl).username);
    } catch {
      throw new Error("Production WORKER_DATABASE_URL must be an absolute PostgreSQL URL");
    }
    if (username !== expectedRole) {
      throw new Error(
        `Production WORKER_DATABASE_URL must authenticate as the non-owner role ${expectedRole}`,
      );
    }
  }

  const queue = env.WORKER_QUEUE?.trim() || ENRICHMENT_QUEUE;
  if (queue.length > 60) {
    throw new Error("WORKER_QUEUE must contain at most 60 characters");
  }

  const defaultWorkerId = `${hostname()}:${process.pid}:${globalThis.crypto.randomUUID().slice(0, 8)}`;
  const digestEnabled = parseBoolean(env, "ATTENTION_DIGEST_WORKER_ENABLED", true);
  const configuredPublicUrl = env.NEXT_PUBLIC_APP_URL?.trim();
  if (env.NODE_ENV === "production" && digestEnabled && !configuredPublicUrl) {
    throw new Error("NEXT_PUBLIC_APP_URL is required when the digest worker is enabled");
  }
  const publicUrl = configuredPublicUrl || "http://localhost:3000";
  let publicOrigin: string;
  try {
    const parsed = new URL(publicUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("unsupported protocol");
    }
    publicOrigin = parsed.origin;
  } catch {
    throw new Error("NEXT_PUBLIC_APP_URL must be an absolute HTTP(S) URL");
  }
  return {
    baseRetryMs: parseInteger(env, "WORKER_BASE_RETRY_MS", 5_000, {
      max: 3_600_000,
      min: 100,
    }),
    concurrency: parseInteger(env, "WORKER_CONCURRENCY", 2, { max: 32, min: 1 }),
    databaseUrl,
    digestBatchSize: parseInteger(env, "DIGEST_BATCH_SIZE", 50, {
      max: 500,
      min: 1,
    }),
    digestEnabled,
    digestMaxAttempts: parseInteger(env, "DIGEST_MAX_ATTEMPTS", 8, {
      max: 32,
      min: 1,
    }),
    digestPollIntervalMs: parseInteger(env, "DIGEST_POLL_INTERVAL_MS", 60_000, {
      max: 300_000,
      min: 1_000,
    }),
    leaseMs: parseInteger(env, "WORKER_LEASE_MS", 60_000, {
      max: 3_600_000,
      min: 5_000,
    }),
    maxRetryMs: parseInteger(env, "WORKER_MAX_RETRY_MS", 900_000, {
      max: 86_400_000,
      min: 1_000,
    }),
    pollIntervalMs: parseInteger(env, "WORKER_POLL_INTERVAL_MS", 1_000, {
      max: 60_000,
      min: 50,
    }),
    publicOrigin,
    queue,
    workerId: normalizeWorkerId(env.WORKER_ID?.trim() || defaultWorkerId),
  };
}
