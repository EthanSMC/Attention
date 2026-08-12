import {
  accounts,
  collections,
  contents,
  createDatabase,
  domains,
  eq,
  filterProfiles,
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
  summary: "A grounded shared summary.",
  tags: ["Agents", " agents ", "MCP"],
};

describe.skipIf(!databaseUrl)("content enrichment service with PostgreSQL", () => {
  let handle: DatabaseHandle;

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
      summaryStatus: "ready",
    });
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
      }),
    ).resolves.toMatchObject({
      contentId,
      status: "already_enriched",
      summaryStatus: "ready",
    });
    const [stored] = await handle.db.select().from(contents);
    expect(stored?.aiSummary).toBe(input.summary);
  });

  it("allows exactly one immutable winner under concurrent first writes", async () => {
    const submissions = await Promise.all([
      submitContentEnrichment(handle.db, { accountId }, input),
      submitContentEnrichment(handle.db, { accountId }, {
        ...input,
        idempotency_key: "enrichment-attempt-2",
        summary: "The competing grounded summary.",
        tags: ["competing"],
      }),
    ]);

    expect(submissions.map((result) => result.status).sort()).toEqual([
      "already_enriched",
      "enriched",
    ]);
    const [stored] = await handle.db.select().from(contents);
    expect([
      input.summary,
      "The competing grounded summary.",
    ]).toContain(stored?.aiSummary);
  });
});
