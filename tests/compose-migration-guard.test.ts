import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function parseEnv(source: string): Record<string, string> {
  return Object.fromEntries(
    source
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        if (separator < 1) throw new Error(`Invalid env line: ${line}`);
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function migrateEnvironment(composeSource: string): Record<string, string> {
  const lines = composeSource.split(/\r?\n/u);
  const serviceStart = lines.findIndex((line) => line === "  migrate:");
  const environmentStart = lines.findIndex(
    (line, index) => index > serviceStart && line === "    environment:",
  );
  const entries: Array<[string, string]> = [];
  for (const line of lines.slice(environmentStart + 1)) {
    if (/^ {4}\S/u.test(line)) break;
    const match = /^ {6}([A-Z][A-Z0-9_]+):\s*(.*)$/u.exec(line);
    if (match?.[1] && match[2] !== undefined) entries.push([match[1], match[2]]);
  }
  return Object.fromEntries(entries);
}

function interpolate(expression: string, env: Record<string, string>): string {
  const match = /^\$\{([A-Z][A-Z0-9_]+)(?:(:-|:\?)(.*))?\}$/u.exec(expression);
  if (!match) return expression;
  const [, name = "", operator, operand = ""] = match;
  if (env[name]) return env[name];
  if (operator === ":-") return operand;
  throw new Error(operand || `${name} is required`);
}

describe("Compose migration guard configuration", () => {
  it("injects the staging migration role, host, and database expectations", () => {
    const root = resolve(import.meta.dirname, "..");
    const compose = readFileSync(resolve(root, "compose.yaml"), "utf8");
    const staging = parseEnv(
      readFileSync(resolve(root, "deploy/staging/compose.env.example"), "utf8"),
    );
    const resolved = Object.fromEntries(
      Object.entries(migrateEnvironment(compose)).map(([name, value]) => [
        name,
        interpolate(value, staging),
      ]),
    );

    expect(resolved).toMatchObject({
      ATTENTION_MIGRATION_DATABASE_ROLE: "attention_migration_owner",
      ATTENTION_MIGRATION_DATABASE_HOST: "postgres",
      ATTENTION_MIGRATION_DATABASE_NAME: "attention_staging",
    });
  });
});
