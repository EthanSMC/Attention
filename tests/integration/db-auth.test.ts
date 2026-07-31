import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  collectFromWeb,
  selectCandidateFromWeb
} from "../../apps/web/src/server/collection-service";
import {
  loadMyCollections,
  loadPublicContents
} from "../../apps/web/src/server/content-queries";
import { createStubHandlers } from "../../apps/worker/src/handlers";
import {
  claimNextJob,
  deleteExpiredCandidateSets,
  failJob,
  reapExhaustedJobs
} from "../../apps/worker/src/job-repository";
import { runWorker } from "../../apps/worker/src/worker";

import {
  createInvitation,
  hashOpaqueToken,
  inspectInvitation,
  redeemInvitation,
  resolveSession,
  type InvitationError
} from "@attention/auth";
import {
  collectionEvents,
  collections,
  contentLinks,
  contents,
  createDatabase,
  deleteCollection,
  domains,
  eq,
  filterProfiles,
  inputAttempts,
  invitations,
  jobs,
  pendingCandidateSets,
  publicContentAttributionsCurrent,
  publicContentsCurrent,
  sessions,
  setCollectionVisibility,
  sql,
  upsertCollection,
  upsertContentByIdentity,
  type DatabaseHandle
} from "@attention/db";
import { migrateDatabase } from "@attention/db/migrate";

const databaseUrl = process.env.TEST_DATABASE_URL;
process.env.ATTENTION_HMAC_SECRET ??=
  "attention-integration-test-secret-at-least-32-characters";
process.env.FETCHER_BASE_URL = "http://127.0.0.1:4100";
process.env.FETCHER_SHARED_SECRET =
  "attention-fetcher-integration-secret-at-least-32-characters";

describe.skipIf(!databaseUrl)("PostgreSQL schema and auth primitives", () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    handle = createDatabase(databaseUrl!, { maxConnections: 20 });
    await migrateDatabase(handle.db);
  });

  beforeEach(async () => {
    await handle.sql.unsafe(
      "TRUNCATE TABLE accounts, contents, jobs, event_ledger RESTART IDENTITY CASCADE"
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as { url: string };
        return new Response(
          JSON.stringify({
            finalUrl: request.url,
            redirects: [],
            status: 200
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      })
    );
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await handle.close();
  });

  async function aiDomainId(): Promise<string> {
    const [domain] = await handle.db
      .select({ id: domains.id })
      .from(domains)
      .where(eq(domains.slug, "ai"));
    if (!domain) throw new Error("AI domain seed is missing");
    return domain.id;
  }

  async function createRedeemedAccount(kind: "member" | "filter", suffix: string) {
    const invitation = await createInvitation(handle.db, {
      kind,
      stableHandle: `person-${suffix}`,
      filterDisplayName: kind === "filter" ? `Filter ${suffix}` : undefined
    });
    const redeemed = await redeemInvitation(handle.db, invitation.token);
    return { invitation, redeemed };
  }

  async function principalFor(
    redeemed: Awaited<ReturnType<typeof createRedeemedAccount>>["redeemed"]
  ) {
    const principal = await resolveSession(handle.db, redeemed.session.token, {
      touch: false
    });
    if (!principal) throw new Error("Expected a resolved session principal");
    return principal;
  }

  it("collects a direct Web URL without retaining the raw submission and replays idempotently", async () => {
    const { redeemed } = await createRedeemedAccount("filter", "web-direct");
    const principal = await principalFor(redeemed);
    const selectedUrl = "https://example.org/research/agent-evals?ref=public";
    const request = {
      idempotency_key: "web-direct-idempotency",
      raw_input: `分享文案不会长期保存：${selectedUrl} 复制后打开`,
      visibility: "public" as const
    };

    const first = await collectFromWeb(handle.db, principal, request);
    expect(first).toMatchObject({
      status: "accepted",
      source: "generic_web",
      content_type: "web_page",
      current_visibility: "public"
    });

    const replay = await collectFromWeb(handle.db, principal, request);
    expect(replay).toEqual(first);

    const [attempt] = await handle.db
      .select()
      .from(inputAttempts)
      .where(eq(inputAttempts.channelMessageId, request.idempotency_key));
    expect(attempt?.inputHmac).toMatch(/^[a-f0-9]{64}$/u);
    expect(attempt?.inputHmac).not.toContain(request.raw_input);
    expect(attempt?.safeSelectedUrl).toBe(selectedUrl);
    expect(await handle.db.select().from(jobs)).toHaveLength(1);
    expect(await loadMyCollections(handle.db, principal.accountId)).toMatchObject([
      { id: first.collection_id, visibility: "public" }
    ]);
    expect(await loadPublicContents(handle.db)).toMatchObject([
      { filters: [{ handle: "person-web-direct" }] }
    ]);

    await expect(
      collectFromWeb(handle.db, principal, {
        ...request,
        raw_input: "https://example.org/a-different-article"
      })
    ).rejects.toMatchObject({ code: "idempotency_payload_mismatch", httpStatus: 409 });
  });

  it("rolls back the collection unit of work and reclaims an expired attempt lease", async () => {
    const { redeemed } = await createRedeemedAccount("filter", "web-unit-of-work");
    const principal = await principalFor(redeemed);
    const request = {
      idempotency_key: "web-unit-of-work-attempt",
      raw_input: "https://example.org/atomic-collection",
      visibility: "public" as const
    };

    await handle.sql.unsafe(`
      CREATE OR REPLACE FUNCTION attention_test_reject_job_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'attention_test_job_failure';
      END
      $$;
      CREATE TRIGGER attention_test_reject_job_insert
      BEFORE INSERT ON jobs
      FOR EACH ROW EXECUTE FUNCTION attention_test_reject_job_insert();
    `);

    try {
      await expect(collectFromWeb(handle.db, principal, request)).rejects.toBeDefined();
      expect(await handle.db.select().from(contents)).toHaveLength(0);
      expect(await handle.db.select().from(collections)).toHaveLength(0);
      expect(await handle.db.select().from(contentLinks)).toHaveLength(0);

      const [attempt] = await handle.db
        .select()
        .from(inputAttempts)
        .where(eq(inputAttempts.channelMessageId, request.idempotency_key));
      expect(attempt).toMatchObject({ status: "processing" });
      await handle.db
        .update(inputAttempts)
        .set({ leaseExpiresAt: new Date("2000-01-01T00:00:00.000Z") })
        .where(eq(inputAttempts.id, attempt!.id));

      await handle.sql.unsafe(`
        DROP TRIGGER attention_test_reject_job_insert ON jobs;
        DROP FUNCTION attention_test_reject_job_insert();
      `);

      await expect(collectFromWeb(handle.db, principal, request)).resolves.toMatchObject({
        current_visibility: "public",
        status: "accepted"
      });
      expect(await handle.db.select().from(contents)).toHaveLength(1);
      expect(await handle.db.select().from(collections)).toHaveLength(1);
      expect(await handle.db.select().from(contentLinks)).toHaveLength(1);
      expect(await handle.db.select().from(jobs)).toHaveLength(1);
    } finally {
      await handle.sql.unsafe(`
        DROP TRIGGER IF EXISTS attention_test_reject_job_insert ON jobs;
        DROP FUNCTION IF EXISTS attention_test_reject_job_insert();
      `);
    }
  });

  it("keeps the original visibility when the same Filter collects the content again", async () => {
    const { redeemed } = await createRedeemedAccount("filter", "web-duplicate");
    const principal = await principalFor(redeemed);
    const rawInput = "https://example.org/one-stable-content";

    const first = await collectFromWeb(handle.db, principal, {
      idempotency_key: "web-duplicate-private",
      raw_input: rawInput,
      visibility: "private"
    });
    expect(first).toMatchObject({ status: "accepted", current_visibility: "private" });

    const duplicate = await collectFromWeb(handle.db, principal, {
      idempotency_key: "web-duplicate-public",
      raw_input: rawInput,
      visibility: "public"
    });
    expect(duplicate).toMatchObject({
      status: "already_collected",
      current_visibility: "private"
    });
  });

  it("creates no Content for an ambiguous share until the Filter selects a candidate", async () => {
    const { redeemed } = await createRedeemedAccount("filter", "web-ambiguous");
    const principal = await principalFor(redeemed);
    const ambiguous = await collectFromWeb(handle.db, principal, {
      idempotency_key: "web-ambiguous-attempt",
      raw_input:
        "两个链接 https://example.org/first 和 https://example.net/second",
      visibility: "public"
    });
    expect(ambiguous.status).toBe("ambiguous");
    if (ambiguous.status !== "ambiguous") throw new Error("Expected ambiguity");
    expect(ambiguous.candidates).toHaveLength(2);
    expect(await handle.db.select().from(contents)).toHaveLength(0);
    expect(await handle.db.select().from(collections)).toHaveLength(0);

    const replay = await collectFromWeb(handle.db, principal, {
      idempotency_key: "web-ambiguous-attempt",
      raw_input:
        "两个链接 https://example.org/first 和 https://example.net/second",
      visibility: "public"
    });
    expect(replay).toEqual(ambiguous);

    const selected = await selectCandidateFromWeb(handle.db, principal, {
      candidate_id: ambiguous.candidates[1]!.candidate_id,
      selection_token: ambiguous.selection_token,
      visibility: "public"
    });
    expect(selected).toMatchObject({ status: "accepted", current_visibility: "public" });
    expect(await handle.db.select().from(contents)).toHaveLength(1);
    expect(await handle.db.select().from(collections)).toHaveLength(1);
    const [consumed] = await handle.db
      .select()
      .from(pendingCandidateSets)
      .where(eq(pendingCandidateSets.inputAttemptId, ambiguous.attempt_id));
    expect(consumed?.consumedAt).toBeInstanceOf(Date);
    expect(consumed?.encryptedPayload).toBe("");
    await expect(
      selectCandidateFromWeb(handle.db, principal, {
        candidate_id: ambiguous.candidates[1]!.candidate_id,
        selection_token: ambiguous.selection_token,
        visibility: "public"
      })
    ).rejects.toMatchObject({ code: "selection_expired", httpStatus: 409 });
  });

  it("clears expired ambiguous payloads and never replays their selection token", async () => {
    const { redeemed } = await createRedeemedAccount("filter", "web-expired-selection");
    const principal = await principalFor(redeemed);
    const request = {
      idempotency_key: "web-expired-selection-attempt",
      raw_input: "https://example.org/first https://example.net/second",
      visibility: "public" as const
    };
    const ambiguous = await collectFromWeb(handle.db, principal, request);
    expect(ambiguous.status).toBe("ambiguous");
    if (ambiguous.status !== "ambiguous") throw new Error("Expected ambiguity");

    const now = Date.now();
    await handle.db
      .update(pendingCandidateSets)
      .set({
        createdAt: new Date(now - 48 * 60 * 60 * 1_000),
        expiresAt: new Date(now - 24 * 60 * 60 * 1_000)
      })
      .where(eq(pendingCandidateSets.inputAttemptId, ambiguous.attempt_id));

    await expect(collectFromWeb(handle.db, principal, request)).rejects.toMatchObject({
      code: "selection_expired",
      httpStatus: 409
    });
    const [expired] = await handle.db
      .select()
      .from(pendingCandidateSets)
      .where(eq(pendingCandidateSets.inputAttemptId, ambiguous.attempt_id));
    expect(expired?.encryptedPayload).toBe("");
    await expect(
      deleteExpiredCandidateSets(handle.sql, { now: new Date() })
    ).resolves.toBe(1);
    expect(await handle.db.select().from(pendingCandidateSets)).toHaveLength(0);
    await expect(collectFromWeb(handle.db, principal, request)).rejects.toMatchObject({
      code: "selection_expired",
      httpStatus: 409
    });
  });

  it("does not consume an ambiguous selection when establishment rolls back", async () => {
    const { redeemed } = await createRedeemedAccount("filter", "selection-rollback");
    const principal = await principalFor(redeemed);
    const ambiguous = await collectFromWeb(handle.db, principal, {
      idempotency_key: "selection-rollback-attempt",
      raw_input: "https://example.org/selection-one https://example.net/selection-two",
      visibility: "public"
    });
    if (ambiguous.status !== "ambiguous") throw new Error("Expected ambiguity");

    await handle.sql.unsafe(`
      CREATE OR REPLACE FUNCTION attention_test_reject_selection_job()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'attention_test_selection_failure';
      END
      $$;
      CREATE TRIGGER attention_test_reject_selection_job
      BEFORE INSERT ON jobs
      FOR EACH ROW EXECUTE FUNCTION attention_test_reject_selection_job();
    `);

    const selection = {
      candidate_id: ambiguous.candidates[0]!.candidate_id,
      selection_token: ambiguous.selection_token,
      visibility: "public" as const
    };
    try {
      await expect(
        selectCandidateFromWeb(handle.db, principal, selection)
      ).rejects.toBeDefined();
      const [pending] = await handle.db.select().from(pendingCandidateSets);
      expect(pending?.consumedAt).toBeNull();
      expect(pending?.encryptedPayload.length).toBeGreaterThan(0);
      expect(await handle.db.select().from(contents)).toHaveLength(0);
      expect(await handle.db.select().from(collections)).toHaveLength(0);

      await handle.sql.unsafe(`
        DROP TRIGGER attention_test_reject_selection_job ON jobs;
        DROP FUNCTION attention_test_reject_selection_job();
      `);
      await expect(
        selectCandidateFromWeb(handle.db, principal, selection)
      ).resolves.toMatchObject({ status: "accepted" });
    } finally {
      await handle.sql.unsafe(`
        DROP TRIGGER IF EXISTS attention_test_reject_selection_job ON jobs;
        DROP FUNCTION IF EXISTS attention_test_reject_selection_job();
      `);
    }
  });

  it("blocks credential-like URLs but permits public Xiaohongshu share parameters", async () => {
    const { redeemed } = await createRedeemedAccount("filter", "web-safety");
    const principal = await principalFor(redeemed);

    const unsafe = await collectFromWeb(handle.db, principal, {
      idempotency_key: "web-dangerous-query",
      raw_input: "https://example.org/article?access_token=do-not-store",
      visibility: "public"
    });
    expect(unsafe).toMatchObject({ status: "unsafe", error_code: "dangerous_query" });
    expect(await handle.db.select().from(contents)).toHaveLength(0);

    const fragmentUnsafe = await collectFromWeb(handle.db, principal, {
      idempotency_key: "web-dangerous-fragment",
      raw_input: "https://example.org/callback#access_token=do-not-store",
      visibility: "public"
    });
    expect(fragmentUnsafe).toMatchObject({
      status: "unsafe",
      error_code: "dangerous_query"
    });
    expect(await handle.db.select().from(contents)).toHaveLength(0);

    const unrelatedXhsParameter = await collectFromWeb(handle.db, principal, {
      idempotency_key: "web-xhs-unrelated-path",
      raw_input:
        "https://www.xiaohongshu.com/account?xsec_token=not-a-public-content-token",
      visibility: "public"
    });
    expect(unrelatedXhsParameter).toMatchObject({
      status: "unsafe",
      error_code: "dangerous_query"
    });

    const observedXiaohongshuUrl =
      "https://www.xiaohongshu.com/explore/abc123?xsec_token=public-share&xsec_source=pc_share";
    const xiaohongshu = await collectFromWeb(handle.db, principal, {
      idempotency_key: "web-xhs-public-share",
      raw_input: observedXiaohongshuUrl,
      visibility: "public"
    });
    expect(xiaohongshu).toMatchObject({ status: "accepted", source: "xiaohongshu" });
    if (xiaohongshu.status !== "accepted") {
      throw new Error("Expected an accepted Xiaohongshu collection");
    }
    const [storedContent] = await handle.db
      .select()
      .from(contents)
      .where(eq(contents.id, xiaohongshu.content_id));
    expect(storedContent?.outboundUrl).toBe(
      "https://www.xiaohongshu.com/explore/abc123"
    );
    const [storedObservation] = await handle.db
      .select()
      .from(contentLinks)
      .where(eq(contentLinks.contentId, xiaohongshu.content_id));
    expect(storedObservation).toMatchObject({
      resolvedUrl: observedXiaohongshuUrl,
      safeSelectedUrl: observedXiaohongshuUrl
    });

    const unsupportedXiaohongshuPath = await collectFromWeb(handle.db, principal, {
      idempotency_key: "web-xhs-no-generic-fallback",
      raw_input: "https://www.xiaohongshu.com/user/profile/abc123",
      visibility: "public"
    });
    expect(unsupportedXiaohongshuPath).toMatchObject({
      status: "invalid",
      error_code: "non_content_target"
    });
    expect(await handle.db.select().from(contents)).toHaveLength(1);
  });

  it("resolves platform shortlinks only through the internal Fetcher", async () => {
    const { redeemed } = await createRedeemedAccount("filter", "web-shortlink");
    const principal = await principalFor(redeemed);
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          finalUrl: "https://www.douyin.com/video/1234567890",
          redirects: [
            {
              host: "v.douyin.com",
              pathFingerprint: "sha256:short",
              status: 302
            }
          ],
          status: 200
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      const response = await collectFromWeb(handle.db, principal, {
        idempotency_key: "web-douyin-shortlink",
        raw_input: "https://v.douyin.com/abcDEF/",
        visibility: "public"
      });
      expect(response).toMatchObject({
        status: "accepted",
        source: "douyin",
        content_type: "video"
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:4100/v1/fetch");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("claims enrichment jobs and exposes an honest unavailable state when handlers are absent", async () => {
    const { redeemed } = await createRedeemedAccount("member", "worker-stub");
    const principal = await principalFor(redeemed);
    const response = await collectFromWeb(handle.db, principal, {
      idempotency_key: "worker-stub-content",
      raw_input: "https://example.org/worker-stub-content",
      visibility: "private"
    });
    if (
      response.status !== "accepted" &&
      response.status !== "merged_with_existing_content"
    ) {
      throw new Error("Expected an established collection");
    }

    const controller = new AbortController();
    const workerPromise = runWorker({
      config: {
        baseRetryMs: 100,
        concurrency: 1,
        databaseUrl: databaseUrl!,
        leaseMs: 5_000,
        maxRetryMs: 1_000,
        pollIntervalMs: 20,
        queue: "content-enrichment",
        workerId: "integration-worker"
      },
      handle,
      handlers: createStubHandlers(),
      logger: {
        error: () => undefined,
        info: () => undefined,
        warn: () => undefined
      },
      signal: controller.signal
    });

    try {
      await vi.waitFor(
        async () => {
          const [job] = await handle.db.select().from(jobs);
          expect(job?.status).toBe("failed");
        },
        { interval: 25, timeout: 2_000 }
      );
    } finally {
      controller.abort();
      await workerPromise;
    }

    const [content] = await handle.db
      .select({
        enrichmentStatus: contents.enrichmentStatus,
        summaryStatus: contents.summaryStatus
      })
      .from(contents)
      .where(eq(contents.id, response.content_id));
    expect(content).toEqual({
      enrichmentStatus: "failed",
      summaryStatus: "unavailable"
    });
  });

  it("rolls back a terminal job transition when the matching Content update fails", async () => {
    const content = await upsertContentByIdentity(handle.db, {
      dedupeKey: "generic:v1:https://example.com/worker-atomic-failure",
      normalizedUrl: "https://example.com/worker-atomic-failure",
      outboundUrl: "https://example.com/worker-atomic-failure",
      source: "example.com",
      sourceAdapter: "generic_web",
      adapterVersion: "1"
    });
    await handle.db.insert(jobs).values({
      availableAt: new Date("2026-07-31T08:59:00.000Z"),
      idempotencyKey: `content.metadata.v1:${content.content.id}`,
      maxAttempts: 2,
      payload: { contentId: content.content.id },
      queue: "content-enrichment",
      taskType: "content.metadata.v1"
    });
    const claimed = await claimNextJob(handle.sql, {
      leaseMs: 5_000,
      now: new Date("2026-07-31T09:00:00.000Z"),
      queue: "content-enrichment",
      workerId: "atomic-failure-test"
    });
    if (!claimed) throw new Error("Expected a claimed job");

    await handle.sql.unsafe(`
      DROP TRIGGER IF EXISTS attention_test_reject_terminal_content ON contents;
      DROP FUNCTION IF EXISTS attention_test_reject_terminal_content_update();
      CREATE FUNCTION attention_test_reject_terminal_content_update()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.enrichment_status = 'failed' THEN
          RAISE EXCEPTION 'forced terminal Content update failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER attention_test_reject_terminal_content
      BEFORE UPDATE ON contents
      FOR EACH ROW EXECUTE FUNCTION attention_test_reject_terminal_content_update();
    `);

    try {
      await expect(
        failJob(handle.sql, {
          baseRetryMs: 100,
          errorCode: "terminal_test_failure",
          job: claimed,
          maxRetryMs: 1_000,
          now: new Date("2026-07-31T09:00:01.000Z"),
          retryable: false
        })
      ).rejects.toBeDefined();

      const [storedJob] = await handle.db
        .select({ lockedBy: jobs.lockedBy, status: jobs.status })
        .from(jobs)
        .where(eq(jobs.id, claimed.id));
      const [storedContent] = await handle.db
        .select({
          enrichmentStatus: contents.enrichmentStatus,
          summaryStatus: contents.summaryStatus
        })
        .from(contents)
        .where(eq(contents.id, content.content.id));
      expect(storedJob).toEqual({ lockedBy: claimed.lockedBy, status: "running" });
      expect(storedContent).toEqual({
        enrichmentStatus: "pending",
        summaryStatus: "pending"
      });
    } finally {
      await handle.sql.unsafe(`
        DROP TRIGGER IF EXISTS attention_test_reject_terminal_content ON contents;
        DROP FUNCTION IF EXISTS attention_test_reject_terminal_content_update();
      `);
    }
  });

  it("keeps Content pending when a retryable job schedules another attempt", async () => {
    const content = await upsertContentByIdentity(handle.db, {
      dedupeKey: "generic:v1:https://example.com/worker-retry",
      normalizedUrl: "https://example.com/worker-retry",
      outboundUrl: "https://example.com/worker-retry",
      source: "example.com",
      sourceAdapter: "generic_web",
      adapterVersion: "1"
    });
    await handle.db.insert(jobs).values({
      availableAt: new Date("2026-07-31T09:29:00.000Z"),
      idempotencyKey: `content.metadata.v1:${content.content.id}`,
      maxAttempts: 2,
      payload: { contentId: content.content.id },
      queue: "content-enrichment",
      taskType: "content.metadata.v1"
    });
    const claimed = await claimNextJob(handle.sql, {
      leaseMs: 5_000,
      now: new Date("2026-07-31T09:30:00.000Z"),
      queue: "content-enrichment",
      workerId: "retry-test"
    });
    if (!claimed) throw new Error("Expected a claimed job");

    const result = await failJob(handle.sql, {
      baseRetryMs: 100,
      errorCode: "retryable_test_failure",
      job: claimed,
      maxRetryMs: 1_000,
      now: new Date("2026-07-31T09:30:01.000Z"),
      random: () => 0.5,
      retryable: true
    });
    expect(result).toMatchObject({ status: "pending", updated: true });

    const [storedJob] = await handle.db
      .select({ lockedBy: jobs.lockedBy, status: jobs.status })
      .from(jobs)
      .where(eq(jobs.id, claimed.id));
    const [storedContent] = await handle.db
      .select({
        enrichmentStatus: contents.enrichmentStatus,
        summaryStatus: contents.summaryStatus
      })
      .from(contents)
      .where(eq(contents.id, content.content.id));
    expect(storedJob).toEqual({ lockedBy: null, status: "pending" });
    expect(storedContent).toEqual({
      enrichmentStatus: "pending",
      summaryStatus: "pending"
    });
  });

  it("reaps an exhausted stale job and updates its Content in the same operation", async () => {
    const content = await upsertContentByIdentity(handle.db, {
      dedupeKey: "generic:v1:https://example.com/worker-stale-reaper",
      normalizedUrl: "https://example.com/worker-stale-reaper",
      outboundUrl: "https://example.com/worker-stale-reaper",
      source: "example.com",
      sourceAdapter: "generic_web",
      adapterVersion: "1"
    });
    const staleAt = new Date("2026-07-31T10:00:00.000Z");
    const [staleJob] = await handle.db
      .insert(jobs)
      .values({
        attempts: 1,
        idempotencyKey: `content.metadata.v1:${content.content.id}`,
        lockedAt: staleAt,
        lockedBy: "crashed-worker:claim",
        maxAttempts: 1,
        payload: { contentId: content.content.id },
        queue: "content-enrichment",
        status: "running",
        taskType: "content.metadata.v1"
      })
      .returning({ id: jobs.id });
    if (!staleJob) throw new Error("Expected a stale job");

    const reaped = await reapExhaustedJobs(handle.sql, {
      leaseMs: 5_000,
      now: new Date("2026-07-31T10:00:06.000Z"),
      queue: "content-enrichment"
    });
    expect(reaped).toBe(1);

    const [storedJob] = await handle.db
      .select({
        lastErrorCode: jobs.lastErrorCode,
        lockedAt: jobs.lockedAt,
        lockedBy: jobs.lockedBy,
        status: jobs.status
      })
      .from(jobs)
      .where(eq(jobs.id, staleJob.id));
    const [storedContent] = await handle.db
      .select({
        enrichmentStatus: contents.enrichmentStatus,
        summaryStatus: contents.summaryStatus
      })
      .from(contents)
      .where(eq(contents.id, content.content.id));
    expect(storedJob).toEqual({
      lastErrorCode: "lease_expired",
      lockedAt: null,
      lockedBy: null,
      status: "failed"
    });
    expect(storedContent).toEqual({
      enrichmentStatus: "failed",
      summaryStatus: "unavailable"
    });
  });

  it("atomically deduplicates concurrent content identities", async () => {
    const input = {
      dedupeKey: "generic:v1:https://example.com/article",
      normalizedUrl: "https://example.com/article",
      outboundUrl: "https://example.com/article?utm_source=test",
      canonicalUrl: "https://example.com/article",
      source: "example.com",
      sourceAdapter: "generic_web",
      adapterVersion: "1"
    } as const;

    const results = await Promise.all(
      Array.from({ length: 24 }, () => upsertContentByIdentity(handle.db, input))
    );
    expect(new Set(results.map((result) => result.content.id))).toHaveLength(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);

    const [contentCount] = await handle.db
      .select({ value: sql<number>`count(*)::integer` })
      .from(contents);
    expect(contentCount?.value).toBe(1);
  });

  it("enforces channel idempotency in the database", async () => {
    const { redeemed } = await createRedeemedAccount("member", "input");
    const values = {
      channel: "web" as const,
      accountId: redeemed.accountId,
      channelMessageId: "web-key-1",
      payloadType: "text" as const,
      inputHmac: "a".repeat(64),
      parserVersion: "1"
    };

    await handle.db.insert(inputAttempts).values(values);
    await expect(handle.db.insert(inputAttempts).values(values)).rejects.toBeDefined();
  });

  it("stores only invite/session hashes, redeems once, and gives filters member capability", async () => {
    const created = await createInvitation(handle.db, {
      kind: "filter",
      stableHandle: "source-filter",
      filterDisplayName: "Source Filter"
    });
    const expectedInviteHash = await hashOpaqueToken(created.token);
    const [storedInvite] = await handle.db
      .select({ tokenHash: invitations.tokenHash })
      .from(invitations)
      .where(eq(invitations.id, created.invitationId));
    expect(storedInvite?.tokenHash).toBe(expectedInviteHash);
    expect(storedInvite?.tokenHash).not.toContain(created.token);

    const redemptionAttempts = await Promise.allSettled([
      redeemInvitation(handle.db, created.token),
      redeemInvitation(handle.db, created.token)
    ]);
    const fulfilled = redemptionAttempts.filter(
      (attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof redeemInvitation>>> =>
        attempt.status === "fulfilled"
    );
    const rejected = redemptionAttempts.filter(
      (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected"
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject<Partial<InvitationError>>({
      code: "invitation_already_consumed"
    });
    const redeemed = fulfilled[0]!.value;
    const principal = await resolveSession(handle.db, redeemed.session.token, { touch: false });
    expect(principal).toMatchObject({
      accountId: created.accountId,
      isFilter: true,
      isMember: true
    });

    const [storedSession] = await handle.db
      .select({ tokenHash: sessions.tokenHash })
      .from(sessions)
      .where(eq(sessions.id, redeemed.session.sessionId));
    expect(storedSession?.tokenHash).toBe(await hashOpaqueToken(redeemed.session.token));
    expect(storedSession?.tokenHash).not.toContain(redeemed.session.token);

  });

  it("previews an invitation without consuming it", async () => {
    const created = await createInvitation(handle.db, {
      kind: "member",
      stableHandle: "preview-member"
    });

    const preview = await inspectInvitation(handle.db, created.token);
    expect(preview).toMatchObject({
      accountId: created.accountId,
      kind: "member",
      stableHandle: "preview-member"
    });

    const [stored] = await handle.db
      .select({ consumedAt: invitations.consumedAt })
      .from(invitations)
      .where(eq(invitations.id, created.invitationId));
    expect(stored?.consumedAt).toBeNull();

    await expect(redeemInvitation(handle.db, created.token)).resolves.toMatchObject({
      accountId: created.accountId
    });
  });

  it("does not let a member create a public collection", async () => {
    const { redeemed } = await createRedeemedAccount("member", "member");
    const content = await upsertContentByIdentity(handle.db, {
      dedupeKey: "generic:v1:https://example.com/private",
      normalizedUrl: "https://example.com/private",
      outboundUrl: "https://example.com/private",
      source: "example.com",
      sourceAdapter: "generic_web",
      adapterVersion: "1"
    });
    const domainId = await aiDomainId();

    await expect(
      upsertCollection(handle.db, {
        accountId: redeemed.accountId,
        contentId: content.content.id,
        domainId,
        visibility: "public",
        sourceChannel: "web"
      })
    ).rejects.toMatchObject({ code: "public_requires_filter" });

    const saved = await upsertCollection(handle.db, {
      accountId: redeemed.accountId,
      contentId: content.content.id,
      domainId,
      visibility: "private",
      sourceChannel: "web"
    });
    expect(saved.collection.visibility).toBe("private");
  });

  it("keeps an active private collection private on duplicate filter submission", async () => {
    const { redeemed } = await createRedeemedAccount("filter", "duplicate");
    const content = await upsertContentByIdentity(handle.db, {
      dedupeKey: "generic:v1:https://example.com/duplicate",
      normalizedUrl: "https://example.com/duplicate",
      outboundUrl: "https://example.com/duplicate",
      source: "example.com",
      sourceAdapter: "generic_web",
      adapterVersion: "1"
    });
    const domainId = await aiDomainId();

    const first = await upsertCollection(handle.db, {
      accountId: redeemed.accountId,
      contentId: content.content.id,
      domainId,
      visibility: "private",
      sourceChannel: "web"
    });
    const duplicate = await upsertCollection(handle.db, {
      accountId: redeemed.accountId,
      contentId: content.content.id,
      domainId,
      visibility: "public",
      sourceChannel: "web"
    });

    expect(duplicate.status).toBe("already_collected");
    expect(duplicate.collection.id).toBe(first.collection.id);
    expect(duplicate.collection.visibility).toBe("private");
    expect(duplicate.collection.publicSince).toBeNull();
  });

  it("restores a deleted collection as a new cycle while retaining events", async () => {
    const { redeemed } = await createRedeemedAccount("filter", "restore");
    const content = await upsertContentByIdentity(handle.db, {
      dedupeKey: "generic:v1:https://example.com/restore",
      normalizedUrl: "https://example.com/restore",
      outboundUrl: "https://example.com/restore",
      source: "example.com",
      sourceAdapter: "generic_web",
      adapterVersion: "1"
    });
    const domainId = await aiDomainId();
    const firstAt = new Date("2026-07-31T01:00:00.000Z");
    const restoredAt = new Date("2026-07-31T02:00:00.000Z");

    const first = await upsertCollection(handle.db, {
      accountId: redeemed.accountId,
      contentId: content.content.id,
      domainId,
      visibility: "private",
      sourceChannel: "web",
      now: firstAt
    });
    await deleteCollection(handle.db, {
      accountId: redeemed.accountId,
      collectionId: first.collection.id,
      now: new Date("2026-07-31T01:30:00.000Z")
    });
    const restored = await upsertCollection(handle.db, {
      accountId: redeemed.accountId,
      contentId: content.content.id,
      domainId,
      visibility: "public",
      sourceChannel: "web",
      now: restoredAt
    });

    expect(restored.status).toBe("restored");
    expect(restored.collection.id).toBe(first.collection.id);
    expect(restored.collection.visibility).toBe("public");
    expect(restored.collection.collectedAt).toEqual(restoredAt);

    const events = await handle.db
      .select({ eventType: collectionEvents.eventType })
      .from(collectionEvents)
      .where(eq(collectionEvents.collectionId, first.collection.id));
    expect(events.map((event) => event.eventType)).toEqual(["created", "deleted", "restored"]);
  });

  it("derives the public view from current eligibility and preserves first_public_at", async () => {
    const { redeemed } = await createRedeemedAccount("filter", "public-view");
    const content = await upsertContentByIdentity(handle.db, {
      dedupeKey: "generic:v1:https://example.com/public",
      normalizedUrl: "https://example.com/public",
      outboundUrl: "https://example.com/public",
      source: "example.com",
      sourceAdapter: "generic_web",
      adapterVersion: "1"
    });
    const domainId = await aiDomainId();
    const firstPublicAt = new Date("2026-07-31T03:00:00.000Z");
    const republishedAt = new Date("2026-07-31T05:00:00.000Z");

    const created = await upsertCollection(handle.db, {
      accountId: redeemed.accountId,
      contentId: content.content.id,
      domainId,
      visibility: "public",
      sourceChannel: "web",
      now: firstPublicAt
    });
    expect(await handle.db.select().from(publicContentsCurrent)).toHaveLength(1);

    await setCollectionVisibility(handle.db, {
      accountId: redeemed.accountId,
      collectionId: created.collection.id,
      visibility: "private",
      now: new Date("2026-07-31T04:00:00.000Z")
    });
    expect(await handle.db.select().from(publicContentsCurrent)).toHaveLength(0);

    await setCollectionVisibility(handle.db, {
      accountId: redeemed.accountId,
      collectionId: created.collection.id,
      visibility: "public",
      now: republishedAt
    });
    const [publicContent] = await handle.db.select().from(publicContentsCurrent);
    expect(publicContent?.firstPublicAt).toEqual(firstPublicAt);
    const [attribution] = await handle.db
      .select()
      .from(publicContentAttributionsCurrent);
    expect(attribution).toMatchObject({
      contentId: content.content.id,
      stableHandle: "person-public-view"
    });

    await handle.db
      .update(filterProfiles)
      .set({ active: false, revokedAt: new Date("2026-07-31T06:00:00.000Z") })
      .where(eq(filterProfiles.accountId, redeemed.accountId));
    expect(await handle.db.select().from(publicContentsCurrent)).toHaveLength(0);
  });

  it("does not mark moderated content public and allows explicit recovery after filter revoke", async () => {
    const { redeemed } = await createRedeemedAccount("filter", "public-boundaries");
    const content = await upsertContentByIdentity(handle.db, {
      dedupeKey: "generic:v1:https://example.com/public-boundaries",
      normalizedUrl: "https://example.com/public-boundaries",
      outboundUrl: "https://example.com/public-boundaries",
      source: "example.com",
      sourceAdapter: "generic_web",
      adapterVersion: "1"
    });
    const domainId = await aiDomainId();
    const saved = await upsertCollection(handle.db, {
      accountId: redeemed.accountId,
      contentId: content.content.id,
      domainId,
      visibility: "private",
      sourceChannel: "web"
    });

    await handle.db
      .update(collections)
      .set({ moderationStatus: "blocked" })
      .where(eq(collections.id, saved.collection.id));
    await setCollectionVisibility(handle.db, {
      accountId: redeemed.accountId,
      collectionId: saved.collection.id,
      visibility: "public",
      now: new Date("2026-07-31T07:00:00.000Z")
    });

    const [neverPublic] = await handle.db
      .select({ firstPublicAt: contents.firstPublicAt })
      .from(contents)
      .where(eq(contents.id, content.content.id));
    expect(neverPublic?.firstPublicAt).toBeNull();
    expect(await handle.db.select().from(publicContentsCurrent)).toHaveLength(0);

    await handle.db
      .update(collections)
      .set({ moderationStatus: "clear", filterRevokedAt: new Date("2026-07-31T07:30:00.000Z") })
      .where(eq(collections.id, saved.collection.id));
    const recovered = await setCollectionVisibility(handle.db, {
      accountId: redeemed.accountId,
      collectionId: saved.collection.id,
      visibility: "public",
      now: new Date("2026-07-31T08:00:00.000Z")
    });

    expect(recovered.filterRevokedAt).toBeNull();
    expect(recovered.publicSince).toEqual(new Date("2026-07-31T08:00:00.000Z"));
    expect(await handle.db.select().from(publicContentsCurrent)).toHaveLength(1);
  });

  it("enforces owner-only collection RLS for a non-owner database role", async () => {
    const one = await createRedeemedAccount("member", "rls-one");
    const two = await createRedeemedAccount("member", "rls-two");
    const domainId = await aiDomainId();

    for (const [index, accountId] of [one.redeemed.accountId, two.redeemed.accountId].entries()) {
      const content = await upsertContentByIdentity(handle.db, {
        dedupeKey: `generic:v1:https://example.com/rls-${index}`,
        normalizedUrl: `https://example.com/rls-${index}`,
        outboundUrl: `https://example.com/rls-${index}`,
        source: "example.com",
        sourceAdapter: "generic_web",
        adapterVersion: "1"
      });
      await upsertCollection(handle.db, {
        accountId,
        contentId: content.content.id,
        domainId,
        visibility: "private",
        sourceChannel: "web"
      });
    }

    const result = await handle.sql.begin(async (transaction) => {
      await transaction.unsafe("SET LOCAL ROLE attention_web_runtime");
      const withoutContext = await transaction<{ account_id: string }[]>`
        SELECT account_id FROM collections
      `;
      await transaction`SELECT set_config('app.account_id', ${one.redeemed.accountId}, true)`;
      const withContext = await transaction<{ account_id: string }[]>`
        SELECT account_id FROM collections
      `;
      return { withContext, withoutContext };
    });

    expect(result.withoutContext).toEqual([]);
    expect(result.withContext).toEqual([{ account_id: one.redeemed.accountId }]);
  });

  it("collects and replays idempotently through the non-owner Web runtime role", async () => {
    const { redeemed } = await createRedeemedAccount("member", "runtime-replay");
    const principal = await principalFor(redeemed);
    const runtimeHandle = createDatabase(databaseUrl!, { maxConnections: 1 });
    const request = {
      idempotency_key: "runtime-role-replay",
      raw_input: "https://example.org/runtime-role-replay",
      visibility: "private" as const
    };

    try {
      await runtimeHandle.sql.unsafe("SET ROLE attention_web_runtime");
      const first = await collectFromWeb(runtimeHandle.db, principal, request);
      const replay = await collectFromWeb(runtimeHandle.db, principal, request);
      expect(replay).toEqual(first);
      expect(first).toMatchObject({
        current_visibility: "private",
        status: "accepted"
      });
    } finally {
      await runtimeHandle.sql.unsafe("RESET ROLE").catch(() => undefined);
      await runtimeHandle.close();
    }
  });
});
