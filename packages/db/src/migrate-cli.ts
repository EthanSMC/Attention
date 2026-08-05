import { createDatabase } from "./client";
import { migrateDatabase } from "./migrate";
import {
  loadMigrationConfig,
  runGuardedMigration,
  type MigrationQuery,
} from "./migration-guard";

const runtimeProcess = (
  globalThis as typeof globalThis & {
    process?: { env: Record<string, string | undefined> };
  }
).process;
const config = loadMigrationConfig(runtimeProcess?.env ?? {});

const handle = createDatabase(config.databaseUrl, { maxConnections: 1 });
const query: MigrationQuery = async (statement, parameters) =>
  handle.sql.unsafe<Record<string, unknown>[]>(
    statement,
    parameters ? [...parameters] : undefined,
  );
try {
  await runGuardedMigration(query, config, () => migrateDatabase(handle.db));
} finally {
  await handle.close();
}
