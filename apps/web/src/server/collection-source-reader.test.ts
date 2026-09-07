import {createHash, randomUUID} from "node:crypto";
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {createDatabase, type DatabaseHandle} from "@attention/db";
import {migrateDatabase} from "@attention/db/migrate";
import type {ReadRequest, ReadResult} from "@attention/content-reader-contracts";
import {createApiCredential, resolveApiCredential, revokeApiCredential, issueSession, resolveSession, revokeSession} from "@attention/auth";
import {handleSourceReadRequest} from "../app/api/collections/[collectionId]/source-read/route";
import {createAttentionToolRegistry, type AttentionToolCoreDependencies} from "./attention-tool-registry";
import {createAttentionMcpServer} from "./mcp-tool-adapter";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import {parseAndValidateUrl} from "@attention/fetcher/url-policy";
import type * as GatewayModule from "./collection-source-reader";
import type * as CoordinationModule from "./source-read-coordinator";
import {getCollectionStatus} from "./collection-status-service";

describe.skipIf(!process.env.TEST_READER_DATABASE_URL)("owned source gateway with real Core decisions", () => {
  let owner: DatabaseHandle;
  let web: DatabaseHandle;
  let gateway: typeof GatewayModule;
  let coordination: typeof CoordinationModule;
  const accountId = randomUUID(), collectionId = randomUUID(), contentId = randomUUID();
  const principal = {accountId, scopes: ["collection:read"], isMember: true, isFilter: false};
  const input = {collection_id: collectionId, attempt_ref: "attempt-1"};
  const response = (request: ReadRequest): ReadResult => ({schema_version: 1, request_ref: request.request_ref,
    attempt_ref: request.attempt_ref, outcome: "ready", attempts: [{method: "static", duration_ms: 5}],
    temporary_text: "Synthetic article evidence.", evidence_kind: "article", extraction_method: "readability",
    final_public_url: request.url, source_kind: request.sourceKind, read_at: "2026-09-07T00:00:00.000Z",
    truncated: false, metadata: {author: null, title: null, description: null, published_at: null}});
  beforeAll(async () => {
    owner = createDatabase(process.env.TEST_READER_DATABASE_URL!); await migrateDatabase(owner.db);
    await owner.sql`insert into accounts (id, stable_handle) values (${accountId}, ${`gateway${accountId}`})`;
    await owner.sql`insert into entitlements (account_id, source) values (${accountId}, 'admin_grant')`;
    await owner.sql`insert into contents (id, outbound_url, normalized_url, canonical_url, source)
      values (${contentId}, 'https://例子.测试:443/article', 'https://example.test/article', 'https://example.test/article', 'generic_web')`;
    const [domain] = await owner.sql`select id from domains limit 1`;
    await owner.sql`insert into collections (id, account_id, content_id, domain_id, visibility, source_channel)
      values (${collectionId}, ${accountId}, ${contentId}, ${domain!.id}, 'private', 'web')`;
    await owner.sql.unsafe("CREATE ROLE gateway_fixture_web LOGIN IN ROLE attention_web_runtime");
    const url = new URL(process.env.TEST_READER_DATABASE_URL!); url.username = "gateway_fixture_web";
    web = createDatabase(url.toString());
    gateway = await import("./collection-source-reader").catch(() => undefined) as typeof gateway;
    coordination = await import("./source-read-coordinator").catch(() => undefined) as typeof coordination;
  }, 120_000);
  afterAll(async () => {await web?.close(); await owner?.close();});
  beforeEach(async () => {
    await owner.sql`update collections set collection_status = 'active', moderation_status = 'clear' where id = ${collectionId}`;
    await owner.sql`update contents set community_moderation_status = 'clear', summary_status = 'pending',
      outbound_url = 'https://例子.测试:443/article', takedown_status = 'none' where id = ${contentId}`;
    // The table is introduced by the implementation; avoid hiding the initial RED behind fixture setup.
    if (coordination) await owner.sql`delete from source_read_accounts where account_id = ${accountId}`;
  });
  function fixture(revalidate = async () => principal as typeof principal | null) {
    expect(gateway).toBeDefined(); expect(coordination).toBeDefined();
    const read = vi.fn(async (request: ReadRequest, _options: {signal: AbortSignal; admissionReference: string}) => response(request));
    const context = {accountId, runId: "call-1", signal: new AbortController().signal,
      revalidate, getDatabase: () => web.db};
    const deps = {read, coordinator: coordination.createSourceReadCoordinator(web.db), memory: new coordination.SourceReadMemory()};
    return {context, deps, read};
  }
  it("rejects wrong account, missing scope and arbitrary URL below the real gateway", async () => {
    const {context, deps, read} = fixture();
    await expect(gateway.readCollectionSource({...context, accountId: randomUUID()}, input, deps)).rejects.toMatchObject({code: "permission_revoked"});
    const otherAccountId = randomUUID();
    await expect(gateway.readCollectionSource({...context, accountId: otherAccountId, revalidate: async () => ({...principal, accountId: otherAccountId})}, input, deps))
      .rejects.toMatchObject({code: "collection_not_found"});
    await expect(gateway.readCollectionSource({...context, revalidate: async () => ({...principal, scopes: []})}, input, deps)).rejects.toMatchObject({code: "permission_revoked"});
    await expect(gateway.readCollectionSource(context, {...input, url: "https://evil.test"}, deps)).rejects.toMatchObject({code: "invalid_request"});
    expect(read).not.toHaveBeenCalled();
  });
  it("does not read hidden/deleted content or reusable summaries", async () => {
    const {context, deps, read} = fixture();
    await owner.sql`update contents set community_moderation_status = 'hidden' where id = ${contentId}`;
    expect(await gateway.readCollectionSource(context, input, deps)).toMatchObject({outcome: "skipped", reason: "not_eligible"});
    await owner.sql`update contents set community_moderation_status = 'clear', summary_status = 'ready' where id = ${contentId}`;
    expect(await gateway.readCollectionSource(context, input, deps)).toMatchObject({outcome: "skipped", reason: "already_ready"});
    await owner.sql`update collections set collection_status = 'deleted' where id = ${collectionId}`;
    expect(await gateway.readCollectionSource(context, input, deps)).toMatchObject({outcome: "skipped", reason: "not_eligible"});
    expect(read).not.toHaveBeenCalled();
  });
  it.each(["hide", "source", "revoke"])("discards late evidence after %s and stops owner heartbeat", async change => {
    let active = true;
    const {context, deps, read} = fixture(async () => active ? principal : null);
    let finish!: () => void;
    const pendingRead = new Promise<void>(resolve => {finish = resolve;});
    let outboundSignal: AbortSignal | undefined;
    read.mockImplementation(async (request, options) => {outboundSignal = options.signal; await pendingRead; return response(request);});
    const pending = gateway.readCollectionSource(context, input, deps);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    if (change === "hide") await owner.sql`update contents set community_moderation_status = 'hidden' where id = ${contentId}`;
    if (change === "source") await owner.sql`update contents set outbound_url = 'https://example.test/changed' where id = ${contentId}`;
    if (change === "revoke") active = false;
    await vi.waitFor(() => expect(outboundSignal?.aborted).toBe(true), {timeout: 2500});
    finish();
    expect(await pending).not.toHaveProperty("temporary_text");
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("coalesces local duplicates, reauthorizes cache returns and correlates each invocation", async () => {
    const {context, deps, read} = fixture();
    const [first, second] = await Promise.all([
      gateway.readCollectionSource(context, input, deps),
      gateway.readCollectionSource({...context, runId: "call-2"}, input, deps),
    ]);
    expect(first).toMatchObject({outcome: "ready", request_ref: "call-1", collection_id: collectionId});
    expect(second).toMatchObject({outcome: "ready", request_ref: "call-2"});
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]![0].url).toBe("https://xn--fsqu00a.xn--0zwm56d/article");
    await owner.sql`update contents set community_moderation_status = 'hidden' where id = ${contentId}`;
    expect(await gateway.readCollectionSource(context, input, deps)).not.toHaveProperty("temporary_text");
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("discards cached text on a hidden-content decision before later re-eligibility", async () => {
    const {context, deps, read} = fixture();
    expect(await gateway.readCollectionSource(context, input, deps)).toMatchObject({outcome: "ready"});
    await owner.sql`update contents set community_moderation_status = 'hidden' where id = ${contentId}`;
    expect(await gateway.readCollectionSource(context, input, deps)).not.toHaveProperty("temporary_text");
    await owner.sql`update contents set community_moderation_status = 'clear' where id = ${contentId}`;
    expect(await gateway.readCollectionSource(context, input, deps)).toMatchObject({outcome: "ready"});
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("charges each eligible cache invocation once and denies the seventh without another outbound read", async () => {
    const {context, deps, read} = fixture();
    for (let i = 0; i < 6; i++) expect(await gateway.readCollectionSource({...context, runId: `call-${i}`}, input, deps)).toMatchObject({outcome: "ready"});
    expect(await gateway.readCollectionSource({...context, runId: "call-7"}, input, deps)).toMatchObject({
      code: "rate_limited", outcome: "failed", attempts: [], retry_after_ms: expect.any(Number)});
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("preserves actual attempt history when final principal validation rejects completed evidence", async () => {
    let active = true;
    const {context, deps, read} = fixture(async () => active ? principal : null);
    read.mockImplementation(async request => {active = false; return response(request);});
    expect(await gateway.readCollectionSource(context, input, deps)).toMatchObject({code: "permission_revoked",
      attempts: [{method: "static", duration_ms: 5}]});
  });
  it("fails closed when owner principal revalidation stalls and stops its bounded heartbeat loop", async () => {
    let checks = 0;
    const {context, deps, read} = fixture(async () => {
      checks++; if (checks === 3) return new Promise<never>(() => {}); return principal;
    });
    read.mockImplementation(async (request, options) => {
      await new Promise<void>(resolve => options.signal.addEventListener("abort", () => resolve(), {once: true}));
      return response(request);
    });
    const pending = gateway.readCollectionSource(context, input, deps);
    await vi.waitFor(() => expect(read.mock.calls[0]?.[1].signal.aborted).toBe(true), {timeout: 2500});
    expect(await pending).toMatchObject({code: "permission_revoked"});
  });
  it("lets an authorized owner finish when an independently authorized duplicate cancels", async () => {
    const {context, deps, read} = fixture();
    let finish!: () => void; const delayed = new Promise<void>(resolve => {finish = resolve;});
    read.mockImplementation(async request => {await delayed; return response(request);});
    const ownerRead = gateway.readCollectionSource(context, input, deps);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    const controller = new AbortController();
    const duplicate = gateway.readCollectionSource({...context, runId: "duplicate", signal: controller.signal}, input, deps);
    // Attach rejection observation before cancellation to avoid an unhandled test promise.
    const duplicateResult = duplicate.catch(() => null);
    controller.abort();
    expect(await duplicateResult).toBeNull();
    expect(read.mock.calls[0]![1].signal.aborted).toBe(false);
    finish(); expect(await ownerRead).toMatchObject({outcome: "ready"});
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("consumes the actual source grant through internal endpoints and rechecks Core before status", async () => {
    const {context, deps, read} = fixture();
    const secret = "s".repeat(32);
    const endpoint = (action: "consume" | "status" | "release", body: unknown) => coordination.handleReaderAdmission(
      new Request(`https://attention.test/api/internal/source-reader/${action}`, {method: "POST", body: JSON.stringify(body),
        headers: {authorization: `Bearer ${secret}`}}), action, {secret, getDatabase: () => web.db});
    read.mockImplementation(async (request, options) => {
      const body = {reference: options.admissionReference, request_ref: request.request_ref, attempt_ref: request.attempt_ref,
        source_fingerprint: createHash("sha256").update(parseAndValidateUrl(request.url, request.sourceKind).toString()).digest("hex"),
        renderer_ref: `attention-reader-${randomUUID()}`};
      expect((await endpoint("consume", {...body, source_fingerprint: "0".repeat(64)})).status).toBe(409);
      const consumed = await endpoint("consume", body); expect(consumed.status).toBe(200);
      const proof = {...body, ...await consumed.json() as {claim: string}};
      expect(await (await endpoint("status", proof)).json()).toEqual({active: true});
      let secondProof: typeof proof | undefined;
      try {
        for (let i = 0; i < 2; i++) {
          const nextAccount = randomUUID(), nextCollection = randomUUID();
          await owner.sql`insert into accounts (id, stable_handle) values (${nextAccount}, ${`slots${nextAccount}`})`;
          await owner.sql`insert into collections (id, account_id, content_id, domain_id, visibility, source_channel)
            select ${nextCollection}, ${nextAccount}, content_id, domain_id, 'private', 'web' from collections where id = ${collectionId}`;
          const identity = gateway.sourceReadIdentity(await getCollectionStatus(web.db, {accountId: nextAccount}, {collection_id: nextCollection}))!;
          const claim = await deps.coordinator.acquire({accountId: nextAccount, collectionId: nextCollection,
            operation: identity.operation, sourceFingerprint: identity.sourceFingerprint, requestRef: "r", attemptRef: "a"});
          if (!claim.allowed) throw new Error("missing test claim");
          const nextBody = {...body, reference: claim.reference, request_ref: "r", attempt_ref: "a", renderer_ref: `attention-reader-${randomUUID()}`};
          const result = await endpoint("consume", nextBody);
          if (i === 0) {expect(result.status).toBe(200); secondProof = {...nextBody, ...await result.json() as {claim: string}};}
          else {expect(result.status).toBe(429); expect(await result.json()).toEqual({code: "rate_limited", retry_after_ms: 1000});}
        }
      } finally {if (secondProof) await endpoint("release", secondProof);}
      await owner.sql`update contents set community_moderation_status = 'hidden' where id = ${contentId}`;
      expect((await endpoint("status", proof)).status).toBe(409);
      expect((await endpoint("release", {...proof, renderer_ref: `attention-reader-${randomUUID()}`})).status).toBe(409);
      expect(await (await endpoint("release", proof)).json()).toEqual({released: true});
      return response(request);
    });
    expect(await gateway.readCollectionSource(context, input, deps)).toMatchObject({code: "permission_revoked"});
    expect(read).toHaveBeenCalledTimes(1);
  });
  it.each(["web", "mcp"])("uses the same Core ownership and live credential revocation through %s", async transport => {
    const {deps, read} = fixture();
    const credential = await createApiCredential(owner.db, {accountId, name: "Synthetic reader"});
    const session = await issueSession(owner.db, {accountId});
    let finish!: () => void;
    const delayed = new Promise<void>(resolve => {finish = resolve;});
    read.mockImplementation(async request => {await delayed; return response(request);});
    const call = async (id: string) => {
      if (transport === "web") {
        const request = new Request(`https://attention.test/api/collections/${id}/source-read`, {method: "POST",
          headers: {origin: "https://attention.test"}, body: JSON.stringify({attempt_ref: "a"})});
        const result = await handleSourceReadRequest(request, id, {getDatabase: () => web.db,
          resolve: () => resolveSession(web.db, session.token), readerDependencies: deps});
        return result.json();
      }
      const initial = await resolveApiCredential(web.db, credential.key);
      if (!initial) throw new Error("credential fixture invalid");
      const registry = createAttentionToolRegistry({readCollectionSource: (context, request) => gateway.readCollectionSource(context, request, deps)} as AttentionToolCoreDependencies);
      const server = createAttentionMcpServer({...initial, getDatabase: () => web.db, requestId: "http-fixture", serviceOrigin: "https://attention.test",
        caller: {clientId: null, credentialId: credential.credentialId, credentialKind: "pat", entrypoint: "hosted_mcp"},
        revalidate: () => resolveApiCredential(web.db, credential.key)}, registry);
      const client = new Client({name: "reader-fixture", version: "1"});
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport); await client.connect(clientTransport);
      try {return (await client.callTool({name: "attention_read_collection_source", arguments: {collection_id: id, attempt_ref: "a"}})).structuredContent;}
      finally {await client.close(); await server.close();}
    };
    expect(await call(randomUUID())).toMatchObject({error: {code: "collection_not_found"}});
    expect(read).not.toHaveBeenCalled();
    const pending = call(collectionId);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    if (transport === "web") await revokeSession(owner.db, session.token);
    else await revokeApiCredential(owner.db, accountId, credential.credentialId);
    finish();
    const result = await pending;
    expect(result).not.toHaveProperty("temporary_text");
    expect(result).toMatchObject({code: "permission_revoked"});
  });
});
