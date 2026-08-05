import { describe, expect, it } from "vitest";

import {
  loadMigrationConfig,
  runGuardedMigration,
  type MigrationConfig,
  type MigrationQuery,
} from "./migration-guard";

describe("loadMigrationConfig", () => {
  it("requires MIGRATION_DATABASE_URL in production even when DATABASE_URL exists", () => {
    expect(() =>
      loadMigrationConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://attention_web_runtime:runtime-secret@localhost/attention",
      }),
    ).toThrow("MIGRATION_DATABASE_URL is required for production and staging migrations");
  });

  it("requires MIGRATION_DATABASE_URL when NODE_ENV identifies staging", () => {
    expect(() =>
      loadMigrationConfig({
        NODE_ENV: "staging",
        DATABASE_URL: "postgresql://attention_web_runtime:runtime-secret@postgres/attention_staging",
      }),
    ).toThrow("MIGRATION_DATABASE_URL is required for production and staging migrations");
  });

  it("rejects a non-PostgreSQL migration URL", () => {
    expect(() =>
      loadMigrationConfig({
        MIGRATION_DATABASE_URL:
          "https://attention_migration_owner:do-not-print-this@postgres/attention",
      }),
    ).toThrow("MIGRATION_DATABASE_URL must be a valid PostgreSQL URL");
  });

  it("requires the migration owner role by default", () => {
    expect(() =>
      loadMigrationConfig({
        MIGRATION_DATABASE_URL:
          "postgresql://attention_web_runtime:do-not-print-this@postgres/attention",
      }),
    ).toThrow("MIGRATION_DATABASE_URL role does not match ATTENTION_MIGRATION_DATABASE_ROLE");
  });

  it("rejects a migration URL targeting a different configured host", () => {
    expect(() =>
      loadMigrationConfig({
        MIGRATION_DATABASE_URL:
          "postgresql://attention_migration_owner:do-not-print-this@external-db/attention",
        ATTENTION_MIGRATION_DATABASE_HOST: "postgres",
      }),
    ).toThrow("MIGRATION_DATABASE_URL host does not match ATTENTION_MIGRATION_DATABASE_HOST");
  });

  it("rejects a migration URL targeting a different configured database", () => {
    expect(() =>
      loadMigrationConfig({
        MIGRATION_DATABASE_URL:
          "postgresql://attention_migration_owner:do-not-print-this@postgres/attention",
        ATTENTION_MIGRATION_DATABASE_NAME: "attention_staging",
      }),
    ).toThrow("MIGRATION_DATABASE_URL database does not match ATTENTION_MIGRATION_DATABASE_NAME");
  });

  it("accepts a custom expected role and matching host and database", () => {
    expect(
      loadMigrationConfig({
        NODE_ENV: "production",
        MIGRATION_DATABASE_URL: "postgresql://release_owner:secret@postgres/release_database",
        ATTENTION_MIGRATION_DATABASE_ROLE: "release_owner",
        ATTENTION_MIGRATION_DATABASE_HOST: "postgres",
        ATTENTION_MIGRATION_DATABASE_NAME: "release_database",
      }),
    ).toEqual({
      databaseName: "release_database",
      databaseUrl: "postgresql://release_owner:secret@postgres/release_database",
      expectedRole: "release_owner",
    });
  });

  it("allows DATABASE_URL fallback only for local development", () => {
    expect(
      loadMigrationConfig({
        NODE_ENV: "development",
        DATABASE_URL: "postgresql://attention_migration_owner@localhost/attention_dev",
      }).databaseName,
    ).toBe("attention_dev");
  });

  it("never includes the database password in validation errors", () => {
    const password = "super-secret-migration-password";
    let message = "";
    try {
      loadMigrationConfig({
        MIGRATION_DATABASE_URL: `postgresql://wrong_role:${password}@external/attention`,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toContain(password);
    expect(message).not.toContain("postgresql://");
  });
});

const migrationConfig: MigrationConfig = {
  databaseName: "attention_staging",
  databaseUrl:
    "postgresql://attention_migration_owner:do-not-print-this@postgres/attention_staging",
  expectedRole: "attention_migration_owner",
};

describe("runGuardedMigration", () => {
  it("rejects a connection authenticated as a different PostgreSQL role", async () => {
    const query: MigrationQuery = async () => [
      {
        current_user: "attention_web_runtime",
        current_database: "attention_staging",
        server_version_num: "170006",
      },
    ];

    await expect(runGuardedMigration(query, migrationConfig, async () => undefined)).rejects.toThrow(
      "Connected PostgreSQL role does not match ATTENTION_MIGRATION_DATABASE_ROLE",
    );
  });

  it("rejects a connection redirected to a different database", async () => {
    const query: MigrationQuery = async () => [
      {
        current_user: "attention_migration_owner",
        current_database: "postgres",
        server_version_num: "170006",
      },
    ];

    await expect(runGuardedMigration(query, migrationConfig, async () => undefined)).rejects.toThrow(
      "Connected PostgreSQL database does not match MIGRATION_DATABASE_URL",
    );
  });

  it("rejects a PostgreSQL server outside major version 17", async () => {
    const query: MigrationQuery = async () => [
      {
        current_user: "attention_migration_owner",
        current_database: "attention_staging",
        server_version_num: "160010",
      },
    ];

    await expect(runGuardedMigration(query, migrationConfig, async () => undefined)).rejects.toThrow(
      "PostgreSQL major version 17 is required for migrations",
    );
  });

  it("fails immediately when another migrator holds the advisory lock", async () => {
    let migrated = false;
    const query: MigrationQuery = async (statement) => {
      if (statement.includes("pg_try_advisory_lock")) {
        return [{ acquired: false }];
      }
      return [
        {
          current_user: "attention_migration_owner",
          current_database: "attention_staging",
          server_version_num: "170006",
        },
      ];
    };

    await expect(
      runGuardedMigration(query, migrationConfig, async () => {
        migrated = true;
      }),
    ).rejects.toThrow("Another database migration is already running");
    expect(migrated).toBe(false);
  });

  it("runs the migration while holding one fixed lock and releases it after success", async () => {
    const events: string[] = [];
    let acquiredParameters: readonly unknown[] | undefined;
    let releasedParameters: readonly unknown[] | undefined;
    const query: MigrationQuery = async (statement, parameters) => {
      if (statement.includes("pg_try_advisory_lock")) {
        events.push("lock");
        acquiredParameters = parameters;
        return [{ acquired: true }];
      }
      if (statement.includes("pg_advisory_unlock")) {
        events.push("unlock");
        releasedParameters = parameters;
        return [{ released: true }];
      }
      events.push("identity");
      return [
        {
          current_user: "attention_migration_owner",
          current_database: "attention_staging",
          server_version_num: "170006",
        },
      ];
    };

    await runGuardedMigration(query, migrationConfig, async () => {
      events.push("migrate");
    });

    expect(events).toEqual(["identity", "lock", "migrate", "unlock"]);
    expect(releasedParameters).toEqual(acquiredParameters);
  });

  it("releases the advisory lock when the migration fails", async () => {
    const events: string[] = [];
    const query: MigrationQuery = async (statement) => {
      if (statement.includes("pg_try_advisory_lock")) return [{ acquired: true }];
      if (statement.includes("pg_advisory_unlock")) {
        events.push("unlock");
        return [{ released: true }];
      }
      return [
        {
          current_user: "attention_migration_owner",
          current_database: "attention_staging",
          server_version_num: "170006",
        },
      ];
    };

    await expect(
      runGuardedMigration(query, migrationConfig, async () => {
        events.push("migrate");
        throw new Error("migration failed");
      }),
    ).rejects.toThrow("migration failed");
    expect(events).toEqual(["migrate", "unlock"]);
  });
});
