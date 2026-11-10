import { randomUUID } from "node:crypto";

import { issueSession, resolveSession, revokeSession, serializeSessionCookie } from "@attention/auth";
import { accounts, createDatabase, entitlements, eq, type DatabaseHandle } from "@attention/db";
import { migrateDatabase } from "@attention/db/migrate";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type * as QueryRoute from "../../apps/web/src/app/api/website-agent/query/route";
import type * as CloseRoute from "../../apps/web/src/app/api/website-agent/sessions/[sessionId]/close/route";
import type * as SessionRoute from "../../apps/web/src/app/api/website-agent/sessions/[sessionId]/route";
import type * as SessionsRoute from "../../apps/web/src/app/api/website-agent/sessions/route";
import type { WebsiteAgentSessionView } from "../../apps/web/src/server/website-agent-sessions";
import { assertWebsiteHttpTestDatabase, websiteHttpTestDatabaseUrls } from "./website-agent-http-guard";

const enabled = Boolean(process.env.TEST_WEBSITE_AGENT_DATABASE_URL);
const origin = "https://attention.example.test";
type Member = { accountId: string; sessionId: string; token: string; cookie: string };
type SessionBody = { session: WebsiteAgentSessionView };

/** Actual Web Request -> route -> cookie/auth -> native Pi -> PostgreSQL.
 * Only the external provider's fetch is replaced by offline protocol-valid SSE.
 * No fake principal, store, database, agent, or route implementation is injected.
 * This file deliberately never truncates or deletes application tables.
 */
describe.skipIf(!enabled)("website agent authenticated HTTP on isolated PostgreSQL", () => {
  let owner: DatabaseHandle;
  let runtime: DatabaseHandle;
  let routes: {
    sessions: typeof SessionsRoute;
    session: typeof SessionRoute;
    close: typeof CloseRoute;
    query: typeof QueryRoute;
  };
  let providerCalls: Record<string, unknown>[] = [];
  let providerAnswer = "Synthetic native answer";
  let beforeProviderResult: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const urls = websiteHttpTestDatabaseUrls(process.env);
    owner = createDatabase(urls.admin, { maxConnections: 4 });
    const [state] = await owner.sql<{
      name: string; version: string; marker: string | null; userTables: number;
    }[]>`SELECT current_database() AS name, current_setting('server_version_num') AS version,
      shobj_description(oid, 'pg_database') AS marker,
      (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid
        WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')
        AND n.nspname NOT LIKE 'pg_toast%') AS "userTables"
      FROM pg_database WHERE datname=current_database()`;
    if (!state) throw new Error("Missing isolated test database identity");
    assertWebsiteHttpTestDatabase(state, urls.name);
    await migrateDatabase(owner.db);

    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", urls.runtime);
    vi.stubEnv("ATTENTION_WEB_DATABASE_ROLE", "attention_web_runtime");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", origin);
    vi.stubEnv("ATTENTION_WEBSITE_AGENT_ENABLED", "true");
    vi.stubEnv("ATTENTION_WEBSITE_AGENT_AUDIENCE", "members");
    vi.stubEnv("ATTENTION_WEBSITE_AGENT_ACCOUNT_IDS", "");
    vi.stubEnv("ATTENTION_WEBSITE_AGENT_DAILY_COST_MICRO_USD", "unlimited");
    vi.stubEnv("ATTENTION_WEBSITE_AGENT_MAX_RUN_COST_MICRO_USD", "400000");
    vi.stubEnv("ATTENTION_WEBSITE_AGENT_DEEPSEEK_API_KEY", "offline-http-provider-key");
    vi.stubEnv("ATTENTION_WEBSITE_AGENT_SESSION_SECRET", "synthetic-http-session-encryption-secret-2026");
    vi.stubEnv("ATTENTION_HMAC_SECRET", "synthetic-http-request-hmac-secret-2026");
    vi.stubEnv("ATTENTION_AUTH_SECRET", "synthetic-http-account-auth-secret-2026");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== "https://api.deepseek.com/chat/completions") {
        throw new Error("Unexpected network request in offline HTTP acceptance");
      }
      providerCalls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      await beforeProviderResult?.();
      return new Response([
        `data: ${JSON.stringify({ id: "synthetic-http", object: "chat.completion.chunk", model: "deepseek-flash", choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "PRIVATE_REASONING", content: providerAnswer }, finish_reason: null }] })}\n\n`,
        'data: {"id":"synthetic-http","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
        "data: [DONE]\n\n",
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    }));
    const dbModule = await import("../../apps/web/src/server/db");
    runtime = dbModule.getDatabaseHandle();
    const [role] = await runtime.sql`SELECT current_user AS name, rolsuper, rolbypassrls
      FROM pg_roles WHERE rolname=current_user`;
    expect(role).toMatchObject({ name: "attention_web_runtime", rolsuper: false, rolbypassrls: false });
    routes = {
      sessions: await import("../../apps/web/src/app/api/website-agent/sessions/route"),
      session: await import("../../apps/web/src/app/api/website-agent/sessions/[sessionId]/route"),
      close: await import("../../apps/web/src/app/api/website-agent/sessions/[sessionId]/close/route"),
      query: await import("../../apps/web/src/app/api/website-agent/query/route"),
    };
  }, 120_000);

  beforeEach(() => {
    providerCalls = [];
    providerAnswer = "Synthetic native answer";
    beforeProviderResult = undefined;
  });
  afterAll(async () => {
    if (runtime) {
      await runtime.close();
      const globalDb = globalThis as typeof globalThis & { __attentionDatabaseHandle?: DatabaseHandle };
      if (globalDb.__attentionDatabaseHandle === runtime) delete globalDb.__attentionDatabaseHandle;
    }
    if (owner) await owner.close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  async function member(isMember = true): Promise<Member> {
    const accountId = randomUUID();
    await owner.db.insert(accounts).values({ id: accountId, stableHandle: `http-${accountId}`, displayName: "Synthetic HTTP member" });
    if (isMember) await owner.db.insert(entitlements).values({ accountId, source: "admin_grant", memberEnabled: true });
    const issued = await issueSession(owner.db, { accountId });
    expect(await resolveSession(runtime.db, issued.token)).toMatchObject({ accountId, sessionId: issued.sessionId, isMember });
    const serialized = serializeSessionCookie(issued.token, issued.expiresAt, { secure: true });
    expect(serialized).toContain("HttpOnly");
    expect(serialized).toContain("SameSite=Lax");
    expect(serialized).toContain("Secure");
    return { accountId, sessionId: issued.sessionId, token: issued.token, cookie: serialized.split(";")[0]! };
  }
  function request(path: string, actor?: Member, body?: Record<string, unknown>, extra: Record<string, string> = {}): Request {
    return new Request(origin + "/api/website-agent" + path, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json", origin, "sec-fetch-site": "same-origin", ...(actor ? { cookie: actor.cookie } : {}), ...extra },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  async function create(actor: Member): Promise<WebsiteAgentSessionView> {
    const response = await routes.sessions.POST(request("/sessions", actor, {}));
    expect(response.status).toBe(201);
    return ((await response.json()) as SessionBody).session;
  }
  function load(actor: Member, id: string): Promise<Response> {
    return routes.session.GET(request(`/sessions/${id}`, actor), { params: Promise.resolve({ sessionId: id }) });
  }
  function close(actor: Member, view: WebsiteAgentSessionView): Promise<Response> {
    return routes.close.POST(request(`/sessions/${view.id}/close`, actor, { expected_revision: view.revision }), { params: Promise.resolve({ sessionId: view.id }) });
  }
  function query(actor: Member, view: WebsiteAgentSessionView, prompt = "Synthetic prompt"): Promise<Response> {
    return routes.query.POST(request("/query", actor, { query: prompt, session_id: view.id, expected_revision: view.revision, operation_id: randomUUID(), data_consent: true }));
  }
  async function expectError(response: Response, status: number, code: string): Promise<void> {
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({ error: { code } });
    expect(body).not.toHaveProperty("answer");
    expect(body).not.toHaveProperty("session");
  }

  it("rejects anonymous, forged cookies and bearer-only credentials without invoking the provider", async () => {
    const actor = await member();
    for (const headers of [{}, { cookie: "__Host-attention_session=malformed" }, { cookie: `__Host-attention_session=${"x".repeat(43)}` }, { authorization: `Bearer ${actor.token}` }]) {
      const read = await routes.sessions.GET(request("/sessions", undefined, undefined, headers));
      const cookie = read.headers.get("set-cookie");
      await expectError(read, 401, "authentication_required");
      if (headers.cookie) expect(cookie).toContain("Max-Age=0");
      await expectError(await routes.sessions.POST(request("/sessions", undefined, {}, headers)), 401, "authentication_required");
      await expectError(await routes.query.POST(request("/query", undefined, {}, headers)), 401, "authentication_required");
    }
    expect(providerCalls).toHaveLength(0);
  });

  it("rejects cross-origin mutation and non-Members before creating a run", async () => {
    const actor = await member();
    for (const headers of [{ origin: "https://evil.example.test" }, { "sec-fetch-site": "cross-site" }]) {
      await expectError(await routes.sessions.POST(request("/sessions", actor, {}, headers)), 400, "cross_origin_request");
      await expectError(await routes.query.POST(request("/query", actor, {}, headers)), 400, "cross_origin_request");
      const id = randomUUID();
      await expectError(await routes.close.POST(request(`/sessions/${id}/close`, actor, { expected_revision: 0 }, headers),
        { params: Promise.resolve({ sessionId: id }) }), 400, "cross_origin_request");
    }
    const free = await member(false);
    await expectError(await routes.sessions.POST(request("/sessions", free, {})), 403, "membership_required");
    expect((await owner.sql`SELECT count(*)::int AS n FROM website_agent_runs WHERE account_id=${actor.accountId}`)[0]?.n).toBe(0);
    expect(providerCalls).toHaveLength(0);
  });

  it("creates, queries, resumes, lists and closes native sessions for two real synthetic Members", async () => {
    const a = await member(), b = await member();
    let av = await create(a);
    const bv = await create(b);
    const response = await query(a, av, "First synthetic question");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const first = await response.json() as SessionBody & { answer: string; runtime: string };
    expect(first).toMatchObject({ answer: providerAnswer, runtime: "pi-agent-core" });
    expect(JSON.stringify(first)).not.toMatch(/PRIVATE_REASONING|offline-http-provider-key|encrypted_state|nativeSession/);
    expect(JSON.stringify(first)).not.toContain(a.token);
    expect(first.session.messages).toEqual([{ role: "user", text: "First synthetic question" }, { role: "assistant", text: providerAnswer }]);
    av = ((await (await load(a, av.id)).json()) as SessionBody).session;
    providerAnswer = "Second synthetic answer";
    const second = await query(a, av, "Second synthetic question");
    expect(second.status).toBe(200);
    av = ((await second.json()) as SessionBody).session;
    expect(av.messages).toHaveLength(4);
    expect(JSON.stringify(providerCalls[1])).toContain("First synthetic question");
    expect(JSON.stringify(providerCalls[1])).toContain("Synthetic native answer");
    expect(providerCalls[0]).toMatchObject({ model: "deepseek-flash", thinking: { type: "disabled" } });
    const bResponse = await query(b, bv, "Different owner question");
    expect(bResponse.status).toBe(200);
    expect(JSON.stringify(providerCalls[2])).not.toContain("First synthetic question");
    const aList = await (await routes.sessions.GET(request("/sessions", a))).json() as { sessions: WebsiteAgentSessionView[] };
    const bList = await (await routes.sessions.GET(request("/sessions", b))).json() as { sessions: WebsiteAgentSessionView[] };
    expect(aList.sessions.map(x => x.id)).toEqual([av.id]);
    expect(bList.sessions.map(x => x.id)).toEqual([bv.id]);
    await expectError(await load(b, av.id), 404, "session_not_found");
    await expectError(await close(b, av), 404, "session_not_found");
    await expectError(await query(b, av), 404, "session_not_found");
    const foreignRows = await runtime.sql.begin(async tx => {
      await tx`SELECT set_config('app.account_id',${b.accountId},true)`;
      return tx`SELECT id FROM website_agent_sessions WHERE id=${av.id}`;
    });
    expect(foreignRows).toHaveLength(0);
    const closed = await close(a, av);
    expect(closed.status).toBe(200);
    av = ((await closed.json()) as SessionBody).session;
    expect(av.status).toBe("closed");
    await expectError(await query(a, av), 409, "session_closed");
    expect(providerCalls).toHaveLength(3);
  }, 30_000);

  it.each(["session", "membership"] as const)("withholds final provider output after real %s revocation", async boundary => {
    const actor = await member();
    const view = await create(actor);
    beforeProviderResult = async () => {
      if (boundary === "session") await revokeSession(owner.db, actor.token);
      else await owner.db.update(entitlements).set({ memberEnabled: false }).where(eq(entitlements.accountId, actor.accountId));
    };
    await expectError(await query(actor, view), 502, "permission_revoked");
    const [run] = await owner.sql`SELECT outcome,reserved_cost_microusd FROM website_agent_runs WHERE account_id=${actor.accountId}`;
    expect(run).toMatchObject({ outcome: "failed", reserved_cost_microusd: 400000 });
    const revoked = await load(actor, view.id);
    await expectError(revoked, boundary === "session" ? 401 : 403, boundary === "session" ? "authentication_required" : "membership_required");
  }, 30_000);

  async function revokeOnPersistence(actor: Member, mode: "create" | "finish"): Promise<void> {
    // Test-only fixture in the guarded dedicated database. A real DB transaction
    // changes real auth state before the handler returns; no principal is mocked.
    const name = `http_revoke_${randomUUID().replaceAll("-", "")}`;
    const condition = mode === "create" ? "true" : "OLD.active_run_id IS NOT NULL AND NEW.active_run_id IS NULL";
    await owner.sql.unsafe(`CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql
      SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
        IF NEW.account_id='${actor.accountId}'::uuid AND (${condition}) THEN
          UPDATE public.sessions SET revoked_at=clock_timestamp() WHERE id='${actor.sessionId}'::uuid;
        END IF; RETURN NEW; END $$;
      REVOKE ALL ON FUNCTION public.${name}() FROM PUBLIC;
      CREATE TRIGGER ${name} AFTER ${mode === "create" ? "INSERT" : "UPDATE"} ON public.website_agent_sessions
        FOR EACH ROW EXECUTE FUNCTION public.${name}();`);
  }

  it("rechecks real auth before returning session metadata created during revocation", async () => {
    const actor = await member();
    await revokeOnPersistence(actor, "create");
    const response = await routes.sessions.POST(request("/sessions", actor, {}));
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    await expectError(response, 401, "authentication_required");
    expect((await owner.sql`SELECT count(*)::int AS n FROM website_agent_sessions WHERE account_id=${actor.accountId}`)[0]?.n).toBe(1);
  });

  it("withholds a saved answer if real auth is revoked during the final persistence transaction", async () => {
    const actor = await member();
    const view = await create(actor);
    await revokeOnPersistence(actor, "finish");
    await expectError(await query(actor, view), 502, "permission_revoked");
    const [run] = await owner.sql`SELECT outcome,reserved_cost_microusd FROM website_agent_runs WHERE account_id=${actor.accountId}`;
    expect(run).toMatchObject({ outcome: "completed", reserved_cost_microusd: 400000 });
    const [stored] = await owner.sql`SELECT revision,active_run_id FROM website_agent_sessions WHERE id=${view.id}`;
    expect(stored).toMatchObject({ revision: 2, active_run_id: null });
    await expectError(await load(actor, view.id), 401, "authentication_required");
  }, 30_000);
});
