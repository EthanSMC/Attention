import {
  accounts,
  collectionEvents,
  collections,
  contentAliases,
  contentIdentities,
  contents,
  createDatabase,
  domains,
  eq,
  eventLedger,
  filterProfiles,
  sql,
  upsertContentByIdentity,
  type DatabaseHandle,
} from "@attention/db";
import { migrateDatabase } from "@attention/db/migrate";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { submitContentEnrichment } from "./content-enrichment-service";
import type { ContentEnrichmentServiceError } from "./content-enrichment-service";

const databaseUrl = process.env.TEST_CONTENT_ENRICHMENT_DATABASE_URL;
const accountId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const filterAccountId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const foreignAccountId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const domainId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const contentId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const input = {
  content_id: contentId,
  idempotency_key: "enrichment-attempt-1",
  resolved_url: "https://example.com/final-article",
  summary: "A grounded shared summary.",
  tags: ["Agents", " agents ", "MCP"],
  title: "A grounded article title",
};

describe.skipIf(!databaseUrl)("content enrichment service with PostgreSQL", () => {
  let handle: DatabaseHandle;

  async function asWebRuntime<T>(run: (runtime: DatabaseHandle) => Promise<T>): Promise<T> {
    const runtime = createDatabase(databaseUrl!, { maxConnections: 1 });
    try {
      await runtime.sql.unsafe("SET ROLE attention_web_runtime");
      return await run(runtime);
    } finally {
      await runtime.sql.unsafe("RESET ROLE").catch(() => undefined);
      await runtime.close();
    }
  }

  beforeAll(async () => {
    handle = createDatabase(databaseUrl!, { maxConnections: 4 });
    await migrateDatabase(handle.db);
  });

  beforeEach(async () => {
    await handle.sql.unsafe(
      "TRUNCATE TABLE collections, contents, domains, accounts RESTART IDENTITY CASCADE",
    );
    await handle.db.insert(accounts).values([
      { id: accountId, stableHandle: "enrichment-member" },
      { id: filterAccountId, stableHandle: "enrichment-filter" },
      { id: foreignAccountId, stableHandle: "enrichment-foreign" },
    ]);
    await handle.db.insert(domains).values({
      active: true,
      id: domainId,
      name: "AI",
      slug: "ai",
    });
    await handle.db.insert(filterProfiles).values({
      accountId: filterAccountId,
      active: true,
      displayName: "Enrichment Filter",
    });
    await handle.db.insert(contents).values({
      canonicalUrl: "https://example.com/shared",
      contentType: "article",
      id: contentId,
      normalizedUrl: "https://example.com/shared",
      outboundUrl: "https://example.com/shared",
      source: "generic_web",
    });
    await handle.db.insert(collections).values({
      accountId,
      contentId,
      domainId,
      sourceChannel: "web",
      visibility: "private",
    });
  });

  afterAll(async () => {
    await handle.close();
  });

  it("enriches content owned through an active collection and normalizes tags", async () => {
    const shortUrl = "https://short.example/new-article";
    await handle.db.insert(contentIdentities).values({
      adapterVersion: "v1",
      contentId,
      dedupeKey: `generic_web:v1:url:${shortUrl}`,
      identityKind: "normalized",
      normalizedUrl: shortUrl,
      sourceAdapter: "generic_web",
    });
    await expect(
      submitContentEnrichment(handle.db, { accountId }, input),
    ).resolves.toEqual({
      contentId,
      status: "enriched",
      summaryStatus: "ready",
    });

    const [stored] = await handle.db.select().from(contents);
    expect(stored).toMatchObject({
      aiSummary: input.summary,
      aiTags: ["Agents", "MCP"],
      enrichmentStatus: "complete",
      outboundUrl: input.resolved_url,
      summaryStatus: "ready",
      title: input.title,
    });
    await expect(
      upsertContentByIdentity(handle.db, {
        adapterVersion: "v1",
        dedupeKey: `generic_web:v1:url:${input.resolved_url}`,
        normalizedUrl: input.resolved_url,
        outboundUrl: input.resolved_url,
        source: "generic_web",
        sourceAdapter: "generic_web",
      }),
    ).resolves.toMatchObject({
      content: { id: contentId },
      created: false,
    });
  });

  it("emits one shared summary-ready event for a WeChat collection", async () => {
    await handle.db
      .update(collections)
      .set({ sourceChannel: "wechat" })
      .where(eq(collections.accountId, accountId));

    await expect(
      asWebRuntime((runtime) =>
        submitContentEnrichment(runtime.db, { accountId }, input),
      ),
    ).resolves.toMatchObject({ status: "enriched" });

    expect(
      await handle.db
        .select({
          accountId: eventLedger.accountId,
          contentId: eventLedger.contentId,
          dedupeKey: eventLedger.dedupeKey,
          eventType: eventLedger.eventType,
          metadata: eventLedger.metadata,
          scope: eventLedger.scope,
        })
        .from(eventLedger),
    ).toEqual([
      {
        accountId: null,
        contentId,
        dedupeKey: `content.summary.ready.v1:${contentId}`,
        eventType: "content.summary.ready.v1",
        metadata: { schema_version: 1 },
        scope: "private",
      },
    ]);
  });

  it("records the short and direct identities and converges an existing account duplicate", async () => {
    const directContentId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const shortUrl = "https://short.example/article";
    const directUrl = input.resolved_url;
    await handle.db.insert(contentIdentities).values({
      adapterVersion: "v1",
      contentId,
      dedupeKey: `generic_web:v1:url:${shortUrl}`,
      identityKind: "normalized",
      normalizedUrl: shortUrl,
      sourceAdapter: "generic_web",
    });
    await handle.db.insert(contents).values({
      canonicalUrl: directUrl,
      contentType: "web_page",
      id: directContentId,
      normalizedUrl: directUrl,
      outboundUrl: directUrl,
      source: "generic_web",
    });
    await handle.db.insert(contentIdentities).values({
      adapterVersion: "v1",
      contentId: directContentId,
      dedupeKey: `generic_web:v1:url:${directUrl}`,
      identityKind: "normalized",
      normalizedUrl: directUrl,
      sourceAdapter: "generic_web",
    });
    const [directCollection] = await handle.db
      .insert(collections)
      .values({
        accountId,
        contentId: directContentId,
        domainId,
        sourceChannel: "web",
        visibility: "private",
      })
      .returning();

    await expect(
      submitContentEnrichment(handle.db, { accountId }, input),
    ).resolves.toEqual({
      contentId: directContentId,
      status: "enriched",
      summaryStatus: "ready",
    });

    const accountCollections = await handle.db
      .select({
        contentId: collections.contentId,
        id: collections.id,
        status: collections.collectionStatus,
      })
      .from(collections)
      .where(eq(collections.accountId, accountId));
    expect(accountCollections).toEqual(
      expect.arrayContaining([
        {
          contentId: directContentId,
          id: directCollection!.id,
          status: "active",
        },
        expect.objectContaining({ contentId, status: "deleted" }),
      ]),
    );
    expect(
      await handle.db
        .select({
          contentId: collectionEvents.contentId,
          eventType: collectionEvents.eventType,
          nextState: collectionEvents.nextState,
        })
        .from(collectionEvents),
    ).toContainEqual({
      contentId,
      eventType: "merged_with_existing_content",
      nextState: {
        collectionStatus: "deleted",
        mergedIntoCollectionId: directCollection!.id,
      },
    });
    expect(
      await handle.db
        .select({ dedupeKey: contentIdentities.dedupeKey })
        .from(contentIdentities),
    ).toEqual(
      expect.arrayContaining([
        { dedupeKey: `generic_web:v1:url:${shortUrl}` },
        { dedupeKey: `generic_web:v1:url:${directUrl}` },
      ]),
    );
    const [storedPrimary] = await handle.db
      .select()
      .from(contents)
      .where(eq(contents.id, directContentId));
    expect(storedPrimary).toMatchObject({
      aiSummary: input.summary,
      outboundUrl: directUrl,
      summaryStatus: "ready",
      title: input.title,
    });
  });

  it("permits only an owned safe alias through the restricted Web runtime function", async () => {
    const directContentId = "99999999-9999-4999-8999-999999999999";
    const directUrl = input.resolved_url;
    await handle.db.insert(contentIdentities).values({
      adapterVersion: "v1",
      contentId,
      dedupeKey: "generic_web:v1:url:https://short.example/runtime",
      identityKind: "normalized",
      normalizedUrl: "https://short.example/runtime",
      sourceAdapter: "generic_web",
    });
    await handle.db.insert(contents).values({
      canonicalUrl: directUrl,
      contentType: "web_page",
      id: directContentId,
      normalizedUrl: directUrl,
      outboundUrl: directUrl,
      source: "generic_web",
    });
    await handle.db.insert(contentIdentities).values({
      adapterVersion: "v1",
      contentId: directContentId,
      dedupeKey: `generic_web:v1:url:${directUrl}`,
      identityKind: "normalized",
      normalizedUrl: directUrl,
      sourceAdapter: "generic_web",
    });

    await expect(
      asWebRuntime((runtime) =>
        submitContentEnrichment(runtime.db, { accountId }, input),
      ),
    ).resolves.toEqual({
      contentId: directContentId,
      status: "enriched",
      summaryStatus: "ready",
    });

    await expect(
      asWebRuntime((runtime) =>
        runtime.db.transaction(async (tx) => {
          await tx.execute(
            sql`select set_config('app.account_id', ${foreignAccountId}, true)`,
          );
          await tx.execute(
            sql`
              select public.attention_link_owned_content_alias(
                ${contentId}::uuid,
                ${directContentId}::uuid,
                'agent_resolved_identity'
              )
            `,
          );
        }),
      ),
    ).rejects.toThrow();
    await expect(
      asWebRuntime((runtime) =>
        runtime.db.insert(contentAliases).values({
          aliasContentId: contentId,
          aliasDedupeKey: "forged-alias",
          primaryContentId: directContentId,
          reasonCode: "agent_resolved_identity",
          ruleVersion: "v1",
        }),
      ),
    ).rejects.toThrow();
  });

  it("reuses a normal user's immutable winner when a Filter collects later", async () => {
    await submitContentEnrichment(handle.db, { accountId }, input);
    await handle.db.insert(collections).values({
      accountId: filterAccountId,
      contentId,
      domainId,
      publicSince: new Date(),
      sourceChannel: "web",
      visibility: "public",
    });

    await expect(
      submitContentEnrichment(
        handle.db,
        { accountId: filterAccountId },
        {
          ...input,
          idempotency_key: "filter-enrichment-1",
          summary: "A Filter's later summary must not overwrite the winner.",
          tags: ["filter"],
          title: "A later title must not win",
          resolved_url: "https://filter.example/later",
        },
      ),
    ).resolves.toEqual({
      contentId,
      status: "already_enriched",
      summaryStatus: "ready",
    });

    const [stored] = await handle.db.select().from(contents);
    expect(stored).toMatchObject({
      aiSummary: input.summary,
      aiTags: ["Agents", "MCP"],
      outboundUrl: input.resolved_url,
      title: input.title,
    });
  });

  it("hides foreign and inactive collection ownership as not found", async () => {
    await expect(
      submitContentEnrichment(handle.db, { accountId: foreignAccountId }, input),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ContentEnrichmentServiceError>>({
        code: "content_not_found",
        httpStatus: 404,
      }),
    );

    await handle.db
      .update(collections)
      .set({ collectionStatus: "deleted" })
      .where(eq(collections.accountId, accountId));
    await expect(
      submitContentEnrichment(handle.db, { accountId }, input),
    ).rejects.toMatchObject({ code: "content_not_found", httpStatus: 404 });
  });

  it.each([
    [{ summaryStatus: "hidden" as const }, "content_enrichment_hidden"],
    [
      { contentStatus: "merged" as const, mergedIntoContentId: contentId },
      "content_not_eligible",
    ],
    [{ publicSafetyStatus: "blocked" as const }, "content_not_eligible"],
    [{ takedownStatus: "removed" as const }, "content_not_eligible"],
    [{ communityModerationStatus: "hidden" as const }, "content_not_eligible"],
  ])("rejects hidden or ineligible content: %j", async (change, code) => {
    await handle.db
      .update(contents)
      .set(change)
      .where(eq(contents.id, contentId));

    await expect(
      submitContentEnrichment(handle.db, { accountId }, input),
    ).rejects.toMatchObject({ code });
  });

  it.each(["unavailable", "failed"] as const)(
    "rejects genuine terminal %s Content without replacing it",
    async (summaryStatus) => {
      await handle.db
        .update(contents)
        .set({ enrichmentStatus: "partial", summaryStatus })
        .where(eq(contents.id, contentId));

      await expect(
        submitContentEnrichment(handle.db, { accountId }, input),
      ).rejects.toMatchObject({
        code: "content_enrichment_unavailable",
        httpStatus: 409,
      });
      const [stored] = await handle.db.select().from(contents);
      expect(stored).toMatchObject({
        aiSummary: null,
        aiTags: [],
        summaryStatus,
      });
    },
  );

  it("makes a retry successful without overwriting the first result", async () => {
    await submitContentEnrichment(handle.db, { accountId }, input);

    await expect(
      submitContentEnrichment(handle.db, { accountId }, {
        ...input,
        summary: "A changed retry payload must not overwrite the winner.",
        tags: ["changed"],
        title: "Changed title",
        resolved_url: "https://changed.example/article",
      }),
    ).resolves.toMatchObject({
      contentId,
      status: "already_enriched",
      summaryStatus: "ready",
    });
    const [stored] = await handle.db.select().from(contents);
    expect(stored).toMatchObject({
      aiSummary: input.summary,
      outboundUrl: input.resolved_url,
      title: input.title,
    });
  });

  it.each([
    "http://localhost/private",
    "https://user:secret@example.com/private",
    "https://example.com:8443/private",
  ])("rejects an unsafe Agent-resolved URL without mutating Content: %s", async (resolvedUrl) => {
    await expect(
      submitContentEnrichment(handle.db, { accountId }, {
        ...input,
        resolved_url: resolvedUrl,
      }),
    ).rejects.toMatchObject({
      code: "content_enrichment_invalid_link",
      httpStatus: 422,
    });
    const [stored] = await handle.db.select().from(contents);
    expect(stored).toMatchObject({
      aiSummary: null,
      outboundUrl: "https://example.com/shared",
      summaryStatus: "pending",
      title: null,
    });
  });

  it("allows exactly one immutable winner under concurrent first writes", async () => {
    const submissions = await Promise.all([
      submitContentEnrichment(handle.db, { accountId }, input),
      submitContentEnrichment(handle.db, { accountId }, {
        ...input,
        idempotency_key: "enrichment-attempt-2",
        summary: "The competing grounded summary.",
        tags: ["competing"],
        title: "The competing title",
        resolved_url: "https://competing.example/article",
      }),
    ]);

    expect(submissions.map((result) => result.status).sort()).toEqual([
      "already_enriched",
      "enriched",
    ]);
    const [stored] = await handle.db.select().from(contents);
    const winningRecords = [
      {
        outboundUrl: input.resolved_url,
        summary: input.summary,
        title: input.title,
      },
      {
        outboundUrl: "https://competing.example/article",
        summary: "The competing grounded summary.",
        title: "The competing title",
      },
    ];
    expect(winningRecords).toContainEqual({
      outboundUrl: stored?.outboundUrl,
      summary: stored?.aiSummary,
      title: stored?.title,
    });
  });
});
