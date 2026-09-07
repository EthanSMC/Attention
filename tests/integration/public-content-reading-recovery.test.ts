import {randomUUID} from "node:crypto";
import {afterAll, beforeAll, describe, expect, it, vi} from "vitest";
import {createDatabase, type DatabaseHandle} from "@attention/db";
import {migrateDatabase} from "@attention/db/migrate";
import {readCollectionSource, collectionSourceRequestSchema} from "../../apps/web/src/server/collection-source-reader";
import {createSourceReadCoordinator, SourceReadMemory} from "../../apps/web/src/server/source-read-coordinator";
import {submitContentEnrichment} from "../../apps/web/src/server/content-enrichment-service";
import {getCollectionStatus} from "../../apps/web/src/server/collection-status-service";
import {readDocument} from "../../apps/fetcher/src/read-document";
import {applyReadToolResult} from "../../apps/cli/src/channel/read-attempt-control";
import {checkPublicReader} from "../../scripts/check-public-reader";
import {createAttentionToolRegistry} from "../../apps/web/src/server/attention-tool-registry";
import type {ReadRequest} from "@attention/content-reader-contracts";
import {applyAttentionToolResult, collectionControlResult} from "../../apps/cli/src/channel/collection-reply-control";
import {createApp} from "../../apps/fetcher/src/index";
import {createFetcherDocumentLoader, createProductionHandlers} from "../../apps/worker/src/production-handlers";
import type {ContentHandlerContext} from "../../apps/worker/src/handlers";

const secret = "synthetic-reader-secret-long-enough";
const env = {FETCHER_BASE_URL: "http://127.0.0.1:4100", FETCHER_SHARED_SECRET: secret};
const context: ContentHandlerContext = {author: null, contentId: "11111111-1111-4111-8111-111111111111",
  outboundUrl: "https://example.com/article", publishedAt: null, signal: new AbortController().signal,
  source: "generic_web", title: null};
const article = "<article><p>Synthetic public evidence for a grounded summary.</p></article>";

describe("integrated Worker reader consumption", () => {
  function fixture(html = article, legacy = false) {
    const browser = {read: vi.fn()};
    const app = createApp(secret, {browser, fetchOperation: async () => ({body: html,
      finalUrl: context.outboundUrl, status: 200, redirects: [], contentType: "text/html"})});
    const paths: string[] = [];
    const requests: Record<string, unknown>[] = [];
    const transport: typeof fetch = async (url, init) => {
      paths.push(new URL(String(url)).pathname);
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      expect(new Headers(init?.headers).has("x-reader-admission")).toBe(false);
      if (legacy && paths.at(-1) === "/v1/read") return new Response(null, {status: 404});
      return app.request(String(url), init);
    };
    const completeJson = vi.fn(async () => ({summary: "Grounded synthetic summary", tags: ["fixture"]}));
    const handlers = createProductionHandlers({documentLoader: createFetcherDocumentLoader(env, transport), provider: {completeJson}});
    return {handlers, paths, requests, browser, completeJson};
  }
  it.each([false, true])("reads through the real new/legacy endpoint and provider gate (legacy=%s)", async legacy => {
    const test = fixture(article, legacy);
    expect(await test.handlers.summary(context)).toMatchObject({status: "ready", summary: "Grounded synthetic summary"});
    expect(test.paths).toEqual(legacy ? ["/v1/read", "/v1/fetch"] : ["/v1/read"]);
    expect(test.requests[0]).toMatchObject({request_ref: expect.any(String), attempt_ref: expect.any(String)});
    expect(test.completeJson.mock.calls).toHaveLength(1);
  });
  it("pauses a dynamic shell with no Worker browser admission without invoking the model", async () => {
    const test = fixture('<div id="app"></div><script src="/app.js"></script>');
    await expect(test.handlers.summary(context)).rejects.toMatchObject({code: "browser_backend_unavailable", retryable: false});
    expect(test.browser.read).not.toHaveBeenCalled(); expect(test.completeJson).not.toHaveBeenCalled();
  });
  it("stops verification without invoking the model", async () => {
    const test = fixture('<form id="challenge-form"><input name="cf-turnstile-response">Complete the security check.</form>');
    await expect(test.handlers.summary(context)).rejects.toMatchObject({code: "verification_required", retryable: false});
    expect(test.completeJson).not.toHaveBeenCalled();
  });
  it.each([401, 429, 500])("does not fall back on endpoint HTTP %s", async status => {
    const transport = vi.fn(async () => new Response(null, {status}));
    await expect(createFetcherDocumentLoader(env, transport)!.load(context)).rejects.toBeDefined();
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each(["attempt", "request", "source", "extra"])("rejects strict reader %s drift before the model", async drift => {
    const completeJson = vi.fn();
    const loader = createFetcherDocumentLoader(env, async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as ReadRequest;
      const result = await readDocument({...request, signal: new AbortController().signal}, {browser: null, now: Date.now,
        staticRead: async () => ({body: article, finalUrl: context.outboundUrl, status: 200, redirects: []})});
      const changed = {...result, ...(drift === "attempt" ? {attempt_ref: "old-attempt"} : drift === "request" ? {request_ref: "old-request"}
        : drift === "source" ? {source_kind: "douyin"} : {unexpected: true})};
      return Response.json(changed);
    });
    await expect(createProductionHandlers({documentLoader: loader, provider: {completeJson}}).summary({...context,
      attemptRef: "current-attempt", requestRef: "current-request"})).rejects.toMatchObject({code: "unknown_reader_error"});
    expect(completeJson).not.toHaveBeenCalled();
  });
  it("honors contextual pause even when the same failure code permits dependency retries", async () => {
    const loader = createFetcherDocumentLoader(env, async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as ReadRequest;
      return Response.json({schema_version: 1, request_ref: request.request_ref, attempt_ref: request.attempt_ref,
        outcome: "failed", code: "dns_failure", scope: "dependency", recovery: "pause", retry_after_ms: null,
        attempts: [{method: "static", duration_ms: 1}], evidence_kind: "none",
        metadata: {title: null, description: null, author: null, published_at: null}});
    });
    await expect(createProductionHandlers({documentLoader: loader, provider: {completeJson: vi.fn()}}).summary(context))
      .rejects.toMatchObject({code: "dns_failure", retryable: false});
  });
  it("cancels before dispatch and reports missing reader without invoking the model", async () => {
    const transport = vi.fn(), completeJson = vi.fn(), controller = new AbortController(); controller.abort();
    await expect(createFetcherDocumentLoader(env, transport)!.load({...context, signal: controller.signal}))
      .rejects.toMatchObject({code: "permission_revoked"});
    expect(transport).not.toHaveBeenCalled();
    await expect(createProductionHandlers({provider: {completeJson}}).summary(context)).rejects.toMatchObject({code: "reader_not_configured"});
    expect(completeJson).not.toHaveBeenCalled();
  });
});

it("accepts published skill client context at the source gateway and rejects unsupported versions", () => {
  const input = {collection_id: context.contentId, attempt_ref: "attempt", client_context: {skill_id: "attention", skill_version: "1.10.0", workflow_run_id: "workflow"}};
  expect(collectionSourceRequestSchema.safeParse(input).success).toBe(true);
  const tool = createAttentionToolRegistry().find(tool => tool.name === "attention_read_collection_source")!;
  expect(tool.inputSchema.safeParse(input).success).toBe(true);
  expect(collectionSourceRequestSchema.safeParse({...input, client_context: {...input.client_context, skill_version: "1.11.0"}}).success).toBe(false);
});

it("anonymous diagnostics return only classification, method and length, and require explicit configuration", async () => {
  const staticRead = vi.fn(async () => ({body: article, finalUrl: context.outboundUrl, status: 200, redirects: []}));
  expect(await checkPublicReader([], staticRead)).toEqual({status: "invalid_configuration", classification: "expected_public_url", method: [], length: 0});
  expect(staticRead).not.toHaveBeenCalled();
  expect(await checkPublicReader(["--url", context.outboundUrl], staticRead)).toEqual({status: "ready", classification: "article", method: ["static"], length: 49});
});

describe.skipIf(!process.env.TEST_READER_DATABASE_URL)("isolated owned Core → read → model → conditional commit → Bridge fact", () => {
  let db: DatabaseHandle;
  beforeAll(async () => {db = createDatabase(process.env.TEST_READER_DATABASE_URL!); await migrateDatabase(db.db);}, 120_000);
  afterAll(async () => {await db?.close();});
  async function fixture() {
    const accountId = randomUUID(), collectionId = randomUUID(), contentId = randomUUID();
    await db.sql`insert into accounts (id, stable_handle) values (${accountId}, ${`integrated-${accountId}`})`;
    await db.sql`insert into entitlements (account_id, source) values (${accountId}, 'admin_grant')`;
    await db.sql`insert into contents (id, outbound_url, normalized_url, canonical_url, source)
      values (${contentId}, 'https://example.com/article', ${`https://example.com/${contentId}`}, ${`https://example.com/${contentId}`}, 'generic_web')`;
    const [domain] = await db.sql`select id from domains limit 1`;
    await db.sql`insert into collections (id, account_id, content_id, domain_id, visibility, source_channel)
      values (${collectionId}, ${accountId}, ${contentId}, ${domain!.id}, 'private', 'wechat')`;
    const principal = {accountId, scopes: ["collection:read"], isMember: true, isFilter: false};
    const controller = new AbortController();
    const call = {collection_id: collectionId, attempt_ref: "integrated-attempt"};
    const readContext = {accountId, runId: "integrated-request", signal: controller.signal,
      getDatabase: () => db.db, revalidate: async () => principal};
    const deps = {memory: new SourceReadMemory(), coordinator: createSourceReadCoordinator(db.db),
      read: vi.fn(async (request: ReadRequest, options: {signal: AbortSignal}) =>
        readDocument({...request, signal: options.signal}, {browser: null, now: Date.now,
          staticRead: async () => ({body: article, finalUrl: request.url, status: 200, redirects: [], contentType: "text/html"})}))};
    return {accountId, collectionId, contentId, principal, controller, call, readContext, deps};
  }
  it("duplicates yield one collection and one Core effect; reader-ready alone cannot complete Bridge", async () => {
    const f = await fixture();
    const status = await getCollectionStatus(db.db, f.principal, {collection_id: f.collectionId});
    const initial = applyAttentionToolResult(null, "attention_get_collection_status", status, {collection_id: f.collectionId});
    const evidence = await readCollectionSource(f.readContext, f.call, f.deps);
    const duplicate = await readCollectionSource({...f.readContext, runId: "duplicate-request"}, f.call, f.deps);
    expect(evidence.outcome).toBe("ready"); expect(duplicate.outcome).toBe("ready"); expect(f.deps.read).toHaveBeenCalledTimes(1);
    const read = applyReadToolResult(null, "attention_read_collection_source", evidence, f.call);
    expect(collectionControlResult(initial!)).toBe("retryable_incomplete");
    expect(JSON.stringify(read)).not.toContain("Synthetic public evidence");
    const provider = {completeJson: async ({user}: {user: string}) => {
      expect(user).toContain("Synthetic public evidence"); return {summary: "Grounded synthetic summary", tags: ["fixture"]};
    }};
    const generated = await createProductionHandlers({provider, documentLoader: {load: async () => ({readResult: evidence,
      finalUrl: context.outboundUrl, html: "", status: 200})}}).summary({...context, contentId: f.contentId});
    const input = {content_id: f.contentId, idempotency_key: `submit-${f.contentId}`, resolved_url: context.outboundUrl,
      title: "Synthetic article", summary: generated.summary!, tags: generated.tags};
    const first = await submitContentEnrichment(db.db, f.principal, input);
    const second = await submitContentEnrichment(db.db, f.principal, {...input, idempotency_key: `other-${f.contentId}`, summary: "Must not overwrite"});
    expect(first.status).toBe("enriched"); expect(second.status).toBe("already_enriched");
    const payload = {status: first.status, content_id: first.contentId, summary_status: first.summaryStatus};
    const completed = applyAttentionToolResult(initial, "attention_submit_content_enrichment", payload, input, read);
    expect(collectionControlResult(completed!)).toBe("completed");
    expect(applyAttentionToolResult(initial, "attention_submit_content_enrichment", {...payload, content_id: randomUUID()}, input, read)).toEqual(initial);
    const rows = await db.sql`select * from contents where id = ${f.contentId}`;
    expect(rows[0]?.ai_summary).toBe("Grounded synthetic summary");
    expect(JSON.stringify(rows)).not.toContain("Synthetic public evidence");
    expect((await db.sql`select id from collections where account_id = ${f.accountId}`)).toHaveLength(1);
    const events = await db.sql`select * from event_ledger where content_id = ${f.contentId}`;
    expect(events).toHaveLength(1); expect(JSON.stringify(events)).not.toContain("Synthetic public evidence");
  });
  it("cancellation discards late article evidence and never commits a summary", async () => {
    const f = await fixture(); let finish!: () => void;
    const blocked = new Promise<void>(resolve => {finish = resolve;});
    const original = f.deps.read.getMockImplementation()!;
    f.deps.read.mockImplementation(async (request, options) => {await blocked; return original(request, {...options, signal: new AbortController().signal});});
    const pending = readCollectionSource(f.readContext, f.call, f.deps).catch(error => error as unknown);
    await vi.waitFor(() => expect(f.deps.read).toHaveBeenCalledTimes(1));
    f.controller.abort(); finish();
    expect(await pending).not.toHaveProperty("temporary_text");
    expect((await db.sql`select ai_summary from contents where id = ${f.contentId}`)[0]?.ai_summary).toBeNull();
  });
  it("Core rechecks collection eligibility after read before any summary commit", async () => {
    const f = await fixture();
    expect((await readCollectionSource(f.readContext, f.call, f.deps)).outcome).toBe("ready");
    await db.sql`update collections set collection_status = 'deleted' where id = ${f.collectionId}`;
    await expect(submitContentEnrichment(db.db, f.principal, {content_id: f.contentId, idempotency_key: "late-submission",
      resolved_url: context.outboundUrl, title: "Synthetic article", summary: "Late summary", tags: ["fixture"]})).rejects.toMatchObject({code: "content_not_found"});
    expect((await db.sql`select ai_summary from contents where id = ${f.contentId}`)[0]?.ai_summary).toBeNull();
  });
});
