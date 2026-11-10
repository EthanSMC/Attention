import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(new URL(`../packages/db/drizzle/${name}`, import.meta.url), "utf8");
describe("native website session migration delivery", () => {
  it("grants only owner-scoped, non-destructive website session access", () => {
    const migration = read("0040_website_agent_sessions.sql");
    expect(migration).toContain('ALTER TABLE "website_agent_sessions" ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('CREATE POLICY "website_agent_session_owner_access"');
    expect(migration).toContain("WITH CHECK");
    expect(migration).toContain("current_setting('app.account_id', true)");
    expect(migration).toContain("GRANT SELECT, INSERT, UPDATE ON public.website_agent_sessions TO attention_web_runtime");
    expect(migration).not.toMatch(/GRANT (?:ALL|DELETE)|TO attention_worker_runtime/u);
  });
  it("keeps historical admissions nullable and binds all new session runs to their owner", () => {
    const migration = read("0040_website_agent_sessions.sql");
    expect(migration).toContain('ADD COLUMN "session_id" uuid;');
    expect(migration).toContain('FOREIGN KEY ("account_id","session_id") REFERENCES "public"."website_agent_sessions"("account_id","id")');
    expect(migration).toContain('UNIQUE("account_id","id")');
    expect(migration).not.toMatch(/DROP |TRUNCATE |DELETE FROM|UPDATE "website_agent_runs"/u);
  });
  it("bounds native encrypted storage without rewriting or trimming native history", () => {
    const migration = read("0040_website_agent_sessions.sql");
    expect(migration).toContain('"encrypted_state" text NOT NULL');
    expect(migration).toContain("BETWEEN 50 AND 1048576");
    expect(migration).toContain('"revision" integer DEFAULT 0 NOT NULL');
    expect(migration).toContain('"active_run_deadline" timestamp with time zone');
    expect(migration).toContain('"expires_at" timestamp with time zone NOT NULL');
    const journal = JSON.parse(read("meta/_journal.json")) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.find(entry => entry.idx === 40)?.tag).toBe("0040_website_agent_sessions");
  });
  it("keeps the generated snapshot linked and changes no unrelated table", () => {
    const previous = JSON.parse(read("meta/0039_snapshot.json")) as { id: string; tables: Record<string, unknown> };
    const current = JSON.parse(read("meta/0040_snapshot.json")) as { prevId: string; tables: Record<string, unknown> };
    expect(current.prevId).toBe(previous.id);
    for (const [name, table] of Object.entries(previous.tables)) {
      if (name !== "public.website_agent_runs") expect(current.tables[name]).toEqual(table);
    }
    expect(Object.keys(current.tables)).toHaveLength(Object.keys(previous.tables).length + 1);
    expect(current.tables["public.website_agent_sessions"]).toMatchObject({ isRLSEnabled: true,
      uniqueConstraints: { website_agent_session_owner_unique: { columns: ["account_id", "id"] } },
      policies: { website_agent_session_owner_access: { for: "ALL", to: ["attention_web_runtime"] } } });
    expect(current.tables["public.website_agent_runs"]).toMatchObject({
      columns: { session_id: { type: "uuid", notNull: false } },
      foreignKeys: { website_agent_run_session_owner_fk: { columnsFrom: ["account_id", "session_id"],
        tableTo: "website_agent_sessions", columnsTo: ["account_id", "id"] } } });
  });
});
