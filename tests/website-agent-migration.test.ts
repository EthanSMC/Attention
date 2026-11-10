import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("website agent migration delivery", () => {
  it("delivers the explicit least-privilege grant with the RLS migration", () => {
    const migration = readFileSync(new URL("../packages/db/drizzle/0039_website_agent_budget.sql", import.meta.url), "utf8");
    expect(migration).toContain("ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("GRANT SELECT, INSERT, UPDATE ON public.website_agent_runs TO attention_web_runtime");
    expect(migration).not.toMatch(/GRANT (?:ALL|DELETE)/u);
  });
});
