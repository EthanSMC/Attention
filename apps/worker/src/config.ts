import { hostname } from "node:os";

import { ENRICHMENT_QUEUE } from "./contracts.js";

export interface WorkerConfig {
  baseRetryMs: number;
  concurrency: number;
  databaseUrl: string;
  leaseMs: number;
  maxRetryMs: number;
  pollIntervalMs: number;
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

  return {
    baseRetryMs: parseInteger(env, "WORKER_BASE_RETRY_MS", 5_000, {
      max: 3_600_000,
      min: 100,
    }),
    concurrency: parseInteger(env, "WORKER_CONCURRENCY", 2, { max: 32, min: 1 }),
    databaseUrl,
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
    queue,
    workerId: normalizeWorkerId(env.WORKER_ID?.trim() || defaultWorkerId),
  };
}
