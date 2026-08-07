import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { mcpRateLimitBuckets } from "./schema";

describe("MCP rate-limit database schema", () => {
  it("stores one shared bucket per account, credential, client, and window", () => {
    const config = getTableConfig(mcpRateLimitBuckets);
    const unique = config.indexes.find(
      (index) => index.config.name === "mcp_rate_limit_bucket_unique",
    );

    expect(unique).toMatchObject({ config: { unique: true } });
    expect(
      unique?.config.columns.map((column) =>
        "name" in column ? column.name : undefined,
      ),
    ).toEqual([
      "account_id",
      "credential_id",
      "client_key",
      "window_started_at",
    ]);
  });

  it("uses account-scoped runtime RLS and positive bucket constraints", () => {
    const config = getTableConfig(mcpRateLimitBuckets);
    const policy = config.policies.find(
      (candidate) => candidate.name === "mcp_rate_limit_bucket_owner_access",
    );
    const dialect = new PgDialect();

    expect(config.enableRLS).toBe(true);
    expect(policy).toMatchObject({
      for: "all",
      to: "attention_web_runtime",
    });
    expect(dialect.sqlToQuery(policy!.using!).sql).toContain(
      "account_id\" = NULLIF(current_setting('app.account_id', true), '')::uuid",
    );
    expect(dialect.sqlToQuery(policy!.withCheck!).sql).toContain(
      "account_id\" = NULLIF(current_setting('app.account_id', true), '')::uuid",
    );
    expect(config.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "mcp_rate_limit_request_count_positive",
        "mcp_rate_limit_client_key_not_blank",
      ]),
    );
  });
});
