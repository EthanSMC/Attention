import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { eventLedger } from "./schema";

describe("MCP contribution ledger policy", () => {
  it("permits only account-owned, public, content-bound retrieval events", () => {
    const config = getTableConfig(eventLedger);
    const policy = config.policies.find(
      (candidate) =>
        candidate.name === "event_ledger_web_mcp_retrieval_insert",
    );
    const predicate = new PgDialect().sqlToQuery(policy!.withCheck!).sql;

    expect(policy).toMatchObject({
      for: "insert",
      to: "attention_web_runtime",
    });
    expect(predicate).toContain(
      "account_id\" = NULLIF(current_setting('app.account_id', true), '')::uuid",
    );
    expect(predicate).toContain("event_type\" = 'mcp_retrieval'");
    expect(predicate).toContain("scope\" = 'public'");
    expect(predicate).toContain("content_id\" IS NOT NULL");
    expect(predicate).toContain("request_id\" IS NOT NULL");
    expect(predicate).toContain("dedupe_key\" IS NOT NULL");
    expect(predicate).toContain("FROM public_contents_current");
  });
});
