import "server-only";

import {
  createDatabase,
  type AttentionDatabase,
  type DatabaseHandle
} from "@attention/db";

const globalDatabase = globalThis as typeof globalThis & {
  __attentionDatabaseHandle?: DatabaseHandle;
};

function databaseUrl(): string {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) {
    throw new Error("DATABASE_URL is required by the Attention web server");
  }
  if (process.env.NODE_ENV === "production") {
    const expectedRole =
      process.env.ATTENTION_WEB_DATABASE_ROLE?.trim() || "attention_web_runtime";
    let username: string;
    try {
      username = decodeURIComponent(new URL(value).username);
    } catch {
      throw new Error("Production DATABASE_URL must be an absolute PostgreSQL URL");
    }
    if (username !== expectedRole) {
      throw new Error(
        `Production DATABASE_URL must authenticate as the non-owner role ${expectedRole}`
      );
    }
  }
  return value;
}

export function getDatabaseHandle(): DatabaseHandle {
  const existing = globalDatabase.__attentionDatabaseHandle;
  if (existing) {
    return existing;
  }

  const handle = createDatabase(databaseUrl());
  globalDatabase.__attentionDatabaseHandle = handle;
  return handle;
}

export function getWebDatabase(): AttentionDatabase {
  return getDatabaseHandle().db;
}

export const getDatabase = getWebDatabase;
