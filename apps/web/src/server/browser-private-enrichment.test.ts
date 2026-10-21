import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseHandle } from "@attention/db";
import { migrateDatabase } from "@attention/db/migrate";
import { createApiCredential } from "@attention/auth";
import { issueBrowserGrant, resolveBrowserGrant, savePrivateBrowserEnrichment, submitPrivateBrowserEnrichment } from "./browser-private-enrichment";
import { getCollectionStatus } from "./collection-status-service";
import { loadMyCollections, loadPublicContents } from "./content-queries";
import type { AttentionToolContext } from "./attention-tool-registry";

describe.skipIf(!process.env.TEST_BROWSER_DATABASE_URL)("dedicated browser grant and private write with real RLS", () => {
  let owner: DatabaseHandle, web: DatabaseHandle;
  const accountId = randomUUID(), otherId = randomUUID(), collectionId = randomUUID(), otherCollectionId = randomUUID(), contentId = randomUUID();
  const role = "browser_fixture_" + randomUUID().replaceAll("-", "");
  const sourceUrl = "https://mp.weixin.qq.com/s/browser-fixture-" + contentId;
  let context: AttentionToolContext;
  beforeAll(async () => {
    vi.stubEnv("ATTENTION_DEDICATED_BROWSER_ENABLED", "true");
    owner = createDatabase(process.env.TEST_BROWSER_DATABASE_URL!);
    await migrateDatabase(owner.db);
    await owner.sql`insert into accounts(id, stable_handle) values (${accountId}, ${"browser" + accountId}), (${otherId}, ${"other" + otherId})`;
    await owner.sql`insert into entitlements(account_id, source) values (${accountId}, 'admin_grant'), (${otherId}, 'admin_grant')`;
    await owner.sql`insert into contents(id, outbound_url, normalized_url, canonical_url, source)
      values (${contentId}, ${sourceUrl}, ${sourceUrl}, ${sourceUrl}, 'wechat_official_article')`;
    const [domain] = await owner.sql`select id from domains limit 1`;
    await owner.sql`insert into collections(id, account_id, content_id, domain_id, visibility, source_channel)
      values (${collectionId}, ${accountId}, ${contentId}, ${domain!.id}, 'private', 'wechat'),
      (${otherCollectionId}, ${otherId}, ${contentId}, ${domain!.id}, 'private', 'web')`;
    await owner.sql.unsafe(`CREATE ROLE ${role} LOGIN IN ROLE attention_web_runtime`);
    const url = new URL(process.env.TEST_BROWSER_DATABASE_URL!); url.username = role;
    web = createDatabase(url.toString());
    const credential = await createApiCredential(owner.db, { accountId, name: "test browser" });
    context = { accountId, caller: { clientId: null, credentialId: credential.credentialId, credentialKind: "pat", entrypoint: "hosted_mcp" },
      getDatabase: () => web.db, isMember: true, isFilter: false, scopes: ["collection:read", "collection:write"],
      revalidate: async () => ({ accountId, scopes: ["collection:read", "collection:write"], isMember: true, isFilter: false }),
      signal: new AbortController().signal, requestId: "browser-test", runId: "browser-test", serviceOrigin: "https://example.test" };
  }, 120_000);
  beforeEach(async () => {
    await owner.sql`delete from collection_private_enrichments where account_id = ${accountId}`;
    await owner.sql`delete from browser_read_grants where account_id = ${accountId}`;
    await owner.sql`update api_credentials set status = 'active', revoked_at = null where id = ${context.caller.credentialId}`;
    await owner.sql`update contents set summary_status = 'pending', ai_summary = null, outbound_url = ${sourceUrl} where id = ${contentId}`;
    await owner.sql`update collections set collection_status = 'active' where id = ${collectionId}`;
  });
  afterAll(async () => {
    await web?.close();
    if (owner) {
      await owner.sql`delete from accounts where id in (${accountId}, ${otherId})`;
      await owner.sql`delete from contents where id = ${contentId}`;
      await owner.sql.unsafe(`DROP ROLE IF EXISTS ${role}`);
      await owner.close();
    }
    vi.unstubAllEnvs();
  });
  const input = (revision: string) => ({ source_revision: revision, evidence_sha256: "a".repeat(64),
    title: "私人文章标题", summary: "从专用浏览器完整正文生成的私人摘要。", tags: ["私人"], idempotency_key: "browser-fixture-1" });
  it("resolves a scoped grant, saves once, and reads back only in the owner's collection", async () => {
    const grant = await issueBrowserGrant(context, { collection_id: collectionId });
    expect(await resolveBrowserGrant(web.db, grant.grant)).toMatchObject({ account_id: accountId, collection_id: collectionId });
    expect(await submitPrivateBrowserEnrichment(context, { ...input(grant.source_revision), grant: grant.grant })).toMatchObject({ status: "saved" });
    expect(await savePrivateBrowserEnrichment(web.db, grant.grant, input(grant.source_revision))).toMatchObject({ status: "already_saved" });
    const status = await getCollectionStatus(web.db, { accountId }, { collection_id: collectionId });
    expect(status.content).toMatchObject({ summary_status: "pending", private_enrichment: { summary_status: "ready", evidence_visibility: "account_private" } });
    expect((await loadMyCollections(web.db, accountId))[0]).toMatchObject({ title: input("").title, summary: input("").summary });
    expect(JSON.stringify(await loadMyCollections(web.db, otherId))).not.toContain(input("").summary);
    expect(JSON.stringify(await loadPublicContents(web.db))).not.toContain(input("").summary);
    const [shared] = await owner.sql`select ai_summary, summary_status from contents where id = ${contentId}`;
    expect(shared).toMatchObject({ ai_summary: null, summary_status: "pending" });
  });
  it("rejects wrong owner, arbitrary URL input, and use by another credential", async () => {
    await expect(issueBrowserGrant(context, { collection_id: otherCollectionId })).rejects.toMatchObject({ code: "collection_not_found" });
    await expect(issueBrowserGrant(context, { collection_id: collectionId, url: "http://localhost" })).rejects.toMatchObject({ code: "invalid_request" });
    const grant = await issueBrowserGrant(context, { collection_id: collectionId });
    await expect(submitPrivateBrowserEnrichment({ ...context, caller: { ...context.caller, credentialId: randomUUID() } },
      { ...input(grant.source_revision), grant: grant.grant })).rejects.toMatchObject({ code: "permission_revoked" });
    const rows = await web.sql`select * from collection_private_enrichments`;
    expect(rows).toHaveLength(0);
  });
  it.each(["revoked", "expired", "deleted", "changed"])("rejects %s authority before reading or saving", async cause => {
    const grant = await issueBrowserGrant(context, { collection_id: collectionId });
    if (cause === "revoked") await owner.sql`update api_credentials set revoked_at = now() where id = ${context.caller.credentialId}`;
    if (cause === "expired") await owner.sql`update browser_read_grants set created_at = now() - interval '40 minutes', expires_at = now() - interval '10 minutes' where account_id = ${accountId}`;
    if (cause === "deleted") await owner.sql`update collections set collection_status = 'deleted' where id = ${collectionId}`;
    if (cause === "changed") await owner.sql`update contents set outbound_url = 'https://mp.weixin.qq.com/s/changed' where id = ${contentId}`;
    await expect(resolveBrowserGrant(web.db, grant.grant)).rejects.toThrow();
    await expect(savePrivateBrowserEnrichment(web.db, grant.grant, input(grant.source_revision))).rejects.toThrow();
    expect(await owner.sql`select * from collection_private_enrichments where collection_id = ${collectionId}`).toHaveLength(0);
  });
  it("does not overwrite a prior private edit and serializes concurrent submissions", async () => {
    const grant = await issueBrowserGrant(context, { collection_id: collectionId });
    const results = await Promise.all([savePrivateBrowserEnrichment(web.db, grant.grant, input(grant.source_revision)),
      savePrivateBrowserEnrichment(web.db, grant.grant, input(grant.source_revision))]);
    expect(results.map(result => result.status).sort()).toEqual(["already_saved", "saved"]);
    await expect(savePrivateBrowserEnrichment(web.db, grant.grant, { ...input(grant.source_revision), summary: "不同摘要" }))
      .rejects.toMatchObject({ code: "write_conflict" });
  });
});
