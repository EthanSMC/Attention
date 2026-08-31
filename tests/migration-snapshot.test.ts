import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import * as schema from "../packages/db/src/schema";

describe("Drizzle migration snapshot", () => {
  it("grants the web runtime only the audit permissions the admin API needs", () => {
    const root = resolve(import.meta.dirname, "..");
    const migration = readFileSync(
      resolve(root, "packages/db/drizzle/0037_admin_entitlement_audits.sql"),
      "utf8",
    );

    expect(migration).toContain(
      'GRANT SELECT, INSERT ON TABLE "admin_entitlement_audits" TO "attention_web_runtime";',
    );
    expect(migration).not.toMatch(
      /GRANT[^;]*(?:UPDATE|DELETE)[^;]*admin_entitlement_audits/iu,
    );
    expect(migration).not.toMatch(
      /GRANT[^;]*admin_entitlement_audits[^;]*attention_worker_runtime/iu,
    );
  });

  it("registers the data-only local enrichment repair migration", () => {
    const root = resolve(import.meta.dirname, "..");
    const migrationPath = resolve(
      root,
      "packages/db/drizzle/0032_local_agent_enrichment_repair.sql",
    );
    const journal = JSON.parse(
      readFileSync(resolve(root, "packages/db/drizzle/meta/_journal.json"), "utf8"),
    ) as { entries: { tag: string }[] };

    expect(existsSync(migrationPath)).toBe(true);
    expect(journal.entries.some((entry) =>
      entry.tag === "0033_owned_content_alias_function"
    )).toBe(true);
    if (!existsSync(migrationPath)) return;
    const migration = readFileSync(migrationPath, "utf8");
    expect(migration).toContain('"summary_status" = \'unavailable\'');
    expect(migration).toContain('"enrichment_status" = \'partial\'');
    expect(migration).toContain(
      '"summary_job"."task_type" = \'content.summary.v1\'',
    );
    expect(migration).toContain('"summary_job"."status" = \'completed\'');
    expect(migration).toContain('"summary_job"."completed_at" IS NOT NULL');
    expect(migration).toContain('"summary_job"."last_error_code" IS NULL');
    expect(migration).toContain(
      "'content.summary.v1:' || \"content\".\"id\"::text",
    );
    expect(migration).toContain(
      '"summary_job"."payload" ->> \'contentId\' = "content"."id"::text',
    );
    expect(migration).not.toContain('"summary_status" IN');
    expect(migration).not.toContain("'failed'");
    expect(migration).not.toMatch(/INSERT\s+INTO\s+"?jobs"?/iu);
  });

  it("registers account-private summary notification policies", () => {
    const root = resolve(import.meta.dirname, "..");
    const migrationPath = resolve(
      root,
      "packages/db/drizzle/0034_summary_ready_notifications.sql",
    );
    const journal = JSON.parse(
      readFileSync(resolve(root, "packages/db/drizzle/meta/_journal.json"), "utf8"),
    ) as { entries: { tag: string }[] };

    expect(journal.entries.some((entry) =>
      entry.tag === "0034_summary_ready_notifications"
    )).toBe(true);
    const migration = readFileSync(migrationPath, "utf8");
    expect(migration).toContain("event_ledger_web_summary_ready_read");
    expect(migration).toContain("event_ledger_web_summary_ready_insert");
    expect(migration).toContain("event_ledger_worker_summary_ready_insert");
    expect(migration).toContain("summary_collection.source_channel = 'wechat'");
    expect(migration).toContain(
      "summary_collection.collected_at <= \"event_ledger\".\"occurred_at\"",
    );
  });

  it("exposes only the constrained owned-alias function to Web runtime", () => {
    const root = resolve(import.meta.dirname, "..");
    const migration = readFileSync(
      resolve(
        root,
        "packages/db/drizzle/0033_owned_content_alias_function.sql",
      ),
      "utf8",
    );

    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("SET search_path = pg_catalog, public");
    expect(migration).toContain("current_setting('app.account_id', true)");
    expect(migration).toContain("alias_collection.account_id = v_account_id");
    expect(migration).toContain("primary_collection.account_id = v_account_id");
    expect(migration).toContain("alias_content.public_safety_status = 'allowed'");
    expect(migration).toContain("primary_content.public_safety_status = 'allowed'");
    expect(migration).toContain("REVOKE ALL ON FUNCTION");
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION public.attention_link_owned_content_alias(uuid, uuid, text) TO attention_web_runtime",
    );
    expect(migration).not.toMatch(
      /GRANT\s+(?:INSERT|UPDATE|DELETE)[^;]*content_aliases[^;]*attention_web_runtime/iu,
    );
  });

  it("enforces one active Runtime connection per trusted installation", () => {
    const root = resolve(import.meta.dirname, "..");
    const migrationPath = resolve(
      root,
      "packages/db/drizzle/0031_runtime_oauth_connection_lifecycle.sql",
    );

    expect(existsSync(migrationPath)).toBe(true);
    if (!existsSync(migrationPath)) return;
    const migration = readFileSync(migrationPath, "utf8");

    expect(migration).toContain(
      "oauth_connections_active_runtime_installation_unique",
    );
    expect(migration).toContain('"installation_key_hash" IS NOT NULL');
    expect(migration).toContain('"audience" = \'attention-channel-runtime\'');
    expect(migration).toContain('"kind" = \'runtime\'');
    expect(migration).toContain('"revoked_at" IS NULL');
    expect(migration).toContain(
      "oauth_authorization_codes_connection_intent_check",
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE "oauth_connections" TO "attention_web_runtime"',
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE "oauth_authorization_codes" TO "attention_web_runtime"',
    );
    expect(migration).not.toContain('ALTER COLUMN "installation_key_hash" SET NOT NULL');
    expect(migration).not.toContain('ALTER COLUMN "connection_id" SET NOT NULL');
  });

  it("persists unambiguous pending OAuth connection intent", () => {
    const root = resolve(import.meta.dirname, "..");
    const migration = readFileSync(
      resolve(root, "packages/db/drizzle/0029_oauth_authorization_connection_intent.sql"),
      "utf8",
    );

    expect(schema.oauthAuthorizationCodes.connectionLabel).toBeDefined();
    expect(schema.oauthAuthorizationCodes.normalizedConnectionLabel).toBeDefined();
    expect(schema.oauthAuthorizationCodes.replacementConnectionId).toBeDefined();
    expect(migration).toContain("oauth_authorization_codes_connection_intent_check");
    expect(migration).toContain("replacement_connection_id_oauth_connections_id_fk");
    expect(migration).not.toContain('ALTER COLUMN "connection_id" SET NOT NULL');
  });

  it("persists OAuth connection identity and active-name uniqueness", () => {
    const root = resolve(import.meta.dirname, "..");
    const migration = readFileSync(
      resolve(root, "packages/db/drizzle/0028_oauth_connection_identity.sql"),
      "utf8",
    );

    expect(schema.oauthConnections).toBeDefined();
    expect(schema.oauthAuthorizationCodes.connectionId).toBeDefined();
    expect(schema.oauthAccessTokens.connectionId).toBeDefined();
    expect(schema.oauthRefreshTokens.connectionId).toBeDefined();
    expect(migration).toContain("oauth_connections_active_name_unique");
    expect(migration).toContain('WHERE "revoked_at" IS NULL');
  });

  it("grants the web runtime access to OAuth connections", () => {
    const root = resolve(import.meta.dirname, "..");
    const migration = readFileSync(
      resolve(root, "packages/db/drizzle/0028_oauth_connection_identity.sql"),
      "utf8",
    );

    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE "oauth_connections" TO "attention_web_runtime"',
    );
  });

  it("keeps OAuth connection links nullable during rollout", () => {
    const root = resolve(import.meta.dirname, "..");
    const migration = readFileSync(
      resolve(root, "packages/db/drizzle/0028_oauth_connection_identity.sql"),
      "utf8",
    );

    expect(schema.oauthAuthorizationCodes.connectionId.notNull).toBe(false);
    expect(schema.oauthAccessTokens.connectionId.notNull).toBe(false);
    expect(schema.oauthRefreshTokens.connectionId.notNull).toBe(false);
    expect(migration).not.toContain('ALTER COLUMN "connection_id" SET NOT NULL');
  });

  it("gives every historical OAuth connection a globally ranked import label", () => {
    const root = resolve(import.meta.dirname, "..");
    const migration = readFileSync(
      resolve(root, "packages/db/drizzle/0028_oauth_connection_identity.sql"),
      "utf8",
    );

    expect(migration).toContain('AS "import_rank"');
    expect(migration).toContain("'Imported connection '");
    expect(migration).toContain("'imported connection '");
    expect(migration).toContain('LPAD("import_rank"::text, 20, \'0\')');
    expect(migration).not.toContain('LEFT("client_id", 8)');
    expect(migration).not.toContain("TO_CHAR(");
  });

  it("avoids SQL Unicode semantics in historical OAuth connection labels", () => {
    const root = resolve(import.meta.dirname, "..");
    const migration = readFileSync(
      resolve(root, "packages/db/drizzle/0028_oauth_connection_identity.sql"),
      "utf8",
    );

    expect(migration).not.toContain("NORMALIZE(");
    expect(migration).not.toContain("REGEXP_REPLACE(");
    expect(migration).not.toContain('"oauth_clients"."name"');
  });

  it("produces no migration when the checked-in schema is unchanged", () => {
    const root = resolve(import.meta.dirname, "..");
    const probe = mkdtempSync(resolve(tmpdir(), "attention-migration-snapshot-"));
    const probeMigrations = resolve(probe, "drizzle");
    cpSync(resolve(root, "packages/db/drizzle"), probeMigrations, { recursive: true });
    const before = readdirSync(probeMigrations).filter((name) => name.endsWith(".sql"));

    try {
      const generated = spawnSync(
        resolve(root, "packages/db/node_modules/.bin/drizzle-kit"),
        [
          "generate",
          "--dialect",
          "postgresql",
          "--schema",
          resolve(root, "packages/db/src/schema.ts"),
          "--out",
          `${basename(probe)}/drizzle`,
          "--name",
          "schema_drift_probe",
        ],
        {
          cwd: tmpdir(),
          encoding: "utf8",
          env: process.env,
        },
      );
      expect(generated.status, `${generated.stdout}\n${generated.stderr}`).toBe(0);

      const after = readdirSync(probeMigrations).filter((name) => name.endsWith(".sql"));
      expect(after).toEqual(before);
      expect(`${generated.stdout}${generated.stderr}`).toContain(
        "No schema changes, nothing to migrate",
      );
    } finally {
      rmSync(probe, { force: true, recursive: true });
    }
  });

  it("commits the new enum before backfilling registration Member entitlements", () => {
    const root = resolve(import.meta.dirname, "..");
    const initialMigration = readFileSync(
      resolve(root, "packages/db/drizzle/0000_attention_web_core.sql"),
      "utf8",
    );
    const enumMigration = readFileSync(
      resolve(root, "packages/db/drizzle/0023_melted_johnny_blaze.sql"),
      "utf8",
    );
    const backfillMigration = readFileSync(
      resolve(root, "packages/db/drizzle/0024_signup_entitlement_backfill.sql"),
      "utf8",
    );
    expect(initialMigration).toContain(
      'CREATE TYPE "public"."entitlement_source" AS ENUM(\'signup\', \'invite\'',
    );
    expect(enumMigration).not.toContain("ADD VALUE 'signup'");
    expect(enumMigration).not.toContain("INSERT INTO");
    expect(backfillMigration).toContain("WHERE \"accounts\".\"status\" = 'active'");
    expect(backfillMigration).toContain(
      "ON CONFLICT (\"account_id\", \"source\") DO NOTHING",
    );
  });

  it("repairs Xiaohongshu access URLs without making tracking part of identity", () => {
    const root = resolve(import.meta.dirname, "..");
    const repairMigration = readFileSync(
      resolve(root, "packages/db/drizzle/0027_xiaohongshu_outbound_repair.sql"),
      "utf8",
    );

    expect(repairMigration).toContain('"contents"."normalized_url"');
    expect(repairMigration).toContain("xsec_source");
    expect(repairMigration).toContain("xsec_token");
    expect(repairMigration).toContain("content.metadata.v1:");
    expect(repairMigration).toContain("content.summary.v1:");
    expect(repairMigration).toContain("小红书 - 你访问的页面不见了");
    expect(repairMigration).not.toContain("app_platform");
    expect(repairMigration).not.toContain("shareRedId");
  });
});
