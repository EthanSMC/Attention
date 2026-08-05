import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseHandle } from "@attention/db";
import {
  loadMigrationConfig,
  runGuardedMigration,
  type MigrationQuery,
} from "../../packages/db/src/migration-guard";

const databaseUrl = process.env.TEST_MIGRATION_DATABASE_URL;

describe.skipIf(!databaseUrl)("migration guard against PostgreSQL", () => {
  let first: DatabaseHandle;
  let second: DatabaseHandle;

  beforeAll(() => {
    first = createDatabase(databaseUrl!, { maxConnections: 1 });
    second = createDatabase(databaseUrl!, { maxConnections: 1 });
  });

  afterAll(async () => {
    await Promise.all([first.close(), second.close()]);
  });

  it("serializes migrators and releases the session lock", async () => {
    const parsedUrl = new URL(databaseUrl!);
    const config = loadMigrationConfig({
      NODE_ENV: "production",
      MIGRATION_DATABASE_URL: databaseUrl,
      ATTENTION_MIGRATION_DATABASE_ROLE: decodeURIComponent(parsedUrl.username),
      ATTENTION_MIGRATION_DATABASE_HOST: parsedUrl.hostname,
      ATTENTION_MIGRATION_DATABASE_NAME: decodeURIComponent(parsedUrl.pathname.slice(1)),
    });
    const query = (handle: DatabaseHandle): MigrationQuery => async (statement, parameters) =>
      handle.sql.unsafe<Record<string, unknown>[]>(
        statement,
        parameters ? [...parameters] : undefined,
      );

    let enterFirstMigration!: () => void;
    const firstMigrationStarted = new Promise<void>((resolve) => {
      enterFirstMigration = resolve;
    });
    let releaseFirstMigration!: () => void;
    const holdFirstMigration = new Promise<void>((resolve) => {
      releaseFirstMigration = resolve;
    });
    const running = runGuardedMigration(query(first), config, async () => {
      enterFirstMigration();
      await holdFirstMigration;
    });
    await firstMigrationStarted;

    await expect(
      runGuardedMigration(query(second), config, async () => undefined),
    ).rejects.toThrow("Another database migration is already running");

    releaseFirstMigration();
    await running;
    await expect(
      runGuardedMigration(query(second), config, async () => undefined),
    ).resolves.toBeUndefined();
  });
});
