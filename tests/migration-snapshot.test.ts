import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

describe("Drizzle migration snapshot", () => {
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
});
