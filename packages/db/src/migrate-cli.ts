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
async function ensureSignupEntitlementEnum(): Promise<void> {
  const [enumType] = await handle.sql<{ typeName: string | null }[]>`
    SELECT to_regtype('public.entitlement_source')::text AS "typeName"
  `;
  if (!enumType?.typeName) {
    // A fresh database creates the final enum shape in migration 0000.
    return;
  }

  const [signupValue] = await handle.sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_enum
      WHERE enumtypid = 'public.entitlement_source'::regtype
        AND enumlabel = 'signup'
    ) AS "exists"
  `;
  if (signupValue?.exists) {
    return;
  }

  // This statement deliberately runs outside Drizzle's migration transaction.
  await handle.sql.unsafe(
    'ALTER TYPE "public"."entitlement_source" ADD VALUE \'signup\' BEFORE \'invite\'',
  );
}

const query: MigrationQuery = async (statement, parameters) =>
  handle.sql.unsafe<Record<string, unknown>[]>(
    statement,
    parameters ? [...parameters] : undefined,
  );
try {
  await runGuardedMigration(query, config, async () => {
    await ensureSignupEntitlementEnum();
    await migrateDatabase(handle.db);
  });
} finally {
  await handle.close();
}
