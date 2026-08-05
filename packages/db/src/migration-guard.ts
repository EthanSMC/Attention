export type MigrationEnvironment = Readonly<Record<string, string | undefined>>;

export interface MigrationConfig {
  databaseUrl: string;
  databaseName: string;
  expectedRole: string;
}

export type MigrationQueryParameter = string | number | boolean | null;
export type MigrationQuery = (
  statement: string,
  parameters?: readonly MigrationQueryParameter[],
) => Promise<readonly Record<string, unknown>[]>;

const migrationAdvisoryLockKey = 1_096_045_646;

export function loadMigrationConfig(env: MigrationEnvironment): MigrationConfig {
  const runtimeEnvironment = env.NODE_ENV?.trim().toLowerCase();
  const requiresExplicitMigrationUrl =
    runtimeEnvironment === "production" || runtimeEnvironment === "staging";
  if (requiresExplicitMigrationUrl && !env.MIGRATION_DATABASE_URL?.trim()) {
    throw new Error(
      "MIGRATION_DATABASE_URL is required for production and staging migrations",
    );
  }

  const databaseUrl = env.MIGRATION_DATABASE_URL ?? env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL is required");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(databaseUrl);
  } catch {
    throw new Error("MIGRATION_DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (parsedUrl.protocol !== "postgres:" && parsedUrl.protocol !== "postgresql:") {
    throw new Error("MIGRATION_DATABASE_URL must be a valid PostgreSQL URL");
  }

  const expectedRole =
    env.ATTENTION_MIGRATION_DATABASE_ROLE?.trim() || "attention_migration_owner";
  let username: string;
  try {
    username = decodeURIComponent(parsedUrl.username);
  } catch {
    throw new Error("MIGRATION_DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (username !== expectedRole) {
    throw new Error(
      "MIGRATION_DATABASE_URL role does not match ATTENTION_MIGRATION_DATABASE_ROLE",
    );
  }

  const expectedHost = env.ATTENTION_MIGRATION_DATABASE_HOST?.trim().toLowerCase();
  if (expectedHost && parsedUrl.hostname.toLowerCase() !== expectedHost) {
    throw new Error(
      "MIGRATION_DATABASE_URL host does not match ATTENTION_MIGRATION_DATABASE_HOST",
    );
  }

  let databaseName: string;
  try {
    databaseName = decodeURIComponent(parsedUrl.pathname.slice(1));
  } catch {
    throw new Error("MIGRATION_DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (!databaseName) {
    throw new Error("MIGRATION_DATABASE_URL must be a valid PostgreSQL URL");
  }
  const expectedDatabaseName = env.ATTENTION_MIGRATION_DATABASE_NAME?.trim();
  if (expectedDatabaseName && databaseName !== expectedDatabaseName) {
    throw new Error(
      "MIGRATION_DATABASE_URL database does not match ATTENTION_MIGRATION_DATABASE_NAME",
    );
  }

  return { databaseName, databaseUrl, expectedRole };
}

export async function runGuardedMigration(
  query: MigrationQuery,
  config: MigrationConfig,
  migrate: () => Promise<void>,
): Promise<void> {
  const [identity] = await query(`
    SELECT
      current_user::text AS current_user,
      current_database()::text AS current_database,
      current_setting('server_version_num')::text AS server_version_num
  `);
  if (identity?.current_user !== config.expectedRole) {
    throw new Error(
      "Connected PostgreSQL role does not match ATTENTION_MIGRATION_DATABASE_ROLE",
    );
  }
  if (identity.current_database !== config.databaseName) {
    throw new Error("Connected PostgreSQL database does not match MIGRATION_DATABASE_URL");
  }
  const serverVersionNumber = Number(identity.server_version_num);
  if (!Number.isInteger(serverVersionNumber) || Math.trunc(serverVersionNumber / 10_000) !== 17) {
    throw new Error("PostgreSQL major version 17 is required for migrations");
  }

  const [lock] = await query(
    "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
    [migrationAdvisoryLockKey],
  );
  if (lock?.acquired !== true) {
    throw new Error("Another database migration is already running");
  }

  try {
    await migrate();
  } finally {
    await query("SELECT pg_advisory_unlock($1::bigint) AS released", [
      migrationAdvisoryLockKey,
    ]);
  }
}
