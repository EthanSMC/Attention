import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";

import * as schema from "./schema";

export type AttentionDatabase = PostgresJsDatabase<typeof schema>;
export type AttentionTransaction = Parameters<Parameters<AttentionDatabase["transaction"]>[0]>[0];

export interface DatabaseHandle {
  db: AttentionDatabase;
  sql: Sql;
  close: () => Promise<void>;
}

export interface DatabaseOptions {
  maxConnections?: number;
  prepare?: boolean;
}

export function createDatabase(databaseUrl: string, options: DatabaseOptions = {}): DatabaseHandle {
  if (!databaseUrl.trim()) {
    throw new Error("databaseUrl must not be empty");
  }

  const client = postgres(databaseUrl, {
    max: options.maxConnections ?? 10,
    prepare: options.prepare ?? false
  });

  return {
    db: drizzle(client, { schema }),
    sql: client,
    close: async () => {
      await client.end({ timeout: 5 });
    }
  };
}
