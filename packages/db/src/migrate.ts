import { migrate } from "drizzle-orm/postgres-js/migrator";

import type { AttentionDatabase } from "./client";

export const defaultMigrationsFolder = decodeURIComponent(
  new URL("../drizzle", import.meta.url).pathname
);

export async function migrateDatabase(
  db: AttentionDatabase,
  migrationsFolder = defaultMigrationsFolder
): Promise<void> {
  await migrate(db, { migrationsFolder });
}
