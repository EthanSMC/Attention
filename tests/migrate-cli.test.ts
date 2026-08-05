import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("migration CLI", () => {
  it("fails before connecting when production only has the runtime DSN", () => {
    const password = "runtime-password-must-not-be-printed";
    const env = {
      ...process.env,
      NODE_ENV: "production",
      DATABASE_URL: `postgresql://attention_web_runtime:${password}@postgres/attention`,
    };
    delete env.MIGRATION_DATABASE_URL;
    const root = resolve(import.meta.dirname, "..");
    const result = spawnSync(
      process.execPath,
      [
        resolve(root, "packages/db/node_modules/tsx/dist/cli.mjs"),
        resolve(root, "packages/db/src/migrate-cli.ts"),
      ],
      { encoding: "utf8", env },
    );
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain(
      "MIGRATION_DATABASE_URL is required for production and staging migrations",
    );
    expect(output).not.toContain(password);
    expect(output).not.toContain(env.DATABASE_URL);
  });
});
