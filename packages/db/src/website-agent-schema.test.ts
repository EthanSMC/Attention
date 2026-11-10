import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { websiteAgentRuns } from "./schema";

describe("website agent persistent admission schema", () => {
  it("has owner-only RLS, account operation uniqueness and no prompt/credential fields", () => {
    const table = getTableConfig(websiteAgentRuns);
    const policy = table.policies.find(value => value.name === "website_agent_run_owner_access")!;
    expect(table.enableRLS).toBe(true);
    expect(policy.to).toBe("attention_web_runtime");
    expect(new PgDialect().sqlToQuery(policy.using!).sql).toContain("current_setting('app.account_id', true)");
    expect(table.indexes.find(value => value.config.name === "website_agent_operation_unique")?.config.unique).toBe(true);
    expect(table.columns.map(column => column.name)).not.toEqual(expect.arrayContaining(["prompt", "api_key", "answer", "source_body"]));
  });
});
