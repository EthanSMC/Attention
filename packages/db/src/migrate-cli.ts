import { createDatabase } from "./client";
import { migrateDatabase } from "./migrate";

const runtimeProcess = (
  globalThis as typeof globalThis & {
    process?: { env: Record<string, string | undefined> };
  }
).process;
const databaseUrl =
  runtimeProcess?.env.MIGRATION_DATABASE_URL ?? runtimeProcess?.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL is required");
}

const handle = createDatabase(databaseUrl, { maxConnections: 1 });
try {
  await migrateDatabase(handle.db);
} finally {
  await handle.close();
}
