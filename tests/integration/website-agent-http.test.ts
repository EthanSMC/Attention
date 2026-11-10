import { randomUUID } from "node:crypto";

import { issueSession, resolveSession, revokeSession, serializeSessionCookie } from "@attention/auth";
import { accountDigestPreferences, accounts, collections, contents, createDatabase, domains, entitlements, eq,
  filterProfiles, type DatabaseHandle } from "@attention/db";
import { migrateDatabase } from "@attention/db/migrate";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { decryptCandidateSet } from "../../apps/web/src/server/candidate-vault";
import type * as QueryRoute from "../../apps/web/src/app/api/website-agent/query/route";
import type * as CloseRoute from "../../apps/web/src/app/api/website-agent/sessions/[sessionId]/close/route";
import type * as SessionRoute from "../../apps/web/src/app/api/website-agent/sessions/[sessionId]/route";
import type * as SessionsRoute from "../../apps/web/src/app/api/website-agent/sessions/route";
import type * as ApproveRoute from "../../apps/web/src/app/api/website-agent/sessions/[sessionId]/actions/[actionId]/approve/route";
import type * as SelectRoute from "../../apps/web/src/app/api/website-agent/sessions/[sessionId]/actions/[actionId]/select/route";
import { registerCollectionReviewCoreCases } from "./collection-review-pg-cases";
import type * as DeclineRoute from "../../apps/web/src/app/api/website-agent/sessions/[sessionId]/actions/[actionId]/decline/route";
import type { AttentionToolName } from "../../apps/web/src/server/attention-tool-registry";
import type { WebsiteAgentReviewedToolName } from "../../apps/web/src/server/website-agent-action-policy";
import { claimWebsiteAgentAction, decryptWebsiteAgentSessionState, encryptWebsiteAgentSessionState,
  type WebsiteAgentSessionState, type WebsiteAgentSessionView } from "../../apps/web/src/server/website-agent-sessions";
import { assertWebsiteHttpTestDatabase, websiteHttpTestDatabaseUrls } from "./website-agent-http-guard";

const enabled = Boolean(process.env.TEST_WEBSITE_AGENT_DATABASE_URL);
const origin = "https://attention.example.test";
type Member = { accountId: string; sessionId: string; token: string; cookie: string };
type SessionBody = { session: WebsiteAgentSessionView };
type ActionView = NonNullable<WebsiteAgentSessionView["actions"]>[number];
type ProviderStep = { tool: { name: AttentionToolName; arguments: Record<string, unknown> } } | { answer: string };

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
    approve: typeof ApproveRoute;
    decline: typeof DeclineRoute;
    select: typeof SelectRoute;
  };
  let sourceFinalOverride: string | undefined;
  let sourceReadCount = 0;
  let sourceReadBlocked = false;
  let providerCalls: Record<string, unknown>[] = [];
  let providerAnswer = "Synthetic native answer";
  let beforeProviderResult: (() => Promise<void>) | undefined;
  let providerSteps: ProviderStep[] = [];

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
    // Observe real Core writes, including rollback, without replacing business logic.
    // The guard above has established a new, marked, disposable database first.
    await owner.sql.unsafe(`CREATE TABLE public.website_http_action_effects (
        account_id uuid NOT NULL, operation text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT clock_timestamp());
      CREATE FUNCTION public.website_http_record_digest_effect() RETURNS trigger LANGUAGE plpgsql
        SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
          INSERT INTO public.website_http_action_effects(account_id,operation) VALUES(NEW.account_id,TG_OP);
          RETURN NEW; END $$;
      REVOKE ALL ON FUNCTION public.website_http_record_digest_effect() FROM PUBLIC;
      CREATE TRIGGER website_http_record_digest_effect AFTER INSERT OR UPDATE ON public.account_digest_preferences
        FOR EACH ROW EXECUTE FUNCTION public.website_http_record_digest_effect();`);

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
    vi.stubEnv("FETCHER_BASE_URL", "https://fetcher.example.test");
    vi.stubEnv("FETCHER_SHARED_SECRET", "synthetic-http-fetcher-secret-2026-long");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://fetcher.example.test/v1/read") {
        sourceReadCount += 1;
        const payload = JSON.parse(String(init?.body));
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-http-fetcher-secret-2026-long");
        return Response.json({ schema_version: 1, request_ref: payload.request_ref, attempt_ref: payload.attempt_ref,
          ...(sourceReadBlocked ? { outcome: "blocked", code: "login_required", evidence_kind: "metadata_only",
            scope: "source", recovery: "needs_action", retry_after_ms: null } : { outcome: "ready", evidence_kind: "article",
            source_kind: payload.sourceKind, final_public_url: sourceFinalOverride ?? payload.url, extraction_method: "readability",
            temporary_text: "RAW_HTTP_SOURCE_BODY_MUST_NOT_PERSIST", read_at: new Date().toISOString(), truncated: false }),
          metadata: { title: null, author: null, description: null, published_at: null }, attempts: [{ method: "static", duration_ms: 1 }] });
      }
      if (url === "https://fetcher.example.test/v1/fetch") {
        const payload = JSON.parse(String(init?.body)) as { url: string; mode: string };
        if (payload.mode !== "resolve") throw new Error("Only source resolution is allowed in this fixture");
        return Response.json({ finalUrl: sourceFinalOverride ?? payload.url, redirects: [], status: 200 });
      }
      if (url !== "https://api.deepseek.com/chat/completions") {
        throw new Error("Unexpected network request in offline HTTP acceptance");
      }
      providerCalls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      await beforeProviderResult?.();
      const step = providerSteps.shift();
      const tool = step && "tool" in step ? step.tool : undefined;
      const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${randomUUID().replaceAll("-", "")}`,
        type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }
        : { role: "assistant", reasoning_content: "PRIVATE_REASONING", content: step && "answer" in step ? step.answer : providerAnswer };
      return new Response([
        `data: ${JSON.stringify({ id: "synthetic-http", object: "chat.completion.chunk", model: "deepseek-flash", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: "synthetic-http", choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
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
      approve: await import("../../apps/web/src/app/api/website-agent/sessions/[sessionId]/actions/[actionId]/approve/route"),
      decline: await import("../../apps/web/src/app/api/website-agent/sessions/[sessionId]/actions/[actionId]/decline/route"),
      select: await import("../../apps/web/src/app/api/website-agent/sessions/[sessionId]/actions/[actionId]/select/route"),
    };
  }, 120_000);

  beforeEach(() => {
    sourceFinalOverride = undefined;
    sourceReadCount = 0; sourceReadBlocked = false;
    providerCalls = [];
    providerAnswer = "Synthetic native answer";
    beforeProviderResult = undefined;
    providerSteps = [];
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
    await owner.db.insert(accounts).values({ id: accountId, stableHandle: `http-${accountId}`, displayName: "Synthetic HTTP member",
      primaryEmail: `http-${accountId}@example.test`, emailVerifiedAt: new Date() });
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

  async function propose(actor: Member, name: WebsiteAgentReviewedToolName, args: Record<string, unknown>): Promise<WebsiteAgentSessionView> {
    const view = await create(actor), callsBefore = providerCalls.length;
    providerSteps = [{ tool: { name, arguments: args } }, { answer: "Review the exact proposed change in the confirmation card." }];
    const response = await query(actor, view, `Prepare the synthetic ${name} action for my review.`);
    expect(response.status).toBe(200);
    const result = await response.json() as SessionBody;
    expect(result.session.actions).toEqual([expect.objectContaining({ toolName: name, status: "pending", receipt: null })]);
    expect(providerSteps).toEqual([]);
    expect(providerCalls.length - callsBefore).toBe(2);
    expect(JSON.stringify(providerCalls.at(-1))).toContain("requires_user_confirmation");
    return result.session;
  }
  function approve(actor: Member, view: WebsiteAgentSessionView, action = view.actions![0]!, changes: Record<string, unknown> = {}): Promise<Response> {
    return routes.approve.POST(request(`/sessions/${view.id}/actions/${action.id}/approve`, actor, {
      expected_revision: view.revision, expected_arguments_hash: action.argumentsHash, approval: true, ...changes,
    }), { params: Promise.resolve({ sessionId: view.id, actionId: action.id }) });
  }
  function decline(actor: Member, view: WebsiteAgentSessionView, action = view.actions![0]!): Promise<Response> {
    return routes.decline.POST(request(`/sessions/${view.id}/actions/${action.id}/decline`, actor, { expected_revision: view.revision }),
      { params: Promise.resolve({ sessionId: view.id, actionId: action.id }) });
  }
  async function domain() {
    const id = randomUUID(), slug = `http-${id}`;
    await owner.db.insert(domains).values({ id, slug, name: "Synthetic HTTP domain" });
    return { id, slug };
  }
  async function digestFixture(actor: Member) {
    const topic = await domain();
    await owner.db.insert(accountDigestPreferences).values({ accountId: actor.accountId, enabled: false,
      timezone: "UTC", sendWindowStartMinute: 480, sendWindowMinutes: 60 });
    return { topic, args: { enabled: true, domain_slugs: [topic.slug], timezone: "Asia/Shanghai", window_start: "09:15", window_minutes: 90 } };
  }
  async function digestEffects(actor: Member): Promise<number> {
    return Number((await owner.sql`SELECT count(*)::int AS n FROM website_http_action_effects WHERE account_id=${actor.accountId}`)[0]!.n);
  }
  async function storedSession(actor: Member, id: string) {
    const [row] = await owner.sql<{ revision: number; encrypted_state: string; active_run_id: string | null; active_run_deadline: Date | null }[]>`
      SELECT revision,encrypted_state,active_run_id,active_run_deadline FROM website_agent_sessions WHERE id=${id} AND account_id=${actor.accountId}`;
    expect(row).toBeDefined();
    const state = decryptWebsiteAgentSessionState({ accountId: actor.accountId, sessionId: id,
      revision: row!.revision, encryptedState: row!.encrypted_state });
    return { row: row!, state };
  }
  async function fixtureActionTime(actor: Member, id: string, actionId: string, kind: "approval_expired" | "lease_expired") {
    // Age only a server-created synthetic proposal/claim, using the real envelope
    // writer and matching plaintext lease columns. No credentials/business effect are invented.
    const stored = await storedSession(actor, id), current = Date.now();
    if (stored.state.version !== 2) throw new Error("Expected reviewed-action envelope");
    const actions = stored.state.actions.map(action => action.id !== actionId ? action : { ...action,
      createdAt: new Date(current - 120_000).toISOString(),
      expiresAt: new Date(kind === "approval_expired" ? current - 1_000 : current + 180_000).toISOString(),
      ...(kind === "lease_expired" ? { deadline: new Date(current - 1_000).toISOString() } : {}),
    });
    const next: WebsiteAgentSessionState = { ...stored.state, actions };
    const encrypted = encryptWebsiteAgentSessionState({ accountId: actor.accountId, sessionId: id, revision: stored.row.revision, state: next });
    const lease = kind === "lease_expired" ? new Date(current - 1_000) : stored.row.active_run_deadline;
    const leaseTimestamp = lease instanceof Date ? lease.toISOString() : lease;
    await owner.sql`UPDATE website_agent_sessions SET encrypted_state=${encrypted},active_run_deadline=${leaseTimestamp}::timestamptz
      WHERE id=${id} AND account_id=${actor.accountId} AND revision=${stored.row.revision}`;
  }
  async function contentFixture(actor: Member, visibility: "private" | "public") {
    const topic = await domain(), contentId = randomUUID(), publicId = randomUUID(), collectionId = randomUUID();
    await owner.db.insert(filterProfiles).values({ accountId: actor.accountId, displayName: "Synthetic HTTP Filter" });
    const url = `https://content.example.test/${contentId}`, published = new Date();
    await owner.db.insert(contents).values({ id: contentId, publicId, outboundUrl: url, normalizedUrl: url, canonicalUrl: url,
      firstPublicAt: visibility === "public" ? published : null, source: "generic_web", title: "Synthetic HTTP article", aiSummary: "Synthetic summary", summaryStatus: "ready" });
    await owner.db.insert(collections).values({ id: collectionId, accountId: actor.accountId, contentId, domainId: topic.id,
      visibility, publicSince: visibility === "public" ? published : null, sourceChannel: "web" });
    expect(await resolveSession(runtime.db, actor.token)).toMatchObject({ isFilter: true });
    return { contentId, publicId, collectionId };
  }
  async function expectReceipt(actor: Member, view: WebsiteAgentSessionView, expectedStatus = "completed"): Promise<ActionView> {
    const card = view.actions![0]!;
    expect(card.status).toBe(expectedStatus);
    expect(Object.keys(card.receipt!).sort()).toEqual(["code", "message", "ok"]);
    expect(card.receipt!.ok).toBe(expectedStatus === "completed");
    for (const key of ["arguments", "authSessionId", "claimId", "nativeSession", "encryptedState", "value", "token"])
      expect(card).not.toHaveProperty(key);
    expect(JSON.stringify(view)).not.toContain(actor.token);
    const stored = await storedSession(actor, view.id);
    expect(stored.state.version).toBe(2);
    if (stored.state.version !== 2) throw new Error("Expected reviewed-action envelope");
    expect(stored.state.actions[0]!.receipt).toEqual(card.receipt);
    expect(stored.state.actions[0]).toMatchObject({ status: expectedStatus, authSessionId: actor.sessionId, claimId: null, deadline: null });
    expect(stored.row).toMatchObject({ active_run_id: null, active_run_deadline: null });
    for (const raw of [actor.token, actor.sessionId, "attention_update_", "The exact reviewed action completed."])
      expect(stored.row.encrypted_state).not.toContain(raw);
    return card;
  }
  async function waitForDatabaseLock(queryFragment: string): Promise<void> {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const [row] = await owner.sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query ILIKE ${`%${queryFragment}%`}) AS waiting`;
      if (row?.waiting === true) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Expected an actual PostgreSQL lock wait for ${queryFragment}`);
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

  it("executes a native SSE digest proposal exactly once across concurrent HTTP approvals and replay, with encrypted safe receipts", async () => {
    const actor = await member(), fixture = await digestFixture(actor), before = await digestEffects(actor);
    const proposed = await propose(actor, "attention_update_digest_settings", fixture.args);
    const prior = await storedSession(actor, proposed.id);
    expect(await digestEffects(actor)).toBe(before);
    expect((await owner.sql`SELECT enabled FROM account_digest_preferences WHERE account_id=${actor.accountId}`)[0]?.enabled).toBe(false);
    expect(prior.state.version === 2 && prior.state.actions[0]!.arguments).toEqual(fixture.args);
    const responses = await Promise.all([approve(actor, proposed), approve(actor, proposed)]);
    for (const response of responses) expect(response.status).toBe(200);
    const completed = ((await (await load(actor, proposed.id)).json()) as SessionBody).session;
    await expectReceipt(actor, completed);
    expect((await storedSession(actor, proposed.id)).state.nativeSession).toEqual(prior.state.nativeSession);
    expect(await digestEffects(actor)).toBe(before + 1);
    const [preferences] = await owner.sql`SELECT enabled,timezone,send_window_start_minute,send_window_minutes
      FROM account_digest_preferences WHERE account_id=${actor.accountId}`;
    expect(preferences).toMatchObject({ enabled: true, timezone: "Asia/Shanghai", send_window_start_minute: 555, send_window_minutes: 90 });
    expect(await owner.sql`SELECT d.slug FROM domain_digest_subscriptions s JOIN domains d ON d.id=s.domain_id
      WHERE s.account_id=${actor.accountId} AND s.active=true`).toEqual([expect.objectContaining({ slug: fixture.topic.slug })]);
    const replay = await approve(actor, proposed);
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as SessionBody).session).toEqual(completed);
    expect(await digestEffects(actor)).toBe(before + 1);
    expect(providerCalls).toHaveLength(2);
  }, 30_000);

  it("binds real HTTP approval to exact hash, owner and issuing authentication session, including revocation", async () => {
    const actor = await member(), other = await member(), fixture = await digestFixture(actor);
    const proposed = await propose(actor, "attention_update_digest_settings", fixture.args), before = await digestEffects(actor);
    await expectError(await approve(actor, proposed, undefined, { expected_arguments_hash: "f".repeat(64) }), 404, "action_not_found");
    await expectError(await approve(other, proposed), 404, "session_not_found");
    const issued = await issueSession(owner.db, { accountId: actor.accountId });
    const anotherLogin: Member = { accountId: actor.accountId, sessionId: issued.sessionId, token: issued.token,
      cookie: serializeSessionCookie(issued.token, issued.expiresAt, { secure: true }).split(";")[0]! };
    await expectError(await approve(anotherLogin, proposed), 409, "action_authentication_changed");
    await revokeSession(owner.db, actor.token);
    await expectError(await approve(actor, proposed), 401, "authentication_required");
    const stored = await storedSession(actor, proposed.id);
    expect(stored.state.version === 2 && stored.state.actions[0]!.status).toBe("pending");
    expect(stored.row.active_run_id).toBeNull();
    expect(await digestEffects(actor)).toBe(before);
    expect(providerCalls).toHaveLength(2);
  }, 30_000);

  it.each(["declined", "expired"] as const)("does not execute a %s real proposal, even when approval is replayed", async kind => {
    const actor = await member(), fixture = await digestFixture(actor);
    const proposed = await propose(actor, "attention_update_digest_settings", fixture.args), before = await digestEffects(actor);
    if (kind === "declined") {
      const response = await decline(actor, proposed);
      expect(response.status).toBe(200);
      expect(((await response.json()) as SessionBody).session.actions![0]!.status).toBe("cancelled");
      expect((await approve(actor, proposed)).status).toBe(200);
    } else {
      await fixtureActionTime(actor, proposed.id, proposed.actions![0]!.id, "approval_expired");
      await expectError(await approve(actor, proposed), 409, "action_expired");
    }
    const reloaded = ((await (await load(actor, proposed.id)).json()) as SessionBody).session;
    expect(reloaded.actions![0]!.status).toBe(kind === "declined" ? "cancelled" : "expired");
    expect(reloaded.actions![0]!.receipt).toBeNull();
    expect((await approve(actor, reloaded)).status).toBe(200);
    expect(await digestEffects(actor)).toBe(before);
    expect(providerCalls).toHaveLength(2);
  }, 30_000);

  it.each(["settings", "email"] as const)("revalidates the locked digest %s and keeps a changed proposal non-retryable without its write", async changed => {
    const actor = await member(), fixture = await digestFixture(actor);
    const proposed = await propose(actor, "attention_update_digest_settings", fixture.args);
    if (changed === "settings") await owner.sql`UPDATE account_digest_preferences SET timezone='Europe/Paris' WHERE account_id=${actor.accountId}`;
    else await owner.sql`UPDATE accounts SET primary_email=${`changed-${actor.accountId}@example.test`},email_verified_at=clock_timestamp() WHERE id=${actor.accountId}`;
    const before = await digestEffects(actor);
    await expectError(await approve(actor, proposed), 409, "action_target_changed");
    const reloaded = ((await (await load(actor, proposed.id)).json()) as SessionBody).session;
    await expectReceipt(actor, reloaded, "unknown");
    expect((await approve(actor, proposed)).status).toBe(200);
    expect(await digestEffects(actor)).toBe(before);
    expect((await owner.sql`SELECT enabled,timezone FROM account_digest_preferences WHERE account_id=${actor.accountId}`)[0])
      .toMatchObject({ enabled: false, timezone: changed === "settings" ? "Europe/Paris" : "UTC" });
  }, 30_000);

  it("executes actual collection and content target locks before the Core visibility update", async () => {
    const actor = await member(), target = await contentFixture(actor, "private");
    const proposed = await propose(actor, "attention_update_collection", { collection_id: target.collectionId, visibility: "public" });
    expect((await owner.sql`SELECT visibility FROM collections WHERE id=${target.collectionId}`)[0]?.visibility).toBe("private");
    const response = await approve(actor, proposed);
    expect(response.status).toBe(200);
    const completed = ((await response.json()) as SessionBody).session;
    await expectReceipt(actor, completed);
    expect((await owner.sql`SELECT visibility,public_since IS NOT NULL AS published FROM collections WHERE id=${target.collectionId}`)[0])
      .toMatchObject({ visibility: "public", published: true });
    expect((await owner.sql`SELECT first_public_at IS NOT NULL AS published FROM contents WHERE id=${target.contentId}`)[0]?.published).toBe(true);
    expect((await owner.sql`SELECT count(*)::int AS n FROM collection_events WHERE collection_id=${target.collectionId} AND event_type='made_public'`)[0]?.n).toBe(1);
    expect((await approve(actor, proposed)).status).toBe(200);
    expect((await owner.sql`SELECT count(*)::int AS n FROM collection_events WHERE collection_id=${target.collectionId} AND event_type='made_public'`)[0]?.n).toBe(1);
  }, 30_000);

  it("executes real reporting and moderation voting through their separate reviews and target locks", async () => {
    const actor = await member(), target = await contentFixture(actor, "public");
    const report = await propose(actor, "attention_report_content", {
      public_content_id: target.publicId, reason_code: "spam", details: "Synthetic review fixture, not a real report.",
    });
    expect((await owner.sql`SELECT count(*)::int AS n FROM content_reports WHERE content_id=${target.contentId}`)[0]?.n).toBe(0);
    const reportResponse = await approve(actor, report);
    expect(reportResponse.status).toBe(200);
    await expectReceipt(actor, ((await reportResponse.json()) as SessionBody).session);
    expect((await owner.sql`SELECT count(*)::int AS n FROM content_reports WHERE content_id=${target.contentId} AND reporter_account_id=${actor.accountId}`)[0]?.n).toBe(1);
    const [courtCase] = await owner.sql<{ id: string }[]>`SELECT id FROM moderation_cases WHERE content_id=${target.contentId} AND status='open'`;
    expect(courtCase).toBeDefined();
    expect((await owner.sql`SELECT count(*)::int AS n FROM moderation_votes WHERE case_id=${courtCase!.id}`)[0]?.n).toBe(0);
    const vote = await propose(actor, "attention_cast_moderation_vote", { case_id: courtCase!.id, decision: "hidden" });
    expect((await owner.sql`SELECT count(*)::int AS n FROM moderation_votes WHERE case_id=${courtCase!.id}`)[0]?.n).toBe(0);
    const voteResponse = await approve(actor, vote);
    expect(voteResponse.status).toBe(200);
    await expectReceipt(actor, ((await voteResponse.json()) as SessionBody).session);
    expect(await owner.sql`SELECT decision FROM moderation_votes WHERE case_id=${courtCase!.id} AND filter_account_id=${actor.accountId}`)
      .toEqual([expect.objectContaining({ decision: "hidden" })]);
    expect((await approve(actor, vote)).status).toBe(200);
    expect((await owner.sql`SELECT count(*)::int AS n FROM moderation_votes WHERE case_id=${courtCase!.id} AND filter_account_id=${actor.accountId}`)[0]?.n).toBe(1);
    expect(providerCalls).toHaveLength(4);
  }, 30_000);

  it("rolls back a real Core database failure inside nested savepoints and still commits its failed receipt", async () => {
    const actor = await member(), fixture = await digestFixture(actor);
    const proposed = await propose(actor, "attention_update_digest_settings", fixture.args), before = await digestEffects(actor);
    const name = `http_digest_failure_${randomUUID().replaceAll("-", "")}`;
    // An actual PostgreSQL error after the Core UPDATE exercises canonical !ok
    // handling and savepoint recovery. This does not replace a tool or its effect.
    await owner.sql.unsafe(`CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql
      SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
        IF NEW.account_id='${actor.accountId}'::uuid AND NEW.enabled THEN
          RAISE EXCEPTION 'synthetic_http_digest_write_failure';
        END IF; RETURN NEW; END $$;
      REVOKE ALL ON FUNCTION public.${name}() FROM PUBLIC;
      CREATE TRIGGER ${name} AFTER UPDATE ON public.account_digest_preferences FOR EACH ROW EXECUTE FUNCTION public.${name}();`);
    const response = await approve(actor, proposed);
    expect(response.status).toBe(200);
    const completed = ((await response.json()) as SessionBody).session;
    const card = await expectReceipt(actor, completed, "failed");
    expect(card.receipt!.code).toBe("internal_error");
    expect(await digestEffects(actor)).toBe(before);
    expect((await owner.sql`SELECT enabled,timezone FROM account_digest_preferences WHERE account_id=${actor.accountId}`)[0])
      .toMatchObject({ enabled: false, timezone: "UTC" });
    expect((await owner.sql`SELECT count(*)::int AS n FROM domain_digest_subscriptions WHERE account_id=${actor.accountId}`)[0]?.n).toBe(0);
    expect((await approve(actor, proposed)).status).toBe(200);
    expect(await digestEffects(actor)).toBe(before);
  }, 30_000);

  it("shares the real PostgreSQL account lane across actions and model sessions and settles a crashed claim without retry", async () => {
    const actor = await member(), fixture = await digestFixture(actor);
    const first = await propose(actor, "attention_update_digest_settings", fixture.args);
    const second = await propose(actor, "attention_update_digest_settings", fixture.args), before = await digestEffects(actor);
    const card = first.actions![0]!;
    // Persist the real claim but intentionally do not run its callback: a process
    // crash between claim and effect, not an invented fake executing record.
    const claimed = await claimWebsiteAgentAction(runtime.db, { accountId: actor.accountId, sessionId: first.id,
      actionId: card.id, authSessionId: actor.sessionId, expectedRevision: first.revision, argumentsHash: card.argumentsHash });
    expect(claimed.claim).not.toBeNull();
    await expectError(await approve(actor, second), 409, "website_agent_busy");
    await expectError(await query(actor, second), 409, "website_agent_busy");
    expect((await approve(actor, first)).status).toBe(200);
    expect(await digestEffects(actor)).toBe(before);
    await fixtureActionTime(actor, first.id, card.id, "lease_expired");
    const recovered = ((await (await load(actor, first.id)).json()) as SessionBody).session;
    await expectReceipt(actor, recovered, "unknown");
    expect((await approve(actor, recovered)).status).toBe(200);
    const repeated = ((await (await load(actor, first.id)).json()) as SessionBody).session;
    expect(repeated.revision).toBe(recovered.revision);
    expect(await digestEffects(actor)).toBe(before);
    expect(providerCalls).toHaveLength(4);
    // A distinct explicit approval can use the released lane; the unknown action is never rerun.
    const next = await approve(actor, second);
    expect(next.status).toBe(200);
    await expectReceipt(actor, ((await next.json()) as SessionBody).session);
    expect(await digestEffects(actor)).toBe(before + 1);
    expect(((await (await load(actor, first.id)).json()) as SessionBody).session.actions![0]!.status).toBe("unknown");
  }, 30_000);

  it("blocks at the real authority row lock and refuses effects when a concurrent revocation commits first", async () => {
    const actor = await member(), fixture = await digestFixture(actor);
    const proposed = await propose(actor, "attention_update_digest_settings", fixture.args), before = await digestEffects(actor);
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { locked = resolve; });
    const revocation = owner.sql.begin(async tx => {
      await tx`UPDATE entitlements SET member_enabled=false WHERE account_id=${actor.accountId}`;
      locked(); await gate;
    });
    await Promise.race([ready, revocation]);
    const approval = approve(actor, proposed);
    let response!: Response;
    try {
      await waitForDatabaseLock("from entitlements");
      expect(await digestEffects(actor)).toBe(before);
    } finally { release(); await revocation; response = await approval; }
    await expectError(response, 403, "permission_revoked");
    expect(await digestEffects(actor)).toBe(before);
    const stored = await storedSession(actor, proposed.id);
    expect(stored.state.version === 2 && stored.state.actions[0]!.status).toBe("unknown");
    expect(stored.row.active_run_id).toBeNull();
  }, 30_000);

  it("holds real authority locks through the target effect and receipt before a later revocation can commit", async () => {
    const actor = await member(), fixture = await digestFixture(actor);
    const proposed = await propose(actor, "attention_update_digest_settings", fixture.args), before = await digestEffects(actor);
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { locked = resolve; });
    const targetLock = owner.sql.begin(async tx => {
      await tx`SELECT account_id FROM account_digest_preferences WHERE account_id=${actor.accountId} FOR UPDATE`;
      locked(); await gate;
    });
    await Promise.race([ready, targetLock]);
    const approval = approve(actor, proposed);
    let revocation: Promise<unknown> | undefined;
    let response!: Response;
    try {
      await waitForDatabaseLock("from account_digest_preferences");
      revocation = owner.sql`UPDATE entitlements SET member_enabled=false WHERE account_id=${actor.accountId}`.then(rows => rows);
      await waitForDatabaseLock("UPDATE entitlements");
      expect(await digestEffects(actor)).toBe(before);
    } finally { release(); await targetLock; response = await approval; await revocation; }
    // Final HTTP auth revalidation may race the now-allowed revocation, but the
    // durable result must be committed before authority can be removed.
    expect([200, 403]).toContain(response.status);
    if (response.status === 403) await expectError(response, 403, "permission_revoked");
    const stored = await storedSession(actor, proposed.id);
    expect(stored.state.version === 2 && stored.state.actions[0]).toMatchObject({ status: "completed", receipt: { ok: true } });
    expect(stored.row.active_run_id).toBeNull();
    expect(await digestEffects(actor)).toBe(before + 1);
  }, 30_000);

  it("bounds a real PostgreSQL target lock wait and retains an unknown receipt without retrying the effect", async () => {
    const actor = await member(), fixture = await digestFixture(actor);
    const proposed = await propose(actor, "attention_update_digest_settings", fixture.args), before = await digestEffects(actor);
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { locked = resolve; });
    const blocker = owner.sql.begin(async tx => {
      await tx`SELECT account_id FROM account_digest_preferences WHERE account_id=${actor.accountId} FOR UPDATE`;
      locked(); await gate;
    });
    await Promise.race([ready, blocker]);
    const approval = approve(actor, proposed);
    let response!: Response;
    try {
      await waitForDatabaseLock("from account_digest_preferences");
      // Keep the genuine target lock held until the action transaction's local
      // lock_timeout aborts it. The fixture does not time out or unlock for it.
      response = await approval;
    } finally { release(); await blocker; await approval; }
    await expectError(response, 503, "action_outcome_unknown");
    const recovered = ((await (await load(actor, proposed.id)).json()) as SessionBody).session;
    await expectReceipt(actor, recovered, "unknown");
    expect(await digestEffects(actor)).toBe(before);
    expect((await approve(actor, recovered)).status).toBe(200);
    expect(await digestEffects(actor)).toBe(before);
    expect(providerCalls).toHaveLength(2);
  }, 30_000);

  async function enrichmentFixture(actor: Member, options: { blocked?: boolean; consent?: boolean } = {}) {
    const target = await contentFixture(actor, "private"), url = `https://article.example.org/${target.contentId}`;
    await owner.db.update(contents).set({ summaryStatus: "pending", aiSummary: null, aiTags: [], title: null,
      outboundUrl: url, normalizedUrl: url, canonicalUrl: url }).where(eq(contents.id, target.contentId));
    const view = await create(actor);
    const args = { content_id: target.contentId, idempotency_key: `enrichment-http:${view.id}`, title: "Synthetic exact shared title",
      summary: "Synthetic exact grounded shared summary.", tags: ["Agents"], resolved_url: url };
    sourceReadBlocked = options.blocked ?? false;
    providerSteps = [
      { tool: { name: "attention_read_collection_source", arguments: { collection_id: target.collectionId, attempt_ref: "model-reference" } } },
      { tool: { name: "attention_submit_content_enrichment", arguments: args } },
      { answer: "Review the exact shared summary and consequences in the website card." },
    ];
    const response = await routes.query.POST(request("/query", actor, { query: "Read my article and propose a shared summary",
      session_id: view.id, expected_revision: view.revision, operation_id: randomUUID(), data_consent: true, read_sources: options.consent ?? true }));
    expect(response.status).toBe(200);
    return { target, args, proposed: ((await response.json()) as SessionBody).session };
  }
  it("reads actual authenticated source evidence, reviews and applies exact enrichment once without approval-time network", async () => {
    const actor = await member(), { target, args, proposed } = await enrichmentFixture(actor);
    expect(proposed.actions).toHaveLength(1);
    expect(proposed.actions![0]).toMatchObject({ toolName: "attention_submit_content_enrichment", status: "pending" });
    expect(proposed.actions![0]!.review.details).toContainEqual({ label: "拟提交摘要", value: args.summary });
    const stored = await storedSession(actor, proposed.id);
    expect(stored.state.version).toBe(2);
    if (stored.state.version !== 2) throw new Error("missing action state");
    const evidence = stored.state.actions[0]!.prepared;
    expect(evidence).toMatchObject({ kind: "enrichment", evidence: { accountId: actor.accountId, authSessionId: actor.sessionId, sessionId: proposed.id } });
    expect(JSON.stringify(stored.state.nativeSession)).not.toContain("RAW_HTTP_SOURCE_BODY");
    expect(JSON.stringify(stored.state.actions)).not.toContain("RAW_HTTP_SOURCE_BODY");
    expect(JSON.stringify(stored.state.nativeSession)).not.toContain(args.summary);
    expect((await owner.db.select().from(contents).where(eq(contents.id, target.contentId)))[0]?.summaryStatus).toBe("pending");
    const reads = sourceReadCount, calls = providerCalls.length;
    const response = await approve(actor, proposed); expect(response.status).toBe(200);
    await expectReceipt(actor, ((await response.json()) as SessionBody).session);
    expect((await owner.db.select().from(contents).where(eq(contents.id, target.contentId)))[0]).toMatchObject({
      summaryStatus: "ready", aiSummary: args.summary, title: args.title, outboundUrl: args.resolved_url, aiTags: args.tags });
    expect((await approve(actor, proposed)).status).toBe(200);
    expect(sourceReadCount).toBe(reads); expect(providerCalls).toHaveLength(calls);
  }, 30_000);
  it.each(["blocked", "consent"] as const)("does not manufacture an executable review without source article evidence: %s", async missing => {
    const actor = await member(), { proposed, target } = await enrichmentFixture(actor, missing === "blocked" ? { blocked: true } : { consent: false });
    expect(proposed.actions ?? []).toEqual([]);
    expect(JSON.stringify(providerCalls.at(-1))).toContain("source_evidence_required");
    expect((await owner.db.select().from(contents).where(eq(contents.id, target.contentId)))[0]?.summaryStatus).toBe("pending");
  }, 30_000);
  it("rejects a target revision race after source review and never reapplies an unknown claim", async () => {
    const actor = await member(), { target, proposed } = await enrichmentFixture(actor);
    await owner.db.update(contents).set({ outboundUrl: "https://article.example.org/changed", updatedAt: new Date() }).where(eq(contents.id, target.contentId));
    await expectError(await approve(actor, proposed), 409, "enrichment_target_changed");
    const reloaded = ((await (await load(actor, proposed.id)).json()) as SessionBody).session;
    expect(reloaded.actions![0]!.status).toBe("unknown");
    expect((await approve(actor, proposed)).status).toBe(200);
    expect((await owner.db.select().from(contents).where(eq(contents.id, target.contentId)))[0]?.summaryStatus).toBe("pending");
  }, 30_000);
  it("rolls back enrichment and a transaction-local cookie revocation at final authority recheck", async () => {
    const actor = await member(), { target, proposed } = await enrichmentFixture(actor);
    const name = `http_enrichment_revoke_${randomUUID().replaceAll("-", "")}`;
    await owner.sql.unsafe(`CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
      BEGIN IF NEW.id='${target.contentId}'::uuid AND NEW.summary_status='ready' THEN
        UPDATE public.sessions SET revoked_at=clock_timestamp() WHERE id='${actor.sessionId}'::uuid;
        END IF; RETURN NEW; END $$;
      REVOKE ALL ON FUNCTION public.${name}() FROM PUBLIC;
      CREATE TRIGGER ${name} AFTER UPDATE OF summary_status ON public.contents FOR EACH ROW EXECUTE FUNCTION public.${name}();`);
    try { await expectError(await approve(actor, proposed), 403, "permission_revoked"); }
    finally { await owner.sql.unsafe(`DROP TRIGGER ${name} ON public.contents; DROP FUNCTION public.${name}()`); }
    expect((await owner.db.select().from(contents).where(eq(contents.id, target.contentId)))[0]).toMatchObject({ summaryStatus: "pending", aiSummary: null });
    expect((await owner.sql`SELECT revoked_at FROM sessions WHERE id=${actor.sessionId}`)[0]?.revoked_at).toBeNull();
    expect(((await (await load(actor, proposed.id)).json()) as SessionBody).session.actions![0]!.status).toBe("unknown");
  }, 30_000);
  it("atomically rolls back actual enrichment when the outer action receipt fails", async () => {
    const actor = await member(), { target, proposed } = await enrichmentFixture(actor);
    const name = `http_enrichment_receipt_failure_${randomUUID().replaceAll("-", "")}`;
    await owner.sql.unsafe(`CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
      BEGIN IF NEW.account_id='${actor.accountId}'::uuid AND OLD.active_run_id IS NOT NULL AND NEW.active_run_id IS NULL
        AND EXISTS(SELECT 1 FROM public.contents WHERE id='${target.contentId}'::uuid AND summary_status='ready')
        THEN RAISE EXCEPTION 'synthetic_enrichment_receipt_failure'; END IF; RETURN NEW; END $$;
      REVOKE ALL ON FUNCTION public.${name}() FROM PUBLIC;
      CREATE TRIGGER ${name} BEFORE UPDATE ON public.website_agent_sessions FOR EACH ROW EXECUTE FUNCTION public.${name}();`);
    try { await expectError(await approve(actor, proposed), 503, "action_outcome_unknown"); }
    finally { await owner.sql.unsafe(`DROP TRIGGER ${name} ON public.website_agent_sessions; DROP FUNCTION public.${name}()`); }
    expect((await owner.db.select().from(contents).where(eq(contents.id, target.contentId)))[0]).toMatchObject({ summaryStatus: "pending", aiSummary: null });
    expect((await owner.sql`SELECT count(*)::int AS n FROM content_identities WHERE content_id=${target.contentId}`)[0]?.n).toBe(0);
    expect(((await (await load(actor, proposed.id)).json()) as SessionBody).session.actions![0]!.status).toBe("unknown");
  }, 30_000);

  registerCollectionReviewCoreCases(() => ({ owner, runtime }));

  async function proposeCollection(actor: Member, input: string): Promise<WebsiteAgentSessionView> {
    await owner.db.insert(filterProfiles).values({ accountId: actor.accountId, displayName: "Synthetic collection Filter" }).onConflictDoNothing();
    const session = await create(actor);
    providerSteps = [{ tool: { name: "attention_collect_content", arguments: { visibility: "public" } } }, { answer: "Review the source before publishing." }];
    const response = await query(actor, session, input);
    expect(response.status).toBe(200);
    const result = await response.json() as SessionBody;
    expect(result.session.actions).toHaveLength(1);
    expect((await owner.sql`SELECT count(*)::int AS n FROM collections WHERE account_id=${actor.accountId}`)[0]?.n).toBe(0);
    return result.session;
  }
  function select(actor: Member, session: WebsiteAgentSessionView, candidateId: string): Promise<Response> {
    const action = session.actions![0]!;
    return routes.select.POST(request(`/sessions/${session.id}/actions/${action.id}/select`, actor, {
      expected_revision: session.revision, expected_arguments_hash: action.argumentsHash, candidate_id: candidateId,
    }), { params: Promise.resolve({ sessionId: session.id, actionId: action.id }) });
  }
  it("prepares public ambiguous input without publishing, then requires browser choice and a fresh exact review", async () => {
    const actor = await member(), key = randomUUID();
    const proposed = await proposeCollection(actor, `https://example.com/${key}/first https://example.com/${key}/second`);
    expect(proposed.actions![0]!.candidates).toHaveLength(2);
    const pending = await owner.sql<{ encrypted_payload: string }[]>`SELECT encrypted_payload FROM pending_candidate_sets
      WHERE account_id=${actor.accountId} AND consumed_at IS NULL`;
    if (pending.length !== 1) throw new Error("Expected one synthetic candidate vault");
    const selectionToken = decryptCandidateSet(pending[0]!.encrypted_payload).selectionToken;
    expect(selectionToken.length).toBeGreaterThanOrEqual(32);
    await expectError(await approve(actor, proposed), 409, "candidate_selection_required");
    const another = await member();
    await expectError(await select(another, proposed, proposed.actions![0]!.candidates![0]!.candidateId), 404, "session_not_found");
    const response = await select(actor, proposed, proposed.actions![0]!.candidates![1]!.candidateId);
    expect(response.status).toBe(200);
    const selected = ((await response.json()) as SessionBody).session;
    expect(selected.actions![0]!.id).not.toBe(proposed.actions![0]!.id);
    expect(selected.actions![0]!.toolName).toBe("attention_select_collection_candidate");
    expect(selected.actions![0]!.candidates).toBeUndefined();
    expect(JSON.stringify(selected)).not.toContain("selection_token");
    // A static tool schema can name the field; model messages cannot expose it.
    expect(JSON.stringify(providerCalls.map(call => call.messages)).includes("selection_token")).toBe(false);
    // Assert booleans so a failure cannot print the actual synthetic vault token.
    expect(JSON.stringify(providerCalls).includes(selectionToken)).toBe(false);
    expect(JSON.stringify(selected).includes(selectionToken)).toBe(false);
    expect((await owner.sql`SELECT count(*)::int AS n FROM collections WHERE account_id=${actor.accountId}`)[0]?.n).toBe(0);
    const approved = await approve(actor, selected);
    expect(approved.status).toBe(200);
    expect(((await approved.json()) as SessionBody).session.actions![0]!.status).toBe("completed");
    expect(await owner.sql`SELECT visibility FROM collections WHERE account_id=${actor.accountId}`).toEqual([expect.objectContaining({ visibility: "public" })]);
    expect((await owner.sql`SELECT consumed_at IS NOT NULL AS consumed, encrypted_payload FROM pending_candidate_sets WHERE account_id=${actor.accountId}`)[0])
      .toMatchObject({ consumed: true, encrypted_payload: "" });
    expect(providerCalls).toHaveLength(2);
  }, 30_000);
  it("rejects a changed source on approval before opening the effect transaction, without publishing", async () => {
    const actor = await member(), proposed = await proposeCollection(actor, `https://example.com/${randomUUID()}`);
    sourceFinalOverride = `https://example.com/${randomUUID()}`;
    await expectError(await approve(actor, proposed), 409, "action_target_changed");
    expect((await owner.sql`SELECT count(*)::int AS n FROM collections WHERE account_id=${actor.accountId}`)[0]?.n).toBe(0);
    const reloaded = ((await (await load(actor, proposed.id)).json()) as SessionBody).session;
    expect(reloaded.actions![0]!.status).toBe("unknown");
  }, 30_000);
  it("cannot select candidates after close or after their vault expires", async () => {
    for (const kind of ["close", "expire"] as const) {
      const actor = await member(), key = randomUUID();
      const proposed = await proposeCollection(actor, `https://example.com/${key}/a https://example.com/${key}/b`);
      if (kind === "close") expect((await close(actor, proposed)).status).toBe(200);
      else await owner.sql`UPDATE pending_candidate_sets SET created_at=clock_timestamp()-interval '2 minutes',
        expires_at=clock_timestamp()-interval '1 second' WHERE account_id=${actor.accountId}`;
      const response = await select(actor, proposed, proposed.actions![0]!.candidates![0]!.candidateId);
      expect(response.status).toBe(409);
      expect((await owner.sql`SELECT count(*)::int AS n FROM collections WHERE account_id=${actor.accountId}`)[0]?.n).toBe(0);
    }
  }, 30_000);


  it("approves a prepared collection with one runtime connection and transaction-local final cookie auth", async () => {
    const actor = await member(), proposed = await proposeCollection(actor, `https://example.com/${randomUUID()}`);
    const single = createDatabase(websiteHttpTestDatabaseUrls(process.env).runtime, { maxConnections: 1 });
    const globals = globalThis as typeof globalThis & { __attentionDatabaseHandle?: DatabaseHandle };
    const previous = globals.__attentionDatabaseHandle;
    globals.__attentionDatabaseHandle = single;
    try {
      const response = await approve(actor, proposed);
      expect(response.status).toBe(200);
      expect(((await response.json()) as SessionBody).session.actions![0]!.status).toBe("completed");
      expect((await owner.sql`SELECT count(*)::int AS n FROM collections WHERE account_id=${actor.accountId}`)[0]?.n).toBe(1);
    } finally {
      if (previous) globals.__attentionDatabaseHandle = previous; else delete globals.__attentionDatabaseHandle;
      await single.close();
    }
  }, 30_000);


  it("rolls a candidate capability back with failed collection effects while committing only the failed receipt", async () => {
    const actor = await member(), key = randomUUID();
    const proposed = await proposeCollection(actor, `https://example.com/${key}/a https://example.com/${key}/b`);
    const selectedResponse = await select(actor, proposed, proposed.actions![0]!.candidates![0]!.candidateId);
    expect(selectedResponse.status).toBe(200);
    const selected = ((await selectedResponse.json()) as SessionBody).session;
    const name = `http_collection_failure_${randomUUID().replaceAll("-", "")}`;
    await owner.sql.unsafe(`CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql
      SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
        IF NEW.account_id='${actor.accountId}'::uuid THEN RAISE EXCEPTION 'synthetic_candidate_effect_failure'; END IF;
        RETURN NEW; END $$;
      REVOKE ALL ON FUNCTION public.${name}() FROM PUBLIC;
      CREATE TRIGGER ${name} AFTER INSERT ON public.collections FOR EACH ROW EXECUTE FUNCTION public.${name}();`);
    const response = await approve(actor, selected);
    expect(response.status).toBe(200);
    const completed = ((await response.json()) as SessionBody).session;
    expect(completed.actions![0]).toMatchObject({ status: "failed", receipt: { ok: false } });
    expect((await owner.sql`SELECT count(*)::int AS n FROM collections WHERE account_id=${actor.accountId}`)[0]?.n).toBe(0);
    expect((await owner.sql`SELECT consumed_at FROM pending_candidate_sets WHERE account_id=${actor.accountId}`)[0]?.consumed_at).toBeNull();
    expect((await approve(actor, completed)).status).toBe(200);
    expect((await owner.sql`SELECT consumed_at FROM pending_candidate_sets WHERE account_id=${actor.accountId}`)[0]?.consumed_at).toBeNull();
  }, 30_000);
  it("requires a new review when a candidate URL changes before the human choice", async () => {
    const actor = await member(), key = randomUUID();
    const proposed = await proposeCollection(actor, `https://example.com/${key}/a https://example.com/${key}/b`);
    sourceFinalOverride = `https://example.com/${randomUUID()}/changed`;
    await expectError(await select(actor, proposed, proposed.actions![0]!.candidates![0]!.candidateId), 409, "action_target_changed");
    expect((await owner.sql`SELECT consumed_at FROM pending_candidate_sets WHERE account_id=${actor.accountId}`)[0]?.consumed_at).toBeNull();
    expect((await owner.sql`SELECT count(*)::int AS n FROM collections WHERE account_id=${actor.accountId}`)[0]?.n).toBe(0);
  }, 30_000);

});
