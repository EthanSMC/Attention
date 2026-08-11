import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  Client,
  discoverOAuthServerInfo,
  exchangeAuthorization,
  type OAuthClientMetadata,
  refreshAuthorization,
  registerClient,
  startAuthorization,
  StreamableHTTPClientTransport,
} from "../../apps/web/src/test-support/mcp-sdk";
import {
  ATTENTION_MCP_OAUTH_SCOPES,
} from "@attention/contracts";
import { handleOAuthAuthorizationServerMetadataRequest } from "../../apps/web/src/app/.well-known/oauth-authorization-server/route";
import { handleMcpProtectedResourceMetadataRequest } from "../../apps/web/src/app/.well-known/oauth-protected-resource/route";
import { handleMcpRequest } from "../../apps/web/src/app/mcp/route";
import { handleOAuthRegistrationRequest } from "../../apps/web/src/app/oauth/register/route";
import { handleOAuthTokenRequest } from "../../apps/web/src/app/oauth/token/route";

import {
  collectFromWeb,
  selectCandidateFromWeb
} from "../../apps/web/src/server/collection-service";
import type { CollectionServiceError } from "../../apps/web/src/server/collection-service";
import {
  getCollectionStatus,
  updateCollectionVisibility,
} from "../../apps/web/src/server/collection-status-service";
import type { CollectionStatusServiceError } from "../../apps/web/src/server/collection-status-service";
import { recordAttentionToolAuditBestEffort } from "../../apps/web/src/server/attention-tool-audit";
import {
  findOwnedOutboundUrl,
  findPublicOutboundUrl,
  isPublicContentInsidePreview,
} from "../../apps/web/src/server/outbound";
import {
  loadAgentCandidates,
  loadMyCollections,
  loadPublicContents
} from "../../apps/web/src/server/content-queries";
import {
  pullSyncEvents,
  pushSyncMutations,
} from "../../apps/web/src/server/sync-service";
import {
  createStubHandlers,
  executeClaimedJob,
  shouldScheduleHostedAi,
} from "../../apps/worker/src/handlers";
import {
  claimNextJob,
  deleteExpiredCandidateSets,
  failJob,
  reapExhaustedJobs
} from "../../apps/worker/src/job-repository";
import { runWorker } from "../../apps/worker/src/worker";
import { createProductionHandlers } from "../../apps/worker/src/production-handlers";
import {
  claimNextDigestDelivery,
  createDigestDelivery,
  listDigestScheduleCandidates,
  loadCurrentDeliveryContext,
  reapExhaustedDigestDeliveries,
  revalidateDigestItems,
} from "../../apps/worker/src/digest-repository";
import { digestContentWindow } from "../../apps/worker/src/digest-time";
import { processDigestDelivery } from "../../apps/worker/src/digest-worker";
import type { WorkerConfig } from "../../apps/worker/src/config";
import {
  loadDigestSettings,
  updateDigestSettings,
} from "../../apps/web/src/server/digest-settings";
import {
  updateAccountProfile,
  updateAttentionId,
  type AttentionIdError,
} from "../../apps/web/src/server/account";

import {
  apiKeyScopes,
  cancelLoginChallenge,
  completeChannelPendingRequest,
  confirmChannelBindIntent,
  createApiCredential,
  createAuthorizationCode,
  createChannelBindIntent,
  createConsumerInvite,
  createInvitation,
  createLoginChallenge,
  exchangeAuthorizationCode,
  hashOpaqueToken,
  inspectInvitation,
  inspectChannelBindIntent,
  issueFilterAnnualCode,
  loadGrowthDashboard,
  loginWithPassword,
  OAuthRegistrationRateLimitError,
  prepareConsumerReferralIntent,
  recordPaidSubscriptionBound,
  recordReferralRenewalReversal,
  recordSettledReferralRenewal,
  readChannelPendingResult,
  redeemConsumerReferralRegistration,
  redeemFilterAnnualCode,
  redeemInvitation,
  registerPublicOAuthClient,
  resolveApiCredential,
  resolveChannelIdentity,
  resolveOAuthAccessToken,
  resolveSession,
  revokeApiCredential,
  revokeOAuthConnection,
  reserveRenewalPoints,
  releaseRenewalPoints,
  consumeRenewalPoints,
  setPassword,
  validateAuthorizationRequest,
  verifyLoginChallenge,
  type InvitationError
} from "@attention/auth";
import {
  accounts,
  and,
  apiCredentials,
  castModerationVote,
  collectionEvents,
  collections,
  consumerReferrals,
  contentLinks,
  contentReports,
  contents,
  createDatabase,
  deleteCollection,
  domains,
  digestEmailDeliveries,
  digestEmailDeliveryItems,
  entitlements,
  eq,
  eventLedger,
  filterProfiles,
  filterAnnualCodes,
  growthBillingEvents,
  growthTokenAttempts,
  inputAttempts,
  invitations,
  jobs,
  listModerationCourtCases,
  moderationCases,
  moderationVotes,
  membershipGrants,
  oauthClients,
  oauthConnections,
  type ModerationRepositoryError,
  pendingCandidateSets,
  publicContentAttributionsCurrent,
  publicContentsCurrent,
  pointsBalances,
  pointsLedgerEntries,
  pointsReservations,
  resolveDueModerationCases,
  sessions,
  subscriptions,
  setCollectionVisibility,
  sql,
  submitContentReport,
  upsertCollection,
  upsertContentByIdentity,
  type DatabaseHandle
} from "@attention/db";
import { migrateDatabase } from "@attention/db/migrate";

const databaseUrl = process.env.TEST_DATABASE_URL;
process.env.ATTENTION_HMAC_SECRET ??=
  "attention-integration-test-secret-at-least-32-characters";
process.env.ATTENTION_AUTH_SECRET ??=
  "attention-auth-integration-test-secret-at-least-32-characters";
process.env.ATTENTION_CHANNEL_SECRET ??=
  "attention-channel-integration-test-secret-at-least-32-characters";
process.env.FETCHER_BASE_URL = "http://127.0.0.1:4100";
process.env.FETCHER_SHARED_SECRET =
  "attention-fetcher-integration-secret-at-least-32-characters";

const oauthResources = {
  "attention-channel-runtime": "http://localhost:3000/api/runtime",
  "attention-mcp": "http://localhost:3000/mcp",
  "attention-sync": "http://localhost:3000/api/sync",
} as const;

function normalizeOAuthConnectionLabel(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLowerCase();
}

describe.skipIf(!databaseUrl)("PostgreSQL schema and auth primitives", () => {
  let handle: DatabaseHandle;

  async function disableBaselineMembership(accountId: string): Promise<void> {
    await handle.db
      .update(entitlements)
      .set({ memberEnabled: false })
      .where(
        and(
          eq(entitlements.accountId, accountId),
          eq(entitlements.source, "signup"),
        ),
      );
  }

  beforeAll(async () => {
    handle = createDatabase(databaseUrl!, { maxConnections: 20 });
    await migrateDatabase(handle.db);
  });

  beforeEach(async () => {
    await handle.sql.unsafe(
      "TRUNCATE TABLE login_challenges, password_login_attempts, channel_pending_requests, oauth_clients, accounts, contents, jobs, event_ledger RESTART IDENTITY CASCADE"
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

  afterEach(() => {
    vi.unstubAllEnvs();
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

  it("backfills adversarial historical OAuth connection names without collisions", async () => {
    const challenge = await createLoginChallenge(handle.db, {
      email: "oauth-migration-backfill@example.com",
    });
    const verified = await verifyLoginChallenge(handle.db, {
      acceptTerms: true,
      challengeId: challenge.challengeId,
      code: challenge.code,
    });

    await handle.sql.unsafe(`
      INSERT INTO oauth_clients (client_id, name, redirect_uris, allowed_scopes)
      VALUES
        ('sharedprefix-client-a', U&'\\FEFF\\0130STANBUL', '["http://127.0.0.1:43901/callback"]'::jsonb, '["profile:read"]'::jsonb),
        ('sharedprefix-client-b', U&'Greek \\03C2', '["http://127.0.0.1:43902/callback"]'::jsonb, '["profile:read"]'::jsonb),
        ('sharedprefix-client-c', 'Imported connection 00000000000000000001', '["http://127.0.0.1:43903/callback"]'::jsonb, '["profile:read"]'::jsonb),
        ('sharedprefix-client-d', E'  Ａgent\\t Name  ', '["http://127.0.0.1:43904/callback"]'::jsonb, '["profile:read"]'::jsonb)
    `);
    await handle.sql.unsafe(
      'ALTER TABLE "oauth_authorization_codes" DROP COLUMN "replacement_connection_id"',
    );
    await handle.sql.unsafe(
      'ALTER TABLE "oauth_authorization_codes" DROP COLUMN "connection_label"',
    );
    await handle.sql.unsafe(
      'ALTER TABLE "oauth_authorization_codes" DROP COLUMN "normalized_connection_label"',
    );
    await handle.sql.unsafe(
      'ALTER TABLE "oauth_access_tokens" DROP COLUMN "connection_id"',
    );
    await handle.sql.unsafe(
      'ALTER TABLE "oauth_authorization_codes" DROP COLUMN "connection_id"',
    );
    await handle.sql.unsafe(
      'ALTER TABLE "oauth_refresh_tokens" DROP COLUMN "connection_id"',
    );
    await handle.sql.unsafe('DROP TABLE "oauth_connections"');
    await handle.sql.unsafe('DROP TYPE "oauth_connection_kind"');
    await handle.sql.unsafe(
      `
        INSERT INTO oauth_authorization_codes (
          code_hash,
          account_id,
          client_id,
          redirect_uri,
          scopes,
          audience,
          code_challenge,
          expires_at,
          created_at
        )
        VALUES
          (repeat('a', 64), $1, 'sharedprefix-client-a', 'http://127.0.0.1:43901/callback', '["profile:read"]'::jsonb, 'attention-mcp', 'challenge-a', '2026-08-11 11:00:00+00', '2026-08-11 10:00:00+00'),
          (repeat('b', 64), $1, 'sharedprefix-client-b', 'http://127.0.0.1:43902/callback', '["profile:read"]'::jsonb, 'attention-mcp', 'challenge-b', '2026-08-11 11:00:00+00', '2026-08-11 10:00:00+00'),
          (repeat('c', 64), $1, 'sharedprefix-client-c', 'http://127.0.0.1:43903/callback', '["profile:read"]'::jsonb, 'attention-mcp', 'challenge-c', '2026-08-11 11:00:00+00', '2026-08-11 10:00:00+00'),
          (repeat('d', 64), $1, 'sharedprefix-client-d', 'http://127.0.0.1:43904/callback', '["profile:read"]'::jsonb, 'attention-mcp', 'challenge-d', '2026-08-11 11:00:00+00', '2026-08-11 10:00:00+00')
      `,
      [verified.accountId],
    );

    const root = resolve(import.meta.dirname, "../..");
    const migration = readFileSync(
      resolve(root, "packages/db/drizzle/0028_oauth_connection_identity.sql"),
      "utf8",
    );
    for (const statement of migration
      .split("--> statement-breakpoint")
      .map((part) => part.trim())
      .filter(Boolean)) {
      await handle.sql.unsafe(statement);
    }

    const connections = await handle.sql<
      { clientId: string; deviceName: string | null; label: string; normalizedLabel: string }[]
    >`
      SELECT
        client_id AS "clientId",
        device_name AS "deviceName",
        label,
        normalized_label AS "normalizedLabel"
      FROM oauth_connections
      WHERE account_id = ${verified.accountId}
        AND audience = 'attention-mcp'
      ORDER BY client_id
    `;
    expect(connections).toEqual([
      {
        clientId: "sharedprefix-client-a",
        deviceName: null,
        label: "Imported connection 00000000000000000001",
        normalizedLabel: "imported connection 00000000000000000001",
      },
      {
        clientId: "sharedprefix-client-b",
        deviceName: null,
        label: "Imported connection 00000000000000000002",
        normalizedLabel: "imported connection 00000000000000000002",
      },
      {
        clientId: "sharedprefix-client-c",
        deviceName: null,
        label: "Imported connection 00000000000000000003",
        normalizedLabel: "imported connection 00000000000000000003",
      },
      {
        clientId: "sharedprefix-client-d",
        deviceName: null,
        label: "Imported connection 00000000000000000004",
        normalizedLabel: "imported connection 00000000000000000004",
      },
    ]);
    expect(
      connections.map(({ label, normalizedLabel }) =>
        normalizeOAuthConnectionLabel(label) === normalizedLabel
      ),
    ).toEqual([true, true, true, true]);

    const [backfillState] = await handle.sql<
      { connectedCodes: number; distinctNames: number; totalConnections: number }[]
    >`
      SELECT
        (SELECT count(*)::integer FROM oauth_authorization_codes WHERE connection_id IS NOT NULL) AS "connectedCodes",
        count(DISTINCT normalized_label)::integer AS "distinctNames",
        count(*)::integer AS "totalConnections"
      FROM oauth_connections
      WHERE account_id = ${verified.accountId}
        AND audience = 'attention-mcp'
    `;
    expect(backfillState).toEqual({
      connectedCodes: 4,
      distinctNames: 4,
      totalConnections: 4,
    });

    const nullability = await handle.sql<{ isNullable: "YES" | "NO" }[]>`
      SELECT is_nullable AS "isNullable"
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN (
          'oauth_authorization_codes',
          'oauth_access_tokens',
          'oauth_refresh_tokens'
        )
        AND column_name = 'connection_id'
      ORDER BY table_name
    `;
    expect(nullability).toEqual([
      { isNullable: "YES" },
      { isNullable: "YES" },
      { isNullable: "YES" },
    ]);

    const [connectionForeignKeys] = await handle.sql<{ count: number }[]>`
      SELECT count(*)::integer AS count
      FROM information_schema.table_constraints AS constraints
      INNER JOIN information_schema.key_column_usage AS columns
        ON columns.constraint_schema = constraints.constraint_schema
        AND columns.constraint_name = constraints.constraint_name
      WHERE constraints.constraint_type = 'FOREIGN KEY'
        AND constraints.table_schema = 'public'
        AND constraints.table_name IN (
          'oauth_authorization_codes',
          'oauth_access_tokens',
          'oauth_refresh_tokens'
        )
        AND columns.column_name = 'connection_id'
    `;
    expect(connectionForeignKeys?.count).toBe(3);

    const [runtimePrivileges] = await handle.sql<
      { canInsert: boolean; canSelect: boolean; canUpdate: boolean }[]
    >`
      SELECT
        has_table_privilege('attention_web_runtime', 'oauth_connections', 'INSERT') AS "canInsert",
        has_table_privilege('attention_web_runtime', 'oauth_connections', 'SELECT') AS "canSelect",
        has_table_privilege('attention_web_runtime', 'oauth_connections', 'UPDATE') AS "canUpdate"
    `;
    expect(runtimePrivileges).toEqual({
      canInsert: true,
      canSelect: true,
      canUpdate: true,
    });

    await handle.sql.unsafe(
      `
        INSERT INTO oauth_authorization_codes (
          code_hash,
          account_id,
          client_id,
          redirect_uri,
          scopes,
          audience,
          code_challenge,
          expires_at,
          created_at
        )
        VALUES (
          repeat('e', 64),
          $1,
          'sharedprefix-client-a',
          'http://127.0.0.1:43901/callback',
          '["profile:read"]'::jsonb,
          'attention-mcp',
          'challenge-e',
          '2026-08-11 12:00:00+00',
          '2026-08-11 11:00:00+00'
        )
      `,
      [verified.accountId],
    );
    const [expandPhaseWrite] = await handle.sql<{ connectionId: string | null }[]>`
      SELECT connection_id AS "connectionId"
      FROM oauth_authorization_codes
      WHERE code_hash = ${"e".repeat(64)}
    `;
    expect(expandPhaseWrite?.connectionId).toBeNull();

    const intentMigration = readFileSync(
      resolve(root, "packages/db/drizzle/0029_oauth_authorization_connection_intent.sql"),
      "utf8",
    );
    for (const statement of intentMigration
      .split("--> statement-breakpoint")
      .map((part) => part.trim())
      .filter(Boolean)) {
      await handle.sql.unsafe(statement);
    }
  });

  it("rejects duplicate active OAuth connection names after normalization", async () => {
    const challenge = await createLoginChallenge(handle.db, {
      email: "oauth-connection-name@example.com",
    });
    const verified = await verifyLoginChallenge(handle.db, {
      acceptTerms: true,
      challengeId: challenge.challengeId,
      code: challenge.code,
    });
    const client = await registerPublicOAuthClient(handle.db, {
      name: "OAuth Connection Test Client",
      requesterFingerprint: "9".repeat(64),
      redirectUris: ["http://127.0.0.1:43829/callback"],
    });
    const lastAuthorizedAt = new Date();

    await handle.db.insert(oauthConnections).values({
      accountId: verified.accountId,
      audience: "attention-mcp",
      clientId: client.clientId,
      kind: "mcp",
      label: "Attention Agent",
      normalizedLabel: "attention agent",
      lastAuthorizedAt,
    });

    await expect(
      handle.db.insert(oauthConnections).values({
        accountId: verified.accountId,
        audience: "attention-mcp",
        clientId: client.clientId,
        kind: "mcp",
        label: "  ATTENTION AGENT  ",
        normalizedLabel: "attention agent",
        lastAuthorizedAt,
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  async function principalFor(
    redeemed: Awaited<ReturnType<typeof createRedeemedAccount>>["redeemed"]
  ) {
    const principal = await resolveSession(handle.db, redeemed.session.token, {
      touch: false
    });
    if (!principal) throw new Error("Expected a resolved session principal");
    return principal;
  }

  async function createEmailAccount(email: string, now: Date) {
    const challenge = await createLoginChallenge(handle.db, { email, now });
    return verifyLoginChallenge(handle.db, {
      acceptTerms: true,
      challengeId: challenge.challengeId,
      code: challenge.code,
      now,
    });
  }

  async function createActiveSubscription(input: {
    accountId: string;
    currentPeriodEnd: Date;
    currentPeriodStart: Date;
    provider: string;
    suffix: string;
  }): Promise<string> {
    const [subscription] = await handle.db
      .insert(subscriptions)
      .values({
        accountId: input.accountId,
        currentPeriodEnd: input.currentPeriodEnd,
        currentPeriodStart: input.currentPeriodStart,
        firstChargeAt: input.currentPeriodStart,
        introEligible: false,
        provider: input.provider,
        providerCustomerId: `customer-${input.suffix}`,
        providerSubscriptionId: `subscription-${input.suffix}`,
        status: "active",
      })
      .returning({ id: subscriptions.id });
    if (!subscription) throw new Error("Expected a subscription");
    return subscription.id;
  }

  async function createPublicContent(
    filterAccountId: string,
    suffix: string,
    firstPublicAt: Date,
  ) {
    const content = await upsertContentByIdentity(handle.db, {
      adapterVersion: "1",
      dedupeKey: `generic:v1:https://example.com/${suffix}`,
      normalizedUrl: `https://example.com/${suffix}`,
      outboundUrl: `https://example.com/${suffix}`,
      source: "example.com",
      sourceAdapter: "generic_web",
    });
    const collection = await upsertCollection(handle.db, {
      accountId: filterAccountId,
      contentId: content.content.id,
      domainId: await aiDomainId(),
      sourceChannel: "web",
      visibility: "private",
    });
    await setCollectionVisibility(handle.db, {
      accountId: filterAccountId,
      collectionId: collection.collection.id,
      now: firstPublicAt,
      visibility: "public",
    });
    await handle.db
      .update(contents)
      .set({
        aiSummary: `摘要 ${suffix}`,
        author: `作者 ${suffix}`,
        summaryStatus: "ready",
        title: `标题 ${suffix}`,
      })
      .where(eq(contents.id, content.content.id));
    return { collection, content };
  }

  it("creates a Member account only after email verification and allows private collection", async () => {
    const challenge = await createLoginChallenge(handle.db, {
      email: "  NEW.User@Example.com ",
      requesterFingerprint: "a".repeat(64),
      returnTo: "/collect",
    });
    expect(await handle.db.select().from(accounts)).toHaveLength(0);

    const verified = await verifyLoginChallenge(handle.db, {
      acceptTerms: true,
      challengeId: challenge.challengeId,
      code: challenge.code,
    });
    expect(verified).toMatchObject({
      accountCreated: true,
      email: "new.user@example.com",
      returnTo: "/collect",
    });
    expect(verified).not.toHaveProperty("stableHandle");
    expect(verified.displayName).toMatch(/^用户\d{9}$/u);

    const [storedAccount] = await handle.db
      .select({ stableHandle: accounts.stableHandle })
      .from(accounts)
      .where(eq(accounts.id, verified.accountId));
    expect(storedAccount?.stableHandle).toMatch(/^user-\d{9}$/u);

    const principal = await resolveSession(handle.db, verified.session.token, { touch: false });
    expect(principal).toMatchObject({ isFilter: false, isMember: true });
    const [signupEntitlement] = await handle.db
      .select({
        endsAt: entitlements.endsAt,
        memberEnabled: entitlements.memberEnabled,
        source: entitlements.source,
      })
      .from(entitlements)
      .where(eq(entitlements.accountId, verified.accountId));
    expect(signupEntitlement).toMatchObject({
      endsAt: null,
      memberEnabled: true,
      source: "signup",
    });
    const returningNow = new Date(Date.now() + 61_000);
    const returningChallenge = await createLoginChallenge(handle.db, {
      email: "new.user@example.com",
      now: returningNow,
    });
    const returningLogin = await verifyLoginChallenge(handle.db, {
      acceptTerms: false,
      challengeId: returningChallenge.challengeId,
      code: returningChallenge.code,
      now: returningNow,
    });
    expect(returningLogin.accountCreated).toBe(false);
    const collected = await collectFromWeb(handle.db, principal!, {
      idempotency_key: "free-private-collection",
      raw_input: "https://example.org/free-private",
      visibility: "private",
    });
    expect(collected).toMatchObject({ current_visibility: "private", status: "accepted" });
    await expect(collectFromWeb(handle.db, principal!, {
      idempotency_key: "free-public-collection",
      raw_input: "https://example.org/free-public",
      visibility: "public",
    })).rejects.toMatchObject<Partial<CollectionServiceError>>({ code: "filter_required", httpStatus: 403 });
  });

  it("keeps the generated handle internal and enforces Attention ID rules", async () => {
    const firstSetAt = new Date("2026-08-05T03:00:00.000Z");
    const first = await createEmailAccount("attention-id-one@example.com", firstSetAt);
    const second = await createEmailAccount(
      "attention-id-two@example.com",
      new Date(firstSetAt.getTime() + 61_000),
    );
    const [before] = await handle.db
      .select({
        attentionId: accounts.attentionId,
        stableHandle: accounts.stableHandle,
      })
      .from(accounts)
      .where(eq(accounts.id, first.accountId));
    expect(before?.attentionId).toBeNull();
    expect(before?.stableHandle).toMatch(/^user-\d{9}$/u);

    const configured = await updateAttentionId(
      handle.db,
      first.accountId,
      "  Ethan_AI  ",
      firstSetAt,
    );
    expect(configured).toMatchObject({ attentionId: "ethan_ai" });
    expect(configured.nextChangeAt).toEqual(
      new Date(firstSetAt.getTime() + 365 * 24 * 60 * 60 * 1_000),
    );

    const principal = await resolveSession(handle.db, first.session.token, {
      touch: false,
    });
    expect(principal?.attentionId).toBe("ethan_ai");
    expect(principal).not.toHaveProperty("stableHandle");

    await expect(
      updateAttentionId(
        handle.db,
        first.accountId,
        "another-id",
        new Date(firstSetAt.getTime() + 364 * 24 * 60 * 60 * 1_000),
      ),
    ).rejects.toMatchObject<Partial<AttentionIdError>>({
      code: "attention_id_cooldown",
      nextChangeAt: configured.nextChangeAt,
    });
    await expect(
      updateAttentionId(handle.db, second.accountId, "ETHAN_AI", firstSetAt),
    ).rejects.toMatchObject<Partial<AttentionIdError>>({
      code: "attention_id_taken",
    });
    await expect(
      updateAttentionId(handle.db, second.accountId, "1invalid", firstSetAt),
    ).rejects.toMatchObject<Partial<AttentionIdError>>({
      code: "invalid_attention_id",
    });

    const changed = await updateAttentionId(
      handle.db,
      first.accountId,
      "ethan-next",
      configured.nextChangeAt,
    );
    expect(changed.attentionId).toBe("ethan-next");
    const [after] = await handle.db
      .select({ stableHandle: accounts.stableHandle })
      .from(accounts)
      .where(eq(accounts.id, first.accountId));
    expect(after?.stableHandle).toBe(before?.stableHandle);
  });

  it("validates avatars and keeps account and Filter profile identity in sync", async () => {
    const account = await createEmailAccount(
      "profile-avatar@example.com",
      new Date("2026-08-05T04:00:00.000Z"),
    );
    await handle.db.insert(filterProfiles).values({
      accountId: account.accountId,
      active: true,
      displayName: "Old name",
      invitedAt: new Date("2026-08-05T04:01:00.000Z"),
      updatedAt: new Date("2026-08-05T04:01:00.000Z"),
    });
    const webpBytes = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42,
      0x50,
    ]);
    const avatarUrl = `data:image/webp;base64,${webpBytes.toString("base64")}`;

    await expect(
      updateAccountProfile(handle.db, account.accountId, {
        avatarUrl,
        displayName: "New name",
      }),
    ).resolves.toEqual({ avatarUrl, displayName: "New name" });
    expect(
      await handle.db
        .select({
          accountAvatarUrl: accounts.avatarUrl,
          accountDisplayName: accounts.displayName,
        })
        .from(accounts)
        .where(eq(accounts.id, account.accountId)),
    ).toEqual([
      { accountAvatarUrl: avatarUrl, accountDisplayName: "New name" },
    ]);
    expect(
      await handle.db
        .select({
          avatarUrl: filterProfiles.avatarUrl,
          displayName: filterProfiles.displayName,
        })
        .from(filterProfiles)
        .where(eq(filterProfiles.accountId, account.accountId)),
    ).toEqual([{ avatarUrl, displayName: "New name" }]);

    await expect(
      updateAccountProfile(handle.db, account.accountId, { avatarUrl: null }),
    ).resolves.toMatchObject({ avatarUrl: null });
    await expect(
      updateAccountProfile(handle.db, account.accountId, {
        avatarUrl: "data:image/jpeg;base64,ZmFrZS1qcGVn",
      }),
    ).rejects.toThrow("invalid_avatar_url");
    const oversized = Buffer.alloc(256 * 1024 + 1);
    oversized.set(webpBytes);
    await expect(
      updateAccountProfile(handle.db, account.accountId, {
        avatarUrl: `data:image/webp;base64,${oversized.toString("base64")}`,
      }),
    ).rejects.toThrow("invalid_avatar_url");
  });

  it("serializes concurrent email challenge starts before count-to-insert", async () => {
    const firstRuntime = createDatabase(databaseUrl!, { maxConnections: 1 });
    const secondRuntime = createDatabase(databaseUrl!, { maxConnections: 1 });
    const now = new Date("2026-08-04T12:00:00.000Z");
    try {
      await Promise.all([
        firstRuntime.sql.unsafe("SET ROLE attention_web_runtime"),
        secondRuntime.sql.unsafe("SET ROLE attention_web_runtime"),
      ]);
      const results = await Promise.allSettled([
        createLoginChallenge(firstRuntime.db, {
          email: "concurrent-otp@example.com",
          now,
          requesterFingerprint: "d".repeat(64),
        }),
        createLoginChallenge(secondRuntime.db, {
          email: "concurrent-otp@example.com",
          now,
          requesterFingerprint: "d".repeat(64),
        }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toEqual([
        expect.objectContaining({ reason: expect.objectContaining({ code: "rate_limited" }) }),
      ]);
    } finally {
      await Promise.all([
        firstRuntime.sql.unsafe("RESET ROLE").catch(() => undefined),
        secondRuntime.sql.unsafe("RESET ROLE").catch(() => undefined),
      ]);
      await Promise.all([firstRuntime.close(), secondRuntime.close()]);
    }
  });

  it("does not count cancelled undelivered challenges toward resend limits", async () => {
    const runtime = createDatabase(databaseUrl!, { maxConnections: 1 });
    const now = new Date("2026-08-06T12:00:00.000Z");
    try {
      await runtime.sql.unsafe("SET ROLE attention_web_runtime");
      for (let attempt = 0; attempt < 21; attempt += 1) {
        const cancelled = await createLoginChallenge(runtime.db, {
          email: "delivery-failed@example.com",
          now,
          requesterFingerprint: "e".repeat(64),
        });
        await cancelLoginChallenge(runtime.db, cancelled.challengeId);
      }

      await expect(
        createLoginChallenge(runtime.db, {
          email: "delivery-failed@example.com",
          now,
          requesterFingerprint: "e".repeat(64),
        }),
      ).resolves.toMatchObject({ retryAfterSeconds: 60 });
    } finally {
      await runtime.sql.unsafe("RESET ROLE").catch(() => undefined);
      await runtime.close();
    }
  });

  it("enforces the dynamic registration source quota under concurrency", async () => {
    vi.stubEnv("ATTENTION_OAUTH_REGISTRATION_SOURCE_HOURLY_LIMIT", "3");
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, (_, index) => registerPublicOAuthClient(handle.db, {
          name: `Concurrent DCR ${index}`,
          requesterFingerprint: "e".repeat(64),
          redirectUris: [`http://127.0.0.1:${44000 + index}/callback`],
        })),
      );
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(2);
      for (const rejected of results.filter((result) => result.status === "rejected")) {
        expect(rejected).toEqual(
          expect.objectContaining({
            reason: expect.any(OAuthRegistrationRateLimitError),
          }),
        );
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("serializes Consumer growth-token attempt quotas under concurrency", async () => {
    const now = new Date("2026-08-04T12:00:00.000Z");
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, () => prepareConsumerReferralIntent(handle.db, {
        email: "growth-attempt@example.com",
        now,
        requesterFingerprint: "f".repeat(64),
        token: "not-a-valid-consumer-referral-token".repeat(2),
      })),
    );
    const codes = results.map((result) =>
      result.status === "rejected"
        ? (result.reason as { code?: string }).code
        : "unexpected_success",
    );
    expect(codes.filter((code) => code === "referral_registration_unavailable"))
      .toHaveLength(20);
    expect(codes.filter((code) => code === "rate_limited")).toHaveLength(5);
  });

  it("syncs Free collections and forces first historical imports to remain private", async () => {
    const challenge = await createLoginChallenge(handle.db, { email: "sync@example.com" });
    const verified = await verifyLoginChallenge(handle.db, {
      acceptTerms: true,
      challengeId: challenge.challengeId,
      code: challenge.code,
    });
    await disableBaselineMembership(verified.accountId);
    const principal = {
      accountId: verified.accountId,
      isFilter: false,
      isMember: false,
      scopes: ["sync:read", "sync:write"],
    };
    const pushed = await pushSyncMutations(handle.db, principal, [
      {
        clientMutationId: "historical-import-001",
        historical: true,
        op: "collect",
        rawInput: "https://example.org/local-history",
        visibility: "public",
      },
      {
        clientMutationId: "private-sync-002",
        historical: false,
        op: "collect",
        rawInput: "https://example.org/new-private",
        visibility: "private",
      },
    ]);
    expect(pushed.results).toMatchObject([
      { status: "applied", result: { current_visibility: "private" } },
      { status: "applied", result: { current_visibility: "private" } },
    ]);
    await handle.db.update(contents).set({
      aiSummary: "A different Member's private derived summary",
      aiTags: ["private-derived"],
      enrichmentStatus: "complete",
      summaryStatus: "ready",
    });
    const privateCollections = await loadMyCollections(handle.db, verified.accountId);
    expect(privateCollections).toHaveLength(2);
    expect(privateCollections.every((item) =>
      item.summary === null && item.summaryStatus === "unavailable" && item.tags.length === 0
    )).toBe(true);

    const first = await pullSyncEvents(handle.db, verified.accountId, {
      cursor: null,
      limit: 1,
    });
    expect(first.has_more).toBe(true);
    expect(first.events[0]?.content.original_url).toMatch(/^https:\/\/example\.org\//u);
    expect(first.events[0]?.content).toMatchObject({
      summary: null,
      summary_status: "unavailable",
      tags: [],
    });
    const second = await pullSyncEvents(handle.db, verified.accountId, {
      cursor: first.next_cursor,
      limit: 10,
    });
    expect(second.events).toHaveLength(1);
    expect(second.has_more).toBe(false);
    expect(second.events[0]?.content).toMatchObject({
      summary: null,
      summary_status: "unavailable",
      tags: [],
    });
  });

  it("lets Free reuse derived metadata only after the canonical Content is public", async () => {
    const challenge = await createLoginChallenge(handle.db, { email: "public-reuse@example.com" });
    const verified = await verifyLoginChallenge(handle.db, {
      acceptTerms: true,
      challengeId: challenge.challengeId,
      code: challenge.code,
    });
    await disableBaselineMembership(verified.accountId);
    const freePrincipal = await resolveSession(handle.db, verified.session.token, { touch: false });
    if (!freePrincipal || freePrincipal.isMember) throw new Error("Expected a Free principal");
    const freeCollection = await collectFromWeb(handle.db, freePrincipal, {
      idempotency_key: "public-reuse-free",
      raw_input: "https://example.org/public-reuse",
      visibility: "private",
    });
    if (freeCollection.status !== "accepted" &&
      freeCollection.status !== "merged_with_existing_content") {
      throw new Error("Expected the Free collection");
    }
    await handle.db
      .update(contents)
      .set({
        aiSummary: "Publicly reusable derived summary",
        aiTags: ["public-derived"],
        enrichmentStatus: "complete",
        summaryStatus: "ready",
      })
      .where(eq(contents.id, freeCollection.content_id));
    const beforePublic = await loadMyCollections(handle.db, verified.accountId);
    expect(beforePublic[0]).toMatchObject({
      summary: null,
      summaryStatus: "unavailable",
      tags: [],
    });

    const { redeemed } = await createRedeemedAccount("filter", "public-reuse");
    const filterPrincipal = await principalFor(redeemed);
    await collectFromWeb(handle.db, filterPrincipal, {
      idempotency_key: "public-reuse-filter",
      raw_input: "https://example.org/public-reuse",
      visibility: "public",
    });
    const afterPublic = await loadMyCollections(handle.db, verified.accountId);
    expect(afterPublic[0]).toMatchObject({
      summary: "Publicly reusable derived summary",
      summaryStatus: "ready",
      tags: ["public-derived"],
    });
  });

  it("supports optional password login without changing the browser session credential", async () => {
    const challenge = await createLoginChallenge(handle.db, { email: "password@example.com" });
    const verified = await verifyLoginChallenge(handle.db, {
      acceptTerms: true,
      challengeId: challenge.challengeId,
      code: challenge.code,
    });
    await setPassword(handle.db, {
      accountId: verified.accountId,
      authenticatedAt: new Date(),
      password: "correct horse battery staple",
    });
    const passwordLogin = await loginWithPassword(handle.db, {
      email: "password@example.com",
      password: "correct horse battery staple",
      returnTo: "/mine",
    });
    expect(passwordLogin.returnTo).toBe("/mine");
    expect(passwordLogin.session.token).not.toBe(verified.session.token);
    expect(await resolveSession(handle.db, verified.session.token, { touch: false })).not.toBeNull();
    expect(await resolveSession(handle.db, passwordLogin.session.token, { touch: false })).not.toBeNull();
  });

  it("allows the web runtime role to finish a successful password login", async () => {
    const challenge = await createLoginChallenge(handle.db, {
      email: "runtime-password@example.com",
    });
    const verified = await verifyLoginChallenge(handle.db, {
      acceptTerms: true,
      challengeId: challenge.challengeId,
      code: challenge.code,
    });
    await setPassword(handle.db, {
      accountId: verified.accountId,
      authenticatedAt: new Date(),
      password: "correct horse battery staple",
    });

    const runtimeHandle = createDatabase(databaseUrl!, { maxConnections: 1 });
    try {
      await runtimeHandle.sql.unsafe("SET ROLE attention_web_runtime");
      const passwordLogin = await loginWithPassword(runtimeHandle.db, {
        email: "runtime-password@example.com",
        password: "correct horse battery staple",
        requesterFingerprint: "a".repeat(64),
      });
      expect(passwordLogin.accountId).toBe(verified.accountId);
    } finally {
      await runtimeHandle.sql.unsafe("RESET ROLE").catch(() => undefined);
      await runtimeHandle.close();
    }
  });

  it("rate-limits repeated password failures even when the final password is correct", async () => {
    const challenge = await createLoginChallenge(handle.db, { email: "password-limit@example.com" });
    const verified = await verifyLoginChallenge(handle.db, {
      acceptTerms: true,
      challengeId: challenge.challengeId,
      code: challenge.code,
    });
    await setPassword(handle.db, {
      accountId: verified.accountId,
      authenticatedAt: new Date(),
      password: "correct horse battery staple",
    });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(loginWithPassword(handle.db, {
        email: "password-limit@example.com",
        password: `incorrect password ${attempt}`,
      })).rejects.toMatchObject({ code: "invalid_credentials" });
    }
    await expect(loginWithPassword(handle.db, {
      email: "password-limit@example.com",
      password: "correct horse battery staple",
    })).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("exchanges a one-time PKCE code and revokes OAuth without revoking the website session", async () => {
    const challenge = await createLoginChallenge(handle.db, { email: "oauth@example.com" });
    const verified = await verifyLoginChallenge(handle.db, { acceptTerms: true, challengeId: challenge.challengeId, code: challenge.code });
    const verifier = "oauth-pkce-verifier-that-is-at-least-forty-three-characters-123";
    const challengeValue = createHash("sha256").update(verifier).digest("base64url");
    await expect(registerPublicOAuthClient(handle.db, {
      name: "Unsafe redirect client",
      requesterFingerprint: "a".repeat(64),
      redirectUris: ["https://client.example/callback#fragment"],
    })).rejects.toMatchObject({ code: "invalid_request" });
    const client = await registerPublicOAuthClient(handle.db, {
      name: "Attention Test Agent",
      requesterFingerprint: "b".repeat(64),
      redirectUris: ["http://127.0.0.1:43819/callback"],
    });
    const request = await validateAuthorizationRequest(handle.db, {
      clientId: client.clientId,
      codeChallenge: challengeValue,
      codeChallengeMethod: "S256",
      redirectUri: "http://127.0.0.1:43819/callback",
      resource: oauthResources["attention-mcp"],
      resources: oauthResources,
      responseType: "code",
      scope: "profile:read collection:read collection:write public:read",
      state: "test-state",
    });
    const code = await createAuthorizationCode(
      handle.db,
      verified.accountId,
      request,
      { mode: "create", label: "Integration test agent" },
    );
    await expect(exchangeAuthorizationCode(handle.db, {
      clientId: client.clientId,
      code,
      codeVerifier: verifier,
      redirectUri: request.redirectUri,
      resource: oauthResources["attention-sync"],
      resources: oauthResources,
    })).rejects.toMatchObject({ code: "invalid_target" });
    const pair = await exchangeAuthorizationCode(handle.db, {
      clientId: client.clientId,
      code,
      codeVerifier: verifier,
      redirectUri: request.redirectUri,
      resource: request.resource,
      resources: oauthResources,
    });
    await expect(exchangeAuthorizationCode(handle.db, {
      clientId: client.clientId,
      code,
      codeVerifier: verifier,
      redirectUri: request.redirectUri,
      resource: request.resource,
      resources: oauthResources,
    })).rejects.toMatchObject({ code: "invalid_grant" });
    const oauthPrincipal = await resolveOAuthAccessToken(handle.db, pair.accessToken, { audience: "attention-mcp" });
    expect(oauthPrincipal).toMatchObject({ accountId: verified.accountId, isMember: true });
    await revokeOAuthConnection(handle.db, verified.accountId, pair.connectionId);
    expect(await resolveOAuthAccessToken(handle.db, pair.accessToken, { audience: "attention-mcp" })).toBeNull();
    expect(await resolveSession(handle.db, verified.session.token, { touch: false })).not.toBeNull();
  });

  it("atomically replaces an OAuth connection and resolves concurrent name confirmation", async () => {
    const challenge = await createLoginChallenge(handle.db, {
      email: "oauth-connection-transaction@example.com",
    });
    const verified = await verifyLoginChallenge(handle.db, {
      acceptTerms: true,
      challengeId: challenge.challengeId,
      code: challenge.code,
    });
    const verifier = "oauth-connection-transaction-verifier-at-least-forty-three-characters";
    const challengeValue = createHash("sha256").update(verifier).digest("base64url");
    const client = await registerPublicOAuthClient(handle.db, {
      name: "OAuth connection transaction client",
      requesterFingerprint: "d".repeat(64),
      redirectUris: ["http://127.0.0.1:43822/callback"],
    });
    const authorization = await validateAuthorizationRequest(handle.db, {
      clientId: client.clientId,
      codeChallenge: challengeValue,
      codeChallengeMethod: "S256",
      redirectUri: "http://127.0.0.1:43822/callback",
      resource: oauthResources["attention-mcp"],
      resources: oauthResources,
      responseType: "code",
      scope: "profile:read",
    });
    const originalCode = await createAuthorizationCode(
      handle.db,
      verified.accountId,
      authorization,
      { mode: "create", label: "Office MacBook" },
    );
    const originalPair = await exchangeAuthorizationCode(handle.db, {
      clientId: client.clientId,
      code: originalCode,
      codeVerifier: verifier,
      redirectUri: authorization.redirectUri,
      resource: authorization.resource,
      resources: oauthResources,
    });
    const replacementCode = await createAuthorizationCode(
      handle.db,
      verified.accountId,
      authorization,
      {
        mode: "replace",
        label: "OFFICE MACBOOK",
        replacementConnectionId: originalPair.connectionId,
      },
    );

    await handle.sql.unsafe(`
      CREATE FUNCTION oauth_refresh_insert_failure() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'injected refresh insert failure';
      END;
      $$;
      CREATE TRIGGER oauth_refresh_insert_failure
      BEFORE INSERT ON oauth_refresh_tokens
      FOR EACH ROW EXECUTE FUNCTION oauth_refresh_insert_failure();
    `);
    try {
      await expect(exchangeAuthorizationCode(handle.db, {
        clientId: client.clientId,
        code: replacementCode,
        codeVerifier: verifier,
        redirectUri: authorization.redirectUri,
        resource: authorization.resource,
        resources: oauthResources,
      })).rejects.toThrowError(/oauth_refresh_tokens/u);
      expect(await resolveOAuthAccessToken(handle.db, originalPair.accessToken, {
        audience: "attention-mcp",
      })).not.toBeNull();
      const [originalConnection] = await handle.db
        .select({ revokedAt: oauthConnections.revokedAt })
        .from(oauthConnections)
        .where(eq(oauthConnections.id, originalPair.connectionId));
      expect(originalConnection?.revokedAt).toBeNull();
    } finally {
      await handle.sql.unsafe(`
        DROP TRIGGER oauth_refresh_insert_failure ON oauth_refresh_tokens;
        DROP FUNCTION oauth_refresh_insert_failure();
      `);
    }

    const replacementPair = await exchangeAuthorizationCode(handle.db, {
      clientId: client.clientId,
      code: replacementCode,
      codeVerifier: verifier,
      redirectUri: authorization.redirectUri,
      resource: authorization.resource,
      resources: oauthResources,
    });
    expect(replacementPair.connectionId).not.toBe(originalPair.connectionId);
    expect(await resolveOAuthAccessToken(handle.db, originalPair.accessToken, {
      audience: "attention-mcp",
    })).toBeNull();

    const concurrentCodes = await Promise.all([
      createAuthorizationCode(
        handle.db,
        verified.accountId,
        authorization,
        { mode: "create", label: "Shared desk" },
      ),
      createAuthorizationCode(
        handle.db,
        verified.accountId,
        authorization,
        { mode: "create", label: "SHARED DESK" },
      ),
    ]);
    const confirmations = await Promise.allSettled(concurrentCodes.map((code) =>
      exchangeAuthorizationCode(handle.db, {
        clientId: client.clientId,
        code,
        codeVerifier: verifier,
        redirectUri: authorization.redirectUri,
        resource: authorization.resource,
        resources: oauthResources,
      })
    ));
    expect(confirmations.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(confirmations.find(({ status }) => status === "rejected")).toMatchObject({
      reason: { message: "oauth_connection_name_conflict" },
      status: "rejected",
    });
  });

  it("rejects rather than silently dropping scopes from another OAuth audience", async () => {
    const client = await registerPublicOAuthClient(handle.db, {
      name: "Generic metadata client",
      requesterFingerprint: "c".repeat(64),
      redirectUris: ["http://127.0.0.1:43821/callback"],
    });

    await expect(
      validateAuthorizationRequest(handle.db, {
        clientId: client.clientId,
        codeChallenge: "generic-client-pkce-challenge-that-is-long-enough-123456",
        codeChallengeMethod: "S256",
        redirectUri: "http://127.0.0.1:43821/callback",
        resource: oauthResources["attention-mcp"],
        resources: oauthResources,
        responseType: "code",
        scope: "profile:read sync:read",
        state: "generic-client-state",
      }),
    ).rejects.toMatchObject({ code: "invalid_scope" });
  });

  it("does not downscope past an OAuth client's allowed scope boundary", async () => {
    const client = await registerPublicOAuthClient(handle.db, {
      name: "Restricted metadata client",
      requesterFingerprint: "d".repeat(64),
      redirectUris: ["http://127.0.0.1:43822/callback"],
    });
    await handle.db
      .update(oauthClients)
      .set({ allowedScopes: ["collection:read"] })
      .where(eq(oauthClients.clientId, client.clientId));

    await expect(validateAuthorizationRequest(handle.db, {
      clientId: client.clientId,
      codeChallenge: "restricted-client-pkce-challenge-that-is-long-enough-1",
      codeChallengeMethod: "S256",
      redirectUri: "http://127.0.0.1:43822/callback",
      resource: oauthResources["attention-mcp"],
      resources: oauthResources,
      responseType: "code",
      scope: "collection:read collection:write sync:read",
      state: "restricted-client-state",
    })).rejects.toMatchObject({ code: "invalid_scope" });
  });

  it("completes SDK DCR, RFC 8707 PKCE, token exchange, initialize, and tools/list", async () => {
    const origin = "http://localhost:3000";
    const redirectUri = "http://127.0.0.1:43820/callback";
    const scope = ATTENTION_MCP_OAUTH_SCOPES.join(" ");
    const resource = new URL(oauthResources["attention-mcp"]);
    vi.stubEnv("NEXT_PUBLIC_APP_URL", origin);
    vi.stubEnv("ATTENTION_MCP_PUBLIC_URL", oauthResources["attention-mcp"]);
    vi.stubEnv("ATTENTION_SYNC_PUBLIC_URL", oauthResources["attention-sync"]);
    vi.stubEnv(
      "ATTENTION_CHANNEL_RUNTIME_PUBLIC_URL",
      oauthResources["attention-channel-runtime"],
    );
    const clientMetadata: OAuthClientMetadata = {
      application_type: "native",
      client_name: "Attention SDK integration client",
      contacts: ["sdk-client@example.com"],
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [redirectUri],
      response_types: ["code"],
      software_id: "attention-sdk-integration-client",
      software_version: "1.0.0",
      token_endpoint_auth_method: "client_secret_post",
    };
    const routeFetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const request = new Request(input, init);
      const pathname = new URL(request.url).pathname;
      if (pathname === "/.well-known/oauth-protected-resource/mcp") {
        return new Response(null, { status: 404 });
      }
      if (pathname === "/.well-known/oauth-protected-resource") {
        return handleMcpProtectedResourceMetadataRequest(request);
      }
      if (pathname === "/.well-known/oauth-authorization-server") {
        return handleOAuthAuthorizationServerMetadataRequest(request);
      }
      if (pathname === "/oauth/register") {
        return handleOAuthRegistrationRequest(request, handle.db);
      }
      if (pathname === "/oauth/token") {
        return handleOAuthTokenRequest(request, handle.db);
      }
      throw new Error(`Unexpected OAuth test request: ${request.method} ${request.url}`);
    };

    const challenge = await createLoginChallenge(handle.db, { email: "oauth-sdk@example.com" });
    const verified = await verifyLoginChallenge(handle.db, {
      acceptTerms: true,
      challengeId: challenge.challengeId,
      code: challenge.code,
    });
    const serverInfo = await discoverOAuthServerInfo(resource, { fetchFn: routeFetch });
    if (!serverInfo.authorizationServerMetadata) {
      throw new Error("Expected OAuth authorization server metadata");
    }
    const metadata = serverInfo.authorizationServerMetadata;
    expect(serverInfo).toMatchObject({
      authorizationServerUrl: origin,
      resourceMetadata: { resource: resource.href },
    });
    const clientInformation = await registerClient(serverInfo.authorizationServerUrl, {
      clientMetadata,
      fetchFn: routeFetch,
      metadata,
      scope,
    });
    expect(clientInformation).toMatchObject({
      client_name: clientMetadata.client_name,
      token_endpoint_auth_method: "none",
    });

    const started = await startAuthorization(serverInfo.authorizationServerUrl, {
      clientInformation,
      metadata,
      redirectUrl: redirectUri,
      resource,
      scope,
      state: "sdk-state",
    });
    expect(started.authorizationUrl.searchParams.get("resource")).toBe(resource.href);
    expect(started.authorizationUrl.searchParams.has("audience")).toBe(false);
    const query = started.authorizationUrl.searchParams;
    const authorization = await validateAuthorizationRequest(handle.db, {
      clientId: query.get("client_id") ?? "",
      codeChallenge: query.get("code_challenge") ?? "",
      codeChallengeMethod: query.get("code_challenge_method") ?? "",
      redirectUri: query.get("redirect_uri") ?? "",
      resource: query.get("resource") ?? "",
      resources: oauthResources,
      responseType: query.get("response_type") ?? "",
      scope: query.get("scope") ?? "",
      state: query.get("state"),
    });
    const code = await createAuthorizationCode(
      handle.db,
      verified.accountId,
      authorization,
      { mode: "create", label: "SDK integration client" },
    );
    const tokens = await exchangeAuthorization(serverInfo.authorizationServerUrl, {
      authorizationCode: code,
      clientInformation,
      codeVerifier: started.codeVerifier,
      fetchFn: routeFetch,
      metadata,
      redirectUri,
      resource,
    });
    expect(tokens.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(await resolveOAuthAccessToken(handle.db, tokens.access_token, {
      audience: "attention-sync",
    })).toBeNull();
    if (!tokens.refresh_token) throw new Error("Expected an OAuth refresh token");
    const refreshedTokens = await refreshAuthorization(serverInfo.authorizationServerUrl, {
      clientInformation,
      fetchFn: routeFetch,
      metadata,
      refreshToken: tokens.refresh_token,
      resource,
    });
    expect(refreshedTokens.access_token).not.toBe(tokens.access_token);

    const client = new Client({ name: "attention-sdk-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(resource, {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        return handleMcpRequest(request, {
          getDatabase: () => handle.db,
          principalResolver: async (authenticatedRequest, audience) => {
            const bearer = /^Bearer ([^\s]+)$/u.exec(
              authenticatedRequest.headers.get("authorization") ?? "",
            )?.[1];
            const principal = bearer
              ? await resolveOAuthAccessToken(handle.db, bearer, { audience })
              : null;
            return principal
              ? {
                  accountId: principal.accountId,
                  clientId: principal.clientId,
                  credentialId: principal.tokenId,
                  credentialKind: "oauth",
                  isFilter: principal.isFilter,
                  isMember: principal.isMember,
                  scopes: principal.scopes,
                }
              : null;
          },
        });
      },
      requestInit: {
        headers: { Authorization: `Bearer ${refreshedTokens.access_token}` },
      },
    });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(client.getServerVersion()?.name).toBe("attention-mcp-server");
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "attention_get_my_account",
      "attention_get_membership_status",
      "attention_list_collections",
      "attention_collect_content",
      "attention_select_collection_candidate",
      "attention_get_collection_status",
      "attention_update_collection",
      "attention_list_public_content",
      "attention_search_content",
      "attention_report_content",
      "attention_get_digest_settings",
      "attention_update_digest_settings",
    ]);
    expect(
      tools.tools.every(
        (tool) => tool.inputSchema.type === "object" && tool.outputSchema?.type === "object",
      ),
    ).toBe(true);
    const account = await client.callTool({
      arguments: {
        client_context: {
          skill_id: "attention",
          skill_version: "1.4.0",
          workflow_run_id: "oauth-sdk-integration",
        },
      },
      name: "attention_get_my_account",
    });
    expect(account.isError).not.toBe(true);
    expect(account.structuredContent).toMatchObject({
      capabilities: { is_filter: false, is_member: true },
    });
    await client.close();
  });

  it("shows PAT plaintext once, resolves live rights, and revokes it independently", async () => {
    const { redeemed } = await createRedeemedAccount("member", "pat-owner");
    const credential = await createApiCredential(handle.db, {
      accountId: redeemed.accountId,
      name: "automation",
    });
    expect(credential.key).toMatch(/^att_pat_/u);
    expect(await resolveApiCredential(handle.db, credential.key)).toMatchObject({
      accountId: redeemed.accountId,
      isMember: true,
      scopes: apiKeyScopes,
    });
    // Simulate a Key created by the former basic/advanced model. Stored
    // scopes remain a security ceiling until the user rotates it.
    await handle.db
      .update(apiCredentials)
      .set({ scopes: ["collection:read"] })
      .where(eq(apiCredentials.id, credential.credentialId));
    expect(await resolveApiCredential(handle.db, credential.key)).toMatchObject({
      accountId: redeemed.accountId,
      isMember: true,
      scopes: ["collection:read"],
    });
    expect(await revokeApiCredential(handle.db, redeemed.accountId, credential.credentialId)).toBe(true);
    expect(await resolveApiCredential(handle.db, credential.key)).toBeNull();
    expect(await resolveSession(handle.db, redeemed.session.token, { touch: false })).not.toBeNull();
  });

  it("binds a channel explicitly to the current Member and exposes an encrypted resumed result", async () => {
    const { redeemed } = await createRedeemedAccount("member", "channel-owner");
    const intent = await createChannelBindIntent(handle.db, {
      action: "collect",
      appId: "wechat-official-account",
      channelMessageId: "message-001",
      provider: "wechat",
      rawInput: "https://example.org/channel-save",
      subjectId: "openid-secret-value",
    });
    expect(await inspectChannelBindIntent(handle.db, intent.bindToken)).toMatchObject({ action: "collect", provider: "wechat" });
    const resumed = await confirmChannelBindIntent(handle.db, {
      accountId: redeemed.accountId,
      token: intent.bindToken,
    });
    expect(resumed.rawInput).toBe("https://example.org/channel-save");
    expect(await resolveChannelIdentity(handle.db, {
      appId: "wechat-official-account",
      provider: "wechat",
      subjectId: "openid-secret-value",
    })).toMatchObject({ accountId: redeemed.accountId, isMember: true });
    await completeChannelPendingRequest(handle.db, resumed.pendingRequestId, { status: "accepted" });
    expect(await readChannelPendingResult(handle.db, resumed.pendingRequestId)).toEqual({
      result: { status: "accepted" },
      status: "completed",
    });
  });

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
      {
        filters: [
          {
            attentionId: null,
            displayName: "Filter web-direct",
          },
        ],
      }
    ]);

    await expect(
      collectFromWeb(handle.db, principal, {
        ...request,
        raw_input: "https://example.org/a-different-article"
      })
    ).rejects.toMatchObject({ code: "idempotency_payload_mismatch", httpStatus: 409 });
  });

  it("queries collection processing status only within the owning account", async () => {
    const { redeemed } = await createRedeemedAccount("filter", "status-owner");
    const owner = await principalFor(redeemed);
    const otherAccount = await createRedeemedAccount("member", "status-other");
    const other = await principalFor(otherAccount.redeemed);
    const collected = await collectFromWeb(handle.db, owner, {
      idempotency_key: "status-owner-collection",
      raw_input: "https://example.org/status-owner",
      visibility: "public",
    });
    if (
      collected.status !== "accepted" &&
      collected.status !== "already_collected" &&
      collected.status !== "merged_with_existing_content"
    ) {
      throw new Error("Expected an established collection");
    }

    await expect(
      getCollectionStatus(handle.db, owner, {
        attempt_id: collected.attempt_id,
      }),
    ).resolves.toMatchObject({
      attempt: {
        attempt_id: collected.attempt_id,
        next_action: "none",
        status: "accepted",
      },
      collection: {
        collection_id: collected.collection_id,
        collection_status: "active",
        effectively_public: true,
        visibility: "public",
      },
      content: {
        content_id: collected.content_id,
        enrichment_status: "pending",
        summary_status: "pending",
      },
    });

    await handle.db
      .update(contents)
      .set({ enrichmentStatus: "partial", summaryStatus: "unavailable" })
      .where(eq(contents.id, collected.content_id));
    await expect(
      getCollectionStatus(handle.db, owner, {
        collection_id: collected.collection_id,
      }),
    ).resolves.toMatchObject({
      attempt: null,
      collection: { effectively_public: true },
      content: {
        enrichment_status: "partial",
        summary_status: "unavailable",
      },
    });

    await expect(
      getCollectionStatus(handle.db, other, {
        attempt_id: collected.attempt_id,
      }),
    ).rejects.toMatchObject<Partial<CollectionStatusServiceError>>({
      code: "attempt_not_found",
      httpStatus: 404,
    });
    await expect(
      getCollectionStatus(handle.db, other, {
        collection_id: collected.collection_id,
      }),
    ).rejects.toMatchObject<Partial<CollectionStatusServiceError>>({
      code: "collection_not_found",
      httpStatus: 404,
    });
  });

  it("updates visibility idempotently and maps repository permissions to stable errors", async () => {
    const { redeemed } = await createRedeemedAccount("filter", "status-update");
    const filter = await principalFor(redeemed);
    const collected = await collectFromWeb(handle.db, filter, {
      idempotency_key: "status-update-private",
      raw_input: "https://example.org/status-update",
      visibility: "private",
    });
    if (
      collected.status !== "accepted" &&
      collected.status !== "already_collected" &&
      collected.status !== "merged_with_existing_content"
    ) {
      throw new Error("Expected an established collection");
    }

    const first = await updateCollectionVisibility(handle.db, filter, {
      collection_id: collected.collection_id,
      visibility: "public",
    });
    expect(first).toMatchObject({
      collection_id: collected.collection_id,
      effectively_public: true,
      visibility: "public",
    });
    const eventsAfterFirst = await handle.db
      .select()
      .from(collectionEvents)
      .where(eq(collectionEvents.collectionId, collected.collection_id));
    const [contentAfterFirst] = await handle.db
      .select({ visibilityVersion: contents.visibilityVersion })
      .from(contents)
      .where(eq(contents.id, collected.content_id));

    const replay = await updateCollectionVisibility(handle.db, filter, {
      collection_id: collected.collection_id,
      visibility: "public",
    });
    expect(replay).toEqual(first);
    const eventsAfterReplay = await handle.db
      .select()
      .from(collectionEvents)
      .where(eq(collectionEvents.collectionId, collected.collection_id));
    const [contentAfterReplay] = await handle.db
      .select({ visibilityVersion: contents.visibilityVersion })
      .from(contents)
      .where(eq(contents.id, collected.content_id));
    expect(eventsAfterReplay).toHaveLength(eventsAfterFirst.length);
    expect(contentAfterReplay?.visibilityVersion).toBe(
      contentAfterFirst?.visibilityVersion,
    );

    const memberAccount = await createRedeemedAccount("member", "status-member");
    const member = await principalFor(memberAccount.redeemed);
    const memberCollection = await collectFromWeb(handle.db, member, {
      idempotency_key: "status-member-private",
      raw_input: "https://example.org/status-member",
      visibility: "private",
    });
    if (
      memberCollection.status !== "accepted" &&
      memberCollection.status !== "already_collected" &&
      memberCollection.status !== "merged_with_existing_content"
    ) {
      throw new Error("Expected an established member collection");
    }
    await expect(
      updateCollectionVisibility(handle.db, member, {
        collection_id: memberCollection.collection_id,
        visibility: "public",
      }),
    ).rejects.toMatchObject<Partial<CollectionStatusServiceError>>({
      code: "filter_required",
      httpStatus: 403,
    });

    await updateCollectionVisibility(handle.db, filter, {
      collection_id: collected.collection_id,
      visibility: "private",
    });
    await handle.db
      .update(filterProfiles)
      .set({ active: false, revokedAt: new Date() })
      .where(eq(filterProfiles.accountId, filter.accountId));
    await expect(
      updateCollectionVisibility(handle.db, filter, {
        collection_id: collected.collection_id,
        visibility: "public",
      }),
    ).rejects.toMatchObject<Partial<CollectionStatusServiceError>>({
      code: "filter_required",
      httpStatus: 403,
    });

    await deleteCollection(handle.db, {
      accountId: filter.accountId,
      collectionId: collected.collection_id,
    });
    await expect(
      updateCollectionVisibility(handle.db, filter, {
        collection_id: collected.collection_id,
        visibility: "private",
      }),
    ).rejects.toMatchObject<Partial<CollectionStatusServiceError>>({
      code: "collection_deleted",
      httpStatus: 409,
    });
  });

  it("allows only owner-scoped tool audit envelopes through the Web runtime", async () => {
    const first = await createRedeemedAccount("member", "audit-owner");
    const second = await createRedeemedAccount("member", "audit-other");
    const runtimeHandle = createDatabase(databaseUrl!, { maxConnections: 1 });
    try {
      await runtimeHandle.sql.unsafe("SET ROLE attention_web_runtime");
      await recordAttentionToolAuditBestEffort(runtimeHandle.db, {
        accountId: first.redeemed.accountId,
        clientId: "attention-test-client",
        contractVersion: "1.0.0",
        credentialId: "00000000-0000-4000-8000-000000000010",
        credentialKind: "oauth",
        durationMs: 12,
        entitlementTier: "member",
        entrypoint: "hosted_mcp",
        outcome: "success",
        reportedSkillId: "attention",
        reportedSkillVersion: "1.0.0",
        reportedWorkflowId: "audit-workflow-1",
        requestId: "00000000-0000-4000-8000-000000000011",
        resultStatus: "accepted",
        toolName: "attention_collect_content",
      });

      await expect(
        runtimeHandle.db.transaction(async (tx) => {
          await tx.execute(
            sql`select set_config('app.account_id', ${first.redeemed.accountId}, true)`,
          );
          await tx.insert(eventLedger).values({
            accountId: second.redeemed.accountId,
            eventType: "agent.tool_call.v1",
            metadata: {},
            requestId: "cross-account-audit",
            scope: "private",
          });
        }),
      ).rejects.toThrow();
      await expect(
        runtimeHandle.db.transaction(async (tx) => {
          await tx.execute(
            sql`select set_config('app.account_id', ${first.redeemed.accountId}, true)`,
          );
          await tx.insert(eventLedger).values({
            accountId: first.redeemed.accountId,
            eventType: "forged.event",
            metadata: {},
            requestId: "wrong-event-audit",
            scope: "private",
          });
        }),
      ).rejects.toThrow();
    } finally {
      await runtimeHandle.sql.unsafe("RESET ROLE").catch(() => undefined);
      await runtimeHandle.close();
    }

    await expect(
      handle.db
        .select({ accountId: eventLedger.accountId })
        .from(eventLedger),
    ).resolves.toEqual([{ accountId: first.redeemed.accountId }]);
  });

  it("collects a safe direct link when Fetcher is temporarily unavailable without degrading short or unsafe links", async () => {
    const { redeemed } = await createRedeemedAccount("member", "fetch-fallback");
    const principal = await principalFor(redeemed);
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("temporary fetcher outage");
    }));

    const direct = await collectFromWeb(handle.db, principal, {
      idempotency_key: "fetch-fallback-direct",
      raw_input: "https://mp.weixin.qq.com/s/fixtureArticle123",
      visibility: "private",
    });
    expect(direct).toMatchObject({
      current_visibility: "private",
      status: "accepted",
    });
    if (
      direct.status !== "accepted" &&
      direct.status !== "already_collected" &&
      direct.status !== "merged_with_existing_content"
    ) {
      throw new Error("Expected direct fallback collection");
    }
    const [fallbackLink] = await handle.db
      .select({ resolutionStatus: contentLinks.resolutionStatus })
      .from(contentLinks)
      .where(eq(contentLinks.inputAttemptId, direct.attempt_id));
    const [fallbackContent] = await handle.db
      .select({ enrichmentStatus: contents.enrichmentStatus })
      .from(contents)
      .where(eq(contents.id, direct.content_id));
    expect(fallbackLink?.resolutionStatus).toBe("pending");
    expect(fallbackContent?.enrichmentStatus).toBe("partial");

    const genericDirect = await collectFromWeb(handle.db, principal, {
      idempotency_key: "fetch-fallback-generic-direct",
      raw_input: "https://example.org/direct-content",
      visibility: "private",
    });
    expect(genericDirect).toMatchObject({ status: "resolution_pending" });

    const shortLink = await collectFromWeb(handle.db, principal, {
      idempotency_key: "fetch-fallback-shortlink",
      raw_input: "https://v.douyin.com/example",
      visibility: "private",
    });
    expect(shortLink).toMatchObject({ status: "resolution_pending" });

    const genericShortLink = await collectFromWeb(handle.db, principal, {
      idempotency_key: "fetch-fallback-generic-shortlink",
      raw_input: "https://bit.ly/example",
      visibility: "private",
    });
    expect(genericShortLink).toMatchObject({ status: "resolution_pending" });

    const sensitiveQuery = await collectFromWeb(handle.db, principal, {
      idempotency_key: "fetch-fallback-sensitive-query",
      raw_input: "https://example.org/private?auth=secret",
      visibility: "private",
    });
    expect(sensitiveQuery).toMatchObject({ status: "unsafe" });

    const unsupportedPort = await collectFromWeb(handle.db, principal, {
      idempotency_key: "fetch-fallback-unsupported-port",
      raw_input: "https://example.org:8080/private",
      visibility: "private",
    });
    expect(unsupportedPort).toMatchObject({ status: "unsafe" });

    const unsafe = await collectFromWeb(handle.db, principal, {
      idempotency_key: "fetch-fallback-unsafe",
      raw_input: "http://localhost/private",
      visibility: "private",
    });
    expect(unsafe).toMatchObject({ status: "unsafe" });
    expect(await handle.db.select().from(collections)).toHaveLength(1);
  });

  it("keeps the 20-card public preview and outbound gate deterministic for timestamp ties", async () => {
    const { redeemed } = await createRedeemedAccount("filter", "preview-ties");
    const firstPublicAt = new Date("2026-08-04T12:30:00.000Z");
    for (let index = 0; index < 21; index += 1) {
      await createPublicContent(redeemed.accountId, `preview-tie-${index}`, firstPublicAt);
    }

    const ordered = await loadPublicContents(handle.db);
    expect(ordered).toHaveLength(21);
    expect(ordered.map((item) => item.id)).toEqual(
      [...ordered.map((item) => item.id)].sort((left, right) => right.localeCompare(left)),
    );
    await expect(isPublicContentInsidePreview(handle.db, ordered[19]!.id)).resolves.toBe(true);
    await expect(isPublicContentInsidePreview(handle.db, ordered[20]!.id)).resolves.toBe(false);
    await expect(isPublicContentInsidePreview(handle.db, ordered[20]!.id)).resolves.toBe(false);
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
      "https://www.xiaohongshu.com/explore/abc123" +
      "?app_platform=ios&shareRedId=tracking" +
      "&xsec_token=public-share&xsec_source=pc_share";
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
      "https://www.xiaohongshu.com/explore/abc123" +
        "?xsec_source=pc_share&xsec_token=public-share"
    );
    const [storedObservation] = await handle.db
      .select()
      .from(contentLinks)
      .where(eq(contentLinks.contentId, xiaohongshu.content_id));
    expect(storedObservation).toMatchObject({
      resolvedUrl: observedXiaohongshuUrl,
      safeSelectedUrl: observedXiaohongshuUrl
    });

    const refreshedXiaohongshuUrl =
      "https://www.xiaohongshu.com/discovery/item/abc123" +
      "?xsec_source=pc_share&xsec_token=refreshed-public-share";
    const refreshedXiaohongshu = await collectFromWeb(handle.db, principal, {
      idempotency_key: "web-xhs-public-share-refresh",
      raw_input: refreshedXiaohongshuUrl,
      visibility: "public"
    });
    expect(refreshedXiaohongshu).toMatchObject({
      status: "already_collected",
      source: "xiaohongshu"
    });
    const [refreshedContent] = await handle.db
      .select()
      .from(contents)
      .where(eq(contents.id, xiaohongshu.content_id));
    expect(refreshedContent?.outboundUrl).toBe(
      "https://www.xiaohongshu.com/explore/abc123" +
        "?xsec_source=pc_share&xsec_token=refreshed-public-share"
    );

    await handle.db
      .update(contentLinks)
      .set({ observedAt: new Date("2026-08-10T00:00:00.000Z") })
      .where(eq(contentLinks.resolvedUrl, observedXiaohongshuUrl));
    await handle.db
      .update(contents)
      .set({
        aiSummary: "broken summary",
        aiTags: ["broken"],
        enrichmentStatus: "failed",
        outboundUrl: "https://www.xiaohongshu.com/explore/abc123",
        summaryStatus: "unavailable",
        title: "小红书 - 你访问的页面不见了"
      })
      .where(eq(contents.id, xiaohongshu.content_id));
    await handle.db
      .insert(jobs)
      .values({
        idempotencyKey: `content.summary.v1:${xiaohongshu.content_id}`,
        payload: { contentId: xiaohongshu.content_id },
        queue: "content-enrichment",
        status: "completed",
        taskType: "content.summary.v1"
      })
      .onConflictDoNothing({ target: jobs.idempotencyKey });
    await handle.db
      .update(jobs)
      .set({ attempts: 2, completedAt: new Date(), status: "completed" })
      .where(
        sql`${jobs.idempotencyKey} IN (${`content.metadata.v1:${xiaohongshu.content_id}`}, ${`content.summary.v1:${xiaohongshu.content_id}`})`
      );

    await handle.sql.unsafe(
      readFileSync(
        new URL(
          "../../packages/db/drizzle/0027_xiaohongshu_outbound_repair.sql",
          import.meta.url
        ),
        "utf8"
      )
    );

    const [repairedContent] = await handle.db
      .select()
      .from(contents)
      .where(eq(contents.id, xiaohongshu.content_id));
    expect(repairedContent).toMatchObject({
      aiSummary: null,
      aiTags: [],
      enrichmentStatus: "pending",
      outboundUrl:
        "https://www.xiaohongshu.com/explore/abc123" +
        "?xsec_source=pc_share&xsec_token=refreshed-public-share",
      summaryStatus: "pending",
      title: null
    });
    const repairedJobs = await handle.db
      .select()
      .from(jobs)
      .where(
        sql`${jobs.idempotencyKey} IN (${`content.metadata.v1:${xiaohongshu.content_id}`}, ${`content.summary.v1:${xiaohongshu.content_id}`})`
      );
    expect(repairedJobs).toHaveLength(2);
    expect(repairedJobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attempts: 0, status: "pending" }),
        expect.objectContaining({ attempts: 0, status: "pending" })
      ])
    );

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

  it("does not backfill historical collections after a later membership upgrade", async () => {
    const challenge = await createLoginChallenge(handle.db, {
      email: "free-enrichment@example.com",
    });
    const verified = await verifyLoginChallenge(handle.db, {
      acceptTerms: true,
      challengeId: challenge.challengeId,
      code: challenge.code,
    });
    // This fixture represents a legacy account that has explicitly lost its
    // baseline signup entitlement; new registrations are Members by default.
    await disableBaselineMembership(verified.accountId);
    const principal = await resolveSession(handle.db, verified.session.token, { touch: false });
    if (!principal || principal.isMember) throw new Error("Expected a non-member legacy fixture");
    const response = await collectFromWeb(handle.db, principal, {
      idempotency_key: "free-enrichment-history",
      raw_input: "https://example.org/free-enrichment-history",
      visibility: "private",
    });
    if (response.status !== "accepted" && response.status !== "merged_with_existing_content") {
      throw new Error("Expected an established collection");
    }
    const claimed = await claimNextJob(handle.sql, {
      leaseMs: 5_000,
      queue: "content-enrichment",
      workerId: "free-enrichment-worker",
    });
    if (!claimed) throw new Error("Expected the metadata job");
    await executeClaimedJob(
      handle.db,
      claimed,
      createProductionHandlers(),
      new AbortController().signal,
    );

    expect(await handle.db.select().from(jobs)).toHaveLength(1);
    const [beforeUpgrade] = await handle.db
      .select({
        enrichmentStatus: contents.enrichmentStatus,
        summaryStatus: contents.summaryStatus,
      })
      .from(contents)
      .where(eq(contents.id, response.content_id));
    expect(beforeUpgrade).toEqual({
      enrichmentStatus: "partial",
      summaryStatus: "unavailable",
    });

    await handle.db.insert(entitlements).values({
      accountId: verified.accountId,
      memberEnabled: true,
      source: "admin_grant",
    });
    expect(await handle.db.select().from(jobs)).toHaveLength(1);
  });

  it("does not call the AI provider after entitlement is removed from a queued summary", async () => {
    const { redeemed } = await createRedeemedAccount("member", "ai-downgrade");
    const principal = await principalFor(redeemed);
    const response = await collectFromWeb(handle.db, principal, {
      idempotency_key: "ai-downgrade-queued-summary",
      raw_input: "https://example.org/ai-downgrade",
      visibility: "private",
    });
    if (response.status !== "accepted" && response.status !== "merged_with_existing_content") {
      throw new Error("Expected an established collection");
    }
    const firstClaim = await claimNextJob(handle.sql, {
      leaseMs: 5_000,
      now: new Date("2100-01-01T00:00:00.000Z"),
      queue: "content-enrichment",
      workerId: "ai-downgrade-metadata",
    });
    if (!firstClaim) throw new Error("Expected the metadata job");
    const completeJson = vi.fn().mockResolvedValue({
      summary: "This must not be persisted after downgrade.",
      tags: ["forbidden"],
    });
    const handlers = createProductionHandlers({ provider: { completeJson } });
    await executeClaimedJob(
      handle.db,
      firstClaim,
      handlers,
      new AbortController().signal,
    );
    await handle.db
      .update(entitlements)
      .set({ memberEnabled: false })
      .where(eq(entitlements.accountId, redeemed.accountId));
    const summaryClaim = await claimNextJob(handle.sql, {
      leaseMs: 5_000,
      now: new Date("2100-01-01T00:01:00.000Z"),
      queue: "content-enrichment",
      workerId: "ai-downgrade-summary",
    });
    if (!summaryClaim) throw new Error("Expected the summary job");
    await executeClaimedJob(
      handle.db,
      summaryClaim,
      handlers,
      new AbortController().signal,
    );

    expect(completeJson).not.toHaveBeenCalled();
    const [stored] = await handle.db
      .select({
        enrichmentStatus: contents.enrichmentStatus,
        summary: contents.aiSummary,
        summaryStatus: contents.summaryStatus,
      })
      .from(contents)
      .where(eq(contents.id, response.content_id));
    expect(stored).toEqual({
      enrichmentStatus: "partial",
      summary: null,
      summaryStatus: "unavailable",
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

  it("keeps successful metadata partial when a summary provider fails terminally", async () => {
    const content = await upsertContentByIdentity(handle.db, {
      dedupeKey: "generic:v1:https://example.com/summary-terminal",
      normalizedUrl: "https://example.com/summary-terminal",
      outboundUrl: "https://example.com/summary-terminal",
      source: "example.com",
      sourceAdapter: "generic_web",
      adapterVersion: "1",
    });
    await handle.db
      .update(contents)
      .set({ enrichmentStatus: "partial" })
      .where(eq(contents.id, content.content.id));
    await handle.db.insert(jobs).values({
      availableAt: new Date("2026-07-31T11:59:00.000Z"),
      idempotencyKey: `content.summary.v1:${content.content.id}`,
      maxAttempts: 1,
      payload: { contentId: content.content.id },
      queue: "content-enrichment",
      taskType: "content.summary.v1",
    });
    const claimed = await claimNextJob(handle.sql, {
      leaseMs: 5_000,
      now: new Date("2026-07-31T12:00:00.000Z"),
      queue: "content-enrichment",
      workerId: "summary-terminal-worker",
    });
    if (!claimed) throw new Error("Expected a summary job");
    await failJob(handle.sql, {
      baseRetryMs: 100,
      errorCode: "ai_provider_unauthorized",
      job: claimed,
      maxRetryMs: 1_000,
      retryable: false,
    });
    const [stored] = await handle.db
      .select({
        enrichmentStatus: contents.enrichmentStatus,
        summaryStatus: contents.summaryStatus,
      })
      .from(contents)
      .where(eq(contents.id, content.content.id));
    expect(stored).toEqual({
      enrichmentStatus: "partial",
      summaryStatus: "unavailable",
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
      kind: "member"
    });
    expect(preview).not.toHaveProperty("stableHandle");

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

  it("lets the non-owner Worker role evaluate hosted-AI eligibility", async () => {
    const { redeemed } = await createRedeemedAccount("member", "worker-role-ai");
    const content = await upsertContentByIdentity(handle.db, {
      dedupeKey: "generic:v1:https://example.com/worker-role-ai",
      normalizedUrl: "https://example.com/worker-role-ai",
      outboundUrl: "https://example.com/worker-role-ai",
      source: "example.com",
      sourceAdapter: "generic_web",
      adapterVersion: "1",
    });
    await upsertCollection(handle.db, {
      accountId: redeemed.accountId,
      contentId: content.content.id,
      domainId: await aiDomainId(),
      sourceChannel: "web",
      visibility: "private",
    });
    const runtimeHandle = createDatabase(databaseUrl!, { maxConnections: 1 });
    try {
      await runtimeHandle.sql.unsafe("SET ROLE attention_worker_runtime");
      await expect(shouldScheduleHostedAi(runtimeHandle.db, content.content.id))
        .resolves.toBe(true);
    } finally {
      await runtimeHandle.sql.unsafe("RESET ROLE").catch(() => undefined);
      await runtimeHandle.close();
    }
  });

  it("keeps moderation runtime grants least-privilege", async () => {
    const [privileges] = await handle.sql<
      {
        webCaseInsert: boolean;
        webCaseUpdate: boolean;
        webVoteDelete: boolean;
        webVoteInsert: boolean;
        webVoteUpdate: boolean;
        workerCaseInsert: boolean;
        workerCaseUpdate: boolean;
        workerVoteInsert: boolean;
        workerVoteSelect: boolean;
      }[]
    >`
      SELECT
        has_table_privilege('attention_web_runtime', 'moderation_cases', 'INSERT') AS "webCaseInsert",
        has_table_privilege('attention_web_runtime', 'moderation_cases', 'UPDATE') AS "webCaseUpdate",
        has_table_privilege('attention_web_runtime', 'moderation_votes', 'DELETE') AS "webVoteDelete",
        has_table_privilege('attention_web_runtime', 'moderation_votes', 'INSERT') AS "webVoteInsert",
        has_table_privilege('attention_web_runtime', 'moderation_votes', 'UPDATE') AS "webVoteUpdate",
        has_table_privilege('attention_worker_runtime', 'moderation_cases', 'INSERT') AS "workerCaseInsert",
        has_table_privilege('attention_worker_runtime', 'moderation_cases', 'UPDATE') AS "workerCaseUpdate",
        has_table_privilege('attention_worker_runtime', 'moderation_votes', 'INSERT') AS "workerVoteInsert",
        has_table_privilege('attention_worker_runtime', 'moderation_votes', 'SELECT') AS "workerVoteSelect"
    `;
    expect(privileges).toEqual({
      webCaseInsert: true,
      webCaseUpdate: false,
      webVoteDelete: false,
      webVoteInsert: true,
      webVoteUpdate: false,
      workerCaseInsert: false,
      workerCaseUpdate: true,
      workerVoteInsert: false,
      workerVoteSelect: true,
    });
  });

  it("serializes the per-Filter case-opening limit without charging duplicates or open cases", async () => {
    const filterCaseOpenLimit = 2;
    const sourceFilter = await createRedeemedAccount("filter", "court-limit-source");
    const reportingFilter = await createRedeemedAccount("filter", "court-limit-reporter");
    const otherFilter = await createRedeemedAccount("filter", "court-limit-other");
    const openedAt = new Date(Date.now() + 1_000);
    const publicAt = new Date(openedAt.getTime() - 60 * 60 * 1_000);
    const seedContent = await createPublicContent(
      sourceFilter.redeemed.accountId,
      "court-limit-seed",
      publicAt,
    );
    const alreadyOpenContent = await createPublicContent(
      sourceFilter.redeemed.accountId,
      "court-limit-open",
      new Date(publicAt.getTime() + 1),
    );
    const raceContents = await Promise.all([
      createPublicContent(
        sourceFilter.redeemed.accountId,
        "court-limit-race-one",
        new Date(publicAt.getTime() + 2),
      ),
      createPublicContent(
        sourceFilter.redeemed.accountId,
        "court-limit-race-two",
        new Date(publicAt.getTime() + 3),
      ),
    ]);
    const afterWindowContent = await createPublicContent(
      sourceFilter.redeemed.accountId,
      "court-limit-after-window",
      new Date(publicAt.getTime() + 4),
    );

    const seedReport = await submitContentReport(handle.db, {
      accountId: reportingFilter.redeemed.accountId,
      filterCaseOpenLimit,
      now: openedAt,
      publicContentId: seedContent.content.content.publicId,
      reasonCode: "unsafe",
    });
    expect(seedReport.caseOpened).toBe(true);

    const alreadyOpenReport = await submitContentReport(handle.db, {
      accountId: otherFilter.redeemed.accountId,
      now: openedAt,
      publicContentId: alreadyOpenContent.content.content.publicId,
      reasonCode: "misleading",
    });
    expect(alreadyOpenReport.caseOpened).toBe(true);
    await expect(
      submitContentReport(handle.db, {
        accountId: reportingFilter.redeemed.accountId,
        filterCaseOpenLimit,
        now: new Date(openedAt.getTime() + 500),
        publicContentId: alreadyOpenContent.content.content.publicId,
        reasonCode: "spam",
      }),
    ).resolves.toMatchObject({
      caseId: alreadyOpenReport.caseId,
      caseOpened: false,
      duplicate: false,
    });

    const firstRuntime = createDatabase(databaseUrl!, { maxConnections: 1 });
    const secondRuntime = createDatabase(databaseUrl!, { maxConnections: 1 });
    try {
      await Promise.all([
        firstRuntime.sql.unsafe("SET ROLE attention_web_runtime"),
        secondRuntime.sql.unsafe("SET ROLE attention_web_runtime"),
      ]);
      const raceAt = new Date(openedAt.getTime() + 1_000);
      const results = await Promise.allSettled(
        raceContents.map((item, index) =>
          submitContentReport(index === 0 ? firstRuntime.db : secondRuntime.db, {
            accountId: reportingFilter.redeemed.accountId,
            filterCaseOpenLimit,
            now: raceAt,
            publicContentId: item.content.content.publicId,
            reasonCode: index === 0 ? "rights" : "other",
          }),
        ),
      );
      expect(results.map((result) => result.status).sort()).toEqual([
        "fulfilled",
        "rejected",
      ]);
      const acceptedIndex = results.findIndex((result) => result.status === "fulfilled");
      const rejectedIndex = results.findIndex((result) => result.status === "rejected");
      const accepted = results[acceptedIndex];
      const rejected = results[rejectedIndex];
      if (!accepted || accepted.status !== "fulfilled") {
        throw new Error("Expected one accepted Filter case opening");
      }
      if (!rejected || rejected.status !== "rejected") {
        throw new Error("Expected one rate-limited Filter case opening");
      }
      expect(accepted.value).toMatchObject({ caseOpened: true, duplicate: false });
      expect(rejected.reason).toMatchObject({
        code: "report_rate_limited",
        retryAfterSeconds: expect.any(Number),
      });

      const acceptedContent = raceContents[acceptedIndex]!;
      const rejectedContent = raceContents[rejectedIndex]!;
      const [acceptedRow] = await handle.db
        .select({ communityStatus: contents.communityModerationStatus })
        .from(contents)
        .where(eq(contents.id, acceptedContent.content.content.id));
      const [rejectedRow] = await handle.db
        .select({ communityStatus: contents.communityModerationStatus })
        .from(contents)
        .where(eq(contents.id, rejectedContent.content.content.id));
      expect(acceptedRow?.communityStatus).toBe("pending_review");
      expect(rejectedRow?.communityStatus).toBe("clear");
      await expect(
        handle.db
          .select()
          .from(contentReports)
          .where(eq(contentReports.contentId, rejectedContent.content.content.id)),
      ).resolves.toHaveLength(0);
      await expect(
        handle.db
          .select()
          .from(moderationCases)
          .where(eq(moderationCases.contentId, rejectedContent.content.content.id)),
      ).resolves.toHaveLength(0);
    } finally {
      await Promise.all([
        firstRuntime.sql.unsafe("RESET ROLE").catch(() => undefined),
        secondRuntime.sql.unsafe("RESET ROLE").catch(() => undefined),
      ]);
      await Promise.all([firstRuntime.close(), secondRuntime.close()]);
    }

    await expect(
      submitContentReport(handle.db, {
        accountId: reportingFilter.redeemed.accountId,
        filterCaseOpenLimit,
        now: new Date(openedAt.getTime() + 2_000),
        publicContentId: seedContent.content.content.publicId,
        reasonCode: "other",
      }),
    ).resolves.toMatchObject({
      caseId: seedReport.caseId,
      caseOpened: false,
      duplicate: true,
      reportId: seedReport.reportId,
    });

    await expect(
      submitContentReport(handle.db, {
        accountId: reportingFilter.redeemed.accountId,
        filterCaseOpenLimit,
        now: new Date(openedAt.getTime() + 24 * 60 * 60 * 1_000 + 2_000),
        publicContentId: afterWindowContent.content.content.publicId,
        reasonCode: "unsafe",
      }),
    ).resolves.toMatchObject({ caseOpened: true, duplicate: false });
  });

  it("opens one case under concurrent Consumer reports and hides every public surface until a public verdict", async () => {
    const sourceFilter = await createRedeemedAccount("filter", "court-source");
    const secondFilter = await createRedeemedAccount("filter", "court-second");
    const thirdFilter = await createRedeemedAccount("filter", "court-third");
    const firstConsumer = await createRedeemedAccount("member", "court-consumer-one");
    const secondConsumer = await createRedeemedAccount("member", "court-consumer-two");
    const openedAt = new Date(Date.now() + 1_000);
    const firstPublicAt = new Date(openedAt.getTime() - 60 * 60 * 1_000);
    const published = await createPublicContent(
      sourceFilter.redeemed.accountId,
      "community-court-public",
      firstPublicAt,
    );
    const contentId = published.content.content.id;
    const publicId = published.content.content.publicId;
    const [before] = await handle.db
      .select({ visibilityVersion: contents.visibilityVersion })
      .from(contents)
      .where(eq(contents.id, contentId));

    const firstRuntime = createDatabase(databaseUrl!, { maxConnections: 1 });
    const secondRuntime = createDatabase(databaseUrl!, { maxConnections: 1 });
    const thirdRuntime = createDatabase(databaseUrl!, { maxConnections: 1 });
    const workerRuntime = createDatabase(databaseUrl!, { maxConnections: 1 });
    try {
      await Promise.all([
        firstRuntime.sql.unsafe("SET ROLE attention_web_runtime"),
        secondRuntime.sql.unsafe("SET ROLE attention_web_runtime"),
        thirdRuntime.sql.unsafe("SET ROLE attention_web_runtime"),
        workerRuntime.sql.unsafe("SET ROLE attention_worker_runtime"),
      ]);
      const reports = await Promise.all([
        submitContentReport(firstRuntime.db, {
          accountId: firstConsumer.redeemed.accountId,
          now: openedAt,
          publicContentId: publicId,
          reasonCode: "misleading",
        }),
        submitContentReport(secondRuntime.db, {
          accountId: secondConsumer.redeemed.accountId,
          now: openedAt,
          publicContentId: publicId,
          reasonCode: "spam",
        }),
      ]);
      expect(reports.filter((report) => report.caseOpened)).toHaveLength(1);
      const openedCaseIds = reports.flatMap((report) =>
        report.caseId ? [report.caseId] : [],
      );
      expect(new Set(openedCaseIds).size).toBe(1);
      const caseId = openedCaseIds[0]!;
      expect(
        await handle.db
          .select()
          .from(moderationCases)
          .where(eq(moderationCases.contentId, contentId)),
      ).toHaveLength(1);
      expect(
        await handle.db
          .select()
          .from(contentReports)
          .where(eq(contentReports.contentId, contentId)),
      ).toHaveLength(2);

      await expect(
        submitContentReport(firstRuntime.db, {
          accountId: firstConsumer.redeemed.accountId,
          now: new Date(openedAt.getTime() + 1_000),
          publicContentId: publicId,
          reasonCode: "other",
        }),
      ).resolves.toMatchObject({ duplicate: true, reportId: reports[0]!.reportId });
      expect(
        await handle.db
          .select()
          .from(contentReports)
          .where(eq(contentReports.contentId, contentId)),
      ).toHaveLength(2);

      const [pending] = await handle.db
        .select({
          communityStatus: contents.communityModerationStatus,
          firstPublicAt: contents.firstPublicAt,
          visibilityVersion: contents.visibilityVersion,
        })
        .from(contents)
        .where(eq(contents.id, contentId));
      expect(pending).toEqual({
        communityStatus: "pending_review",
        firstPublicAt,
        visibilityVersion: before!.visibilityVersion + 1,
      });
      expect(await handle.db.select().from(publicContentsCurrent)).toHaveLength(0);
      expect(await handle.db.select().from(publicContentAttributionsCurrent)).toHaveLength(0);
      await expect(loadPublicContents(handle.db)).resolves.toEqual([]);
      await expect(findPublicOutboundUrl(handle.db, publicId)).resolves.toBeNull();
      await expect(
        loadAgentCandidates(handle.db, firstConsumer.redeemed.accountId),
      ).resolves.toEqual([]);

      const mine = await loadMyCollections(
        handle.db,
        sourceFilter.redeemed.accountId,
      );
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({
        outboundHref: `/out/mine/${published.collection.collection.id}`,
        summary: "摘要 community-court-public",
      });
      await expect(
        findOwnedOutboundUrl(
          handle.db,
          sourceFilter.redeemed.accountId,
          published.collection.collection.id,
        ),
      ).resolves.toBe("https://example.com/community-court-public");

      const hiddenDigest = await createDigestDelivery(workerRuntime.sql, {
        accountId: firstConsumer.redeemed.accountId,
        availableAt: openedAt,
        domainId: await aiDomainId(),
        email: "court-consumer@example.com",
        localDate: "2026-08-10",
        maxAttempts: 8,
        scheduledFor: openedAt,
        timezone: "Asia/Shanghai",
        windowEnd: new Date(firstPublicAt.getTime() + 60_000),
        windowStart: new Date(firstPublicAt.getTime() - 60_000),
      });
      expect(hiddenDigest?.itemCount).toBe(0);

      await expect(
        listModerationCourtCases(firstRuntime.db, {
          accountId: firstConsumer.redeemed.accountId,
          now: openedAt,
        }),
      ).rejects.toMatchObject<Partial<ModerationRepositoryError>>({
        code: "filter_required",
      });
      await expect(
        listModerationCourtCases(firstRuntime.db, {
          accountId: sourceFilter.redeemed.accountId,
          now: openedAt,
        }),
      ).resolves.toEqual([
        expect.objectContaining({ id: caseId, status: "open" }),
      ]);

      const voteAt = new Date(openedAt.getTime() + 60 * 60 * 1_000);
      const concurrentVotes = await Promise.all([
        castModerationVote(firstRuntime.db, {
          accountId: sourceFilter.redeemed.accountId,
          caseId,
          decision: "public",
          now: voteAt,
        }),
        castModerationVote(thirdRuntime.db, {
          accountId: sourceFilter.redeemed.accountId,
          caseId,
          decision: "public",
          now: voteAt,
        }),
      ]);
      expect(concurrentVotes.filter((vote) => vote.duplicate)).toHaveLength(1);
      expect(new Set(concurrentVotes.map((vote) => vote.voteId)).size).toBe(1);
      const firstVote = concurrentVotes[0]!;
      await expect(
        castModerationVote(firstRuntime.db, {
          accountId: sourceFilter.redeemed.accountId,
          caseId,
          decision: "public",
          now: voteAt,
        }),
      ).resolves.toEqual({ duplicate: true, voteId: firstVote.voteId });
      await expect(
        castModerationVote(firstRuntime.db, {
          accountId: sourceFilter.redeemed.accountId,
          caseId,
          decision: "hidden",
          now: voteAt,
        }),
      ).rejects.toMatchObject<Partial<ModerationRepositoryError>>({
        code: "vote_already_cast",
      });
      await Promise.all([
        castModerationVote(secondRuntime.db, {
          accountId: secondFilter.redeemed.accountId,
          caseId,
          decision: "public",
          now: voteAt,
        }),
        castModerationVote(thirdRuntime.db, {
          accountId: thirdFilter.redeemed.accountId,
          caseId,
          decision: "hidden",
          now: voteAt,
        }),
      ]);
      const votingEndsAt = new Date(openedAt.getTime() + 24 * 60 * 60 * 1_000);
      await expect(
        resolveDueModerationCases(workerRuntime.db, {
          now: new Date(votingEndsAt.getTime() - 1),
        }),
      ).resolves.toBe(0);
      expect(await handle.db.select().from(publicContentsCurrent)).toHaveLength(0);
      await expect(
        resolveDueModerationCases(workerRuntime.db, { now: votingEndsAt }),
      ).resolves.toBe(1);

      const [resolvedContent] = await handle.db
        .select({
          communityStatus: contents.communityModerationStatus,
          firstPublicAt: contents.firstPublicAt,
          visibilityVersion: contents.visibilityVersion,
        })
        .from(contents)
        .where(eq(contents.id, contentId));
      expect(resolvedContent).toEqual({
        communityStatus: "clear",
        firstPublicAt,
        visibilityVersion: before!.visibilityVersion + 2,
      });
      const [resolvedCase] = await handle.db
        .select()
        .from(moderationCases)
        .where(eq(moderationCases.id, caseId));
      expect(resolvedCase).toMatchObject({
        eligibleFilterCountAtResolution: 3,
        hiddenVotesAtResolution: 1,
        publicVotesAtResolution: 2,
        resolution: "public",
        status: "resolved",
      });
      expect(await handle.db.select().from(publicContentsCurrent)).toHaveLength(1);
      expect(await handle.db.select().from(publicContentAttributionsCurrent)).toHaveLength(1);
      await expect(
        loadAgentCandidates(handle.db, firstConsumer.redeemed.accountId),
      ).resolves.toEqual([
        expect.objectContaining({ id: publicId, scope: "public" }),
      ]);

      const noRepeatDigest = await createDigestDelivery(workerRuntime.sql, {
        accountId: firstConsumer.redeemed.accountId,
        availableAt: votingEndsAt,
        domainId: await aiDomainId(),
        email: "court-consumer@example.com",
        localDate: "2026-08-11",
        maxAttempts: 8,
        scheduledFor: votingEndsAt,
        timezone: "Asia/Shanghai",
        windowEnd: new Date(votingEndsAt.getTime() + 60_000),
        windowStart: new Date(votingEndsAt.getTime() - 60_000),
      });
      expect(noRepeatDigest?.itemCount).toBe(0);
    } finally {
      await Promise.all([
        firstRuntime.sql.unsafe("RESET ROLE").catch(() => undefined),
        secondRuntime.sql.unsafe("RESET ROLE").catch(() => undefined),
        thirdRuntime.sql.unsafe("RESET ROLE").catch(() => undefined),
        workerRuntime.sql.unsafe("RESET ROLE").catch(() => undefined),
      ]);
      await Promise.all([
        firstRuntime.close(),
        secondRuntime.close(),
        thirdRuntime.close(),
        workerRuntime.close(),
      ]);
    }
  });

  it("resolves hidden verdicts and never lets a public verdict override hard takedown", async () => {
    const firstFilter = await createRedeemedAccount("filter", "court-hard-one");
    const secondFilter = await createRedeemedAccount("filter", "court-hard-two");
    const thirdFilter = await createRedeemedAccount("filter", "court-hard-three");
    const openedAt = new Date(Date.now() + 1_000);
    const firstPublicAt = new Date(openedAt.getTime() - 60 * 60 * 1_000);
    const hiddenContent = await createPublicContent(
      firstFilter.redeemed.accountId,
      "community-court-hidden",
      firstPublicAt,
    );
    const hardContent = await createPublicContent(
      firstFilter.redeemed.accountId,
      "community-court-hard",
      new Date(firstPublicAt.getTime() + 1_000),
    );
    const hiddenReport = await submitContentReport(handle.db, {
      accountId: firstFilter.redeemed.accountId,
      now: openedAt,
      publicContentId: hiddenContent.content.content.publicId,
      reasonCode: "unsafe",
    });
    const hardReport = await submitContentReport(handle.db, {
      accountId: secondFilter.redeemed.accountId,
      now: openedAt,
      publicContentId: hardContent.content.content.publicId,
      reasonCode: "rights",
    });
    expect(hiddenReport.caseOpened).toBe(true);
    expect(hardReport.caseOpened).toBe(true);
    const voteAt = new Date(openedAt.getTime() + 60 * 60 * 1_000);
    await Promise.all([
      castModerationVote(handle.db, {
        accountId: firstFilter.redeemed.accountId,
        caseId: hiddenReport.caseId!,
        decision: "hidden",
        now: voteAt,
      }),
      castModerationVote(handle.db, {
        accountId: secondFilter.redeemed.accountId,
        caseId: hiddenReport.caseId!,
        decision: "hidden",
        now: voteAt,
      }),
      castModerationVote(handle.db, {
        accountId: thirdFilter.redeemed.accountId,
        caseId: hiddenReport.caseId!,
        decision: "public",
        now: voteAt,
      }),
      castModerationVote(handle.db, {
        accountId: firstFilter.redeemed.accountId,
        caseId: hardReport.caseId!,
        decision: "public",
        now: voteAt,
      }),
      castModerationVote(handle.db, {
        accountId: secondFilter.redeemed.accountId,
        caseId: hardReport.caseId!,
        decision: "public",
        now: voteAt,
      }),
      castModerationVote(handle.db, {
        accountId: thirdFilter.redeemed.accountId,
        caseId: hardReport.caseId!,
        decision: "public",
        now: voteAt,
      }),
    ]);
    await handle.db
      .update(contents)
      .set({
        restrictedAt: voteAt,
        restrictionReasonCode: "legal_takedown",
        takedownStatus: "removed",
      })
      .where(eq(contents.id, hardContent.content.content.id));
    const resolveAt = new Date(openedAt.getTime() + 24 * 60 * 60 * 1_000);
    await expect(resolveDueModerationCases(handle.db, { now: resolveAt })).resolves.toBe(2);

    const [hidden] = await handle.db
      .select({
        communityStatus: contents.communityModerationStatus,
        firstPublicAt: contents.firstPublicAt,
      })
      .from(contents)
      .where(eq(contents.id, hiddenContent.content.content.id));
    expect(hidden).toEqual({ communityStatus: "hidden", firstPublicAt });
    const [hard] = await handle.db
      .select({ communityStatus: contents.communityModerationStatus })
      .from(contents)
      .where(eq(contents.id, hardContent.content.content.id));
    expect(hard?.communityStatus).toBe("pending_review");
    const caseRows = await handle.db
      .select({ resolution: moderationCases.resolution, status: moderationCases.status })
      .from(moderationCases)
      .orderBy(moderationCases.createdAt);
    expect(caseRows).toEqual([
      { resolution: "hidden", status: "resolved" },
      { resolution: "requires_admin", status: "requires_admin" },
    ]);
    expect(await handle.db.select().from(publicContentsCurrent)).toHaveLength(0);
    await expect(
      findOwnedOutboundUrl(
        handle.db,
        firstFilter.redeemed.accountId,
        hiddenContent.collection.collection.id,
      ),
    ).resolves.toBe("https://example.com/community-court-hidden");
    await expect(
      findOwnedOutboundUrl(
        handle.db,
        firstFilter.redeemed.accountId,
        hardContent.collection.collection.id,
      ),
    ).resolves.toBeNull();
    expect(await handle.db.select().from(moderationVotes)).toHaveLength(6);
  });

  it("schedules Domain digests idempotently and removes stale visibility snapshots before send", async () => {
    const subscriber = await createRedeemedAccount("member", "digest-subscriber");
    const filter = await createRedeemedAccount("filter", "digest-filter");
    const subscriberEmail = "digest-subscriber@example.com";
    await handle.db
      .update(accounts)
      .set({ emailVerifiedAt: new Date(), primaryEmail: subscriberEmail })
      .where(eq(accounts.id, subscriber.redeemed.accountId));
    const domainId = await aiDomainId();
    const firstPublicAt = new Date("2026-08-03T02:00:00.000Z");

    for (const index of [1, 2, 3]) {
      const content = await upsertContentByIdentity(handle.db, {
        adapterVersion: "1",
        dedupeKey: `generic:v1:https://example.com/digest-${index}`,
        normalizedUrl: `https://example.com/digest-${index}`,
        outboundUrl: `https://example.com/digest-${index}`,
        source: "example.com",
        sourceAdapter: "generic_web",
      });
      const saved = await upsertCollection(handle.db, {
        accountId: filter.redeemed.accountId,
        contentId: content.content.id,
        domainId,
        sourceChannel: "web",
        visibility: "private",
      });
      await setCollectionVisibility(handle.db, {
        accountId: filter.redeemed.accountId,
        collectionId: saved.collection.id,
        now: new Date(firstPublicAt.getTime() + index * 1_000),
        visibility: "public",
      });
      await handle.db
        .update(contents)
        .set({
          aiSummary: index === 1 ? "会在发送前失效" : null,
          author: index === 1 ? "作者一" : null,
          summaryStatus:
            index === 1 ? "ready" : index === 2 ? "unavailable" : "hidden",
          title: `日报条目 ${index}`,
        })
        .where(eq(contents.id, content.content.id));
    }

    const webRuntimeHandle = createDatabase(databaseUrl!, { maxConnections: 1 });
    try {
      await webRuntimeHandle.sql.unsafe("SET ROLE attention_web_runtime");
      await updateDigestSettings(webRuntimeHandle.db, subscriber.redeemed.accountId, {
        domainSlugs: ["ai"],
        enabled: true,
        timezone: "Asia/Shanghai",
        windowMinutes: 60,
        windowStart: "08:00",
      });
      await expect(
        loadDigestSettings(webRuntimeHandle.db, subscriber.redeemed.accountId),
      ).resolves.toMatchObject({
        domains: [{ active: true, slug: "ai" }],
        timezone: "Asia/Shanghai",
        windowStart: "08:00",
      });
    } finally {
      await webRuntimeHandle.sql.unsafe("RESET ROLE").catch(() => undefined);
      await webRuntimeHandle.close();
    }

    const runtimeHandle = createDatabase(databaseUrl!, { maxConnections: 2 });
    try {
      await runtimeHandle.sql.unsafe("SET ROLE attention_worker_runtime");
      const candidates = await listDigestScheduleCandidates(runtimeHandle.sql);
      expect(candidates).toEqual([
        expect.objectContaining({
          accountId: subscriber.redeemed.accountId,
          domainId,
          timezone: "Asia/Shanghai",
        }),
      ]);
      const sendAt = new Date("2026-08-04T00:15:00.000Z");
      const window = digestContentWindow("2026-08-04", "Asia/Shanghai");
      const delivery = await createDigestDelivery(runtimeHandle.sql, {
        accountId: subscriber.redeemed.accountId,
        availableAt: sendAt,
        domainId,
        email: subscriberEmail,
        localDate: "2026-08-04",
        maxAttempts: 8,
        scheduledFor: sendAt,
        timezone: "Asia/Shanghai",
        windowEnd: window.end,
        windowStart: window.start,
      });
      expect(delivery?.itemCount).toBe(2);
      await expect(
        createDigestDelivery(runtimeHandle.sql, {
          accountId: subscriber.redeemed.accountId,
          availableAt: sendAt,
          domainId,
          email: subscriberEmail,
          localDate: "2026-08-04",
          maxAttempts: 8,
          scheduledFor: sendAt,
          timezone: "Asia/Shanghai",
          windowEnd: window.end,
          windowStart: window.start,
        }),
      ).resolves.toBeNull();

      const claimed = await claimNextDigestDelivery(runtimeHandle.sql, {
        leaseMs: 60_000,
        now: sendAt,
        workerId: "digest-test",
      });
      expect(claimed?.id).toBe(delivery?.deliveryId);
      await expect(
        loadCurrentDeliveryContext(runtimeHandle.sql, claimed!.id),
      ).resolves.toMatchObject({
        domainName: "AI",
        email: subscriberEmail,
      });

      const [staleItem] = await handle.db
        .select({ contentId: digestEmailDeliveryItems.contentId })
        .from(digestEmailDeliveryItems)
        .where(eq(digestEmailDeliveryItems.deliveryId, claimed!.id))
        .orderBy(digestEmailDeliveryItems.ordinal);
      await handle.db
        .update(contents)
        .set({ visibilityVersion: sql`${contents.visibilityVersion} + 1` })
        .where(eq(contents.id, staleItem!.contentId));

      const valid = await revalidateDigestItems(runtimeHandle.sql, claimed!.id);
      expect(valid).toEqual([
        expect.objectContaining({
          summary: null,
          summaryStatus: "unavailable",
          title: "日报条目 2",
        }),
      ]);
      expect(
        await handle.db
          .select()
          .from(digestEmailDeliveryItems)
          .where(eq(digestEmailDeliveryItems.deliveryId, claimed!.id)),
      ).toHaveLength(1);
      expect(
        await handle.db
          .select()
          .from(digestEmailDeliveries)
          .where(eq(digestEmailDeliveries.id, claimed!.id)),
      ).toHaveLength(1);

      const sentMessages: Array<{ html: string; idempotencyKey: string }> = [];
      const config: WorkerConfig = {
        baseRetryMs: 1_000,
        concurrency: 1,
        databaseUrl: databaseUrl!,
        digestBatchSize: 10,
        digestEnabled: true,
        digestMaxAttempts: 8,
        digestPollIntervalMs: 60_000,
        leaseMs: 60_000,
        maxRetryMs: 60_000,
        pollIntervalMs: 1_000,
        publicOrigin: "https://attention.example",
        queue: "content-enrichment",
        workerId: "digest-integration",
      };
      const logger = {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      };
      await processDigestDelivery({
        config,
        delivery: claimed!,
        handle: runtimeHandle,
        logger,
        now: new Date(),
        provider: {
          send: async (message) => {
            sentMessages.push(message);
            return { providerMessageId: "mail-1" };
          },
        },
      });
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toMatchObject({ idempotencyKey: claimed!.id });
      expect(sentMessages[0]!.html).toContain("暂时无法生成摘要");
      expect(sentMessages[0]!.html).toContain("作者：未提供");
      expect(sentMessages[0]!.html).toContain("查看原文");
      expect(
        await handle.db
          .select({ status: digestEmailDeliveries.status })
          .from(digestEmailDeliveries)
          .where(eq(digestEmailDeliveries.id, claimed!.id)),
      ).toEqual([{ status: "sent" }]);

      const laterContent = await upsertContentByIdentity(handle.db, {
        adapterVersion: "1",
        dedupeKey: "generic:v1:https://example.com/digest-entitlement-recheck",
        normalizedUrl: "https://example.com/digest-entitlement-recheck",
        outboundUrl: "https://example.com/digest-entitlement-recheck",
        source: "example.com",
        sourceAdapter: "generic_web",
      });
      const laterCollection = await upsertCollection(handle.db, {
        accountId: filter.redeemed.accountId,
        contentId: laterContent.content.id,
        domainId,
        sourceChannel: "web",
        visibility: "private",
      });
      await setCollectionVisibility(handle.db, {
        accountId: filter.redeemed.accountId,
        collectionId: laterCollection.collection.id,
        now: new Date("2026-08-04T02:00:00.000Z"),
        visibility: "public",
      });
      const laterSendAt = new Date("2026-08-05T00:15:00.000Z");
      const laterWindow = digestContentWindow("2026-08-05", "Asia/Shanghai");
      const laterDelivery = await createDigestDelivery(runtimeHandle.sql, {
        accountId: subscriber.redeemed.accountId,
        availableAt: laterSendAt,
        domainId,
        email: subscriberEmail,
        localDate: "2026-08-05",
        maxAttempts: 8,
        scheduledFor: laterSendAt,
        timezone: "Asia/Shanghai",
        windowEnd: laterWindow.end,
        windowStart: laterWindow.start,
      });
      expect(laterDelivery?.itemCount).toBe(1);
      const laterClaim = await claimNextDigestDelivery(runtimeHandle.sql, {
        leaseMs: 60_000,
        now: laterSendAt,
        workerId: "digest-test",
      });
      await handle.db
        .update(entitlements)
        .set({ memberEnabled: false })
        .where(eq(entitlements.accountId, subscriber.redeemed.accountId));
      await processDigestDelivery({
        config,
        delivery: laterClaim!,
        handle: runtimeHandle,
        logger,
        now: laterSendAt,
        provider: {
          send: async (message) => {
            sentMessages.push(message);
            return { providerMessageId: "must-not-send" };
          },
        },
      });
      expect(sentMessages).toHaveLength(1);
      expect(
        await handle.db
          .select({
            reason: digestEmailDeliveries.skippedReason,
            status: digestEmailDeliveries.status,
          })
          .from(digestEmailDeliveries)
          .where(eq(digestEmailDeliveries.id, laterClaim!.id)),
      ).toEqual([{ reason: "entitlement_inactive", status: "skipped" }]);

      const crashedAt = new Date("2026-08-05T00:00:00.000Z");
      const exhausted = await createDigestDelivery(runtimeHandle.sql, {
        accountId: subscriber.redeemed.accountId,
        availableAt: crashedAt,
        domainId,
        email: subscriberEmail,
        localDate: "2026-08-06",
        maxAttempts: 8,
        scheduledFor: crashedAt,
        timezone: "Asia/Shanghai",
        windowEnd: new Date("2026-08-05T16:00:00.000Z"),
        windowStart: new Date("2026-08-04T16:00:00.000Z"),
      });
      await handle.db
        .update(digestEmailDeliveries)
        .set({
          attempts: 8,
          lockedAt: crashedAt,
          lockedBy: "crashed-worker",
          status: "sending",
        })
        .where(eq(digestEmailDeliveries.id, exhausted!.deliveryId));
      await expect(
        reapExhaustedDigestDeliveries(runtimeHandle.sql, {
          leaseMs: 60_000,
          now: new Date("2026-08-05T00:02:00.000Z"),
        }),
      ).resolves.toBe(1);
      expect(
        await handle.db
          .select({
            errorCode: digestEmailDeliveries.lastErrorCode,
            status: digestEmailDeliveries.status,
          })
          .from(digestEmailDeliveries)
          .where(eq(digestEmailDeliveries.id, exhausted!.deliveryId)),
      ).toEqual([{ errorCode: "lease_expired", status: "failed" }]);
    } finally {
      await runtimeHandle.sql.unsafe("RESET ROLE").catch(() => undefined);
      await runtimeHandle.close();
    }

    const memberChallenge = await createLoginChallenge(handle.db, {
      email: "digest-member@example.com",
    });
    const member = await verifyLoginChallenge(handle.db, {
      acceptTerms: true,
      challengeId: memberChallenge.challengeId,
      code: memberChallenge.code,
    });
    await expect(updateDigestSettings(handle.db, member.accountId, {
        domainSlugs: ["ai"],
        enabled: true,
        timezone: "Asia/Shanghai",
        windowMinutes: 60,
        windowStart: "08:00",
      })).resolves.toMatchObject({
        enabled: true,
        domains: [{ active: true, slug: "ai" }],
      });
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
      const pulled = await pullSyncEvents(runtimeHandle.db, redeemed.accountId, {
        cursor: null,
        limit: 10,
      });
      expect(pulled.events).toHaveLength(1);
      expect(pulled.events[0]?.collection_id).toBe(first.collection_id);
    } finally {
      await runtimeHandle.sql.unsafe("RESET ROLE").catch(() => undefined);
      await runtimeHandle.close();
    }
  });

  it("redeems exactly one Consumer referral registration under non-owner concurrency", async () => {
    const accountCreatedAt = new Date("2026-01-02T00:00:00.000Z");
    const now = new Date("2026-08-04T08:00:00.000Z");
    const inviter = await createEmailAccount("growth-inviter@example.com", accountCreatedAt);
    const existingGrantEndsAt = new Date("2026-09-30T08:00:00.000Z");
    await handle.db.insert(membershipGrants).values({
      accountId: inviter.accountId,
      endsAt: existingGrantEndsAt,
      kind: "admin_grant",
      sourceId: "growth-existing-grant",
      startsAt: new Date("2026-07-01T08:00:00.000Z"),
      status: "active",
    });

    const firstRuntime = createDatabase(databaseUrl!, { maxConnections: 1 });
    const secondRuntime = createDatabase(databaseUrl!, { maxConnections: 1 });
    const workerRuntime = createDatabase(databaseUrl!, { maxConnections: 1 });
    try {
      await Promise.all([
        firstRuntime.sql.unsafe("SET ROLE attention_web_runtime"),
        secondRuntime.sql.unsafe("SET ROLE attention_web_runtime"),
        workerRuntime.sql.unsafe("SET ROLE attention_worker_runtime"),
      ]);
      const invitation = await createConsumerInvite(firstRuntime.db, {
        accountId: inviter.accountId,
        now,
        ttlDays: 30,
      });
      const [storedInvitation] = await handle.db
        .select({ tokenHash: consumerReferrals.tokenHash })
        .from(consumerReferrals)
        .where(eq(consumerReferrals.id, invitation.invitationId));
      expect(storedInvitation?.tokenHash).toHaveLength(64);
      expect(storedInvitation?.tokenHash).not.toBe(invitation.token);

      await expect(
        createLoginChallenge(firstRuntime.db, {
          consumerInviteToken: invitation.token,
          email: "growth-inviter@example.com",
          now,
          requesterFingerprint: "a".repeat(64),
        }),
      ).rejects.toMatchObject({ code: "referral_registration_unavailable" });

      const [firstChallenge, secondChallenge] = await Promise.all([
        createLoginChallenge(firstRuntime.db, {
          consumerInviteToken: invitation.token,
          email: "growth-invitee-one@example.com",
          now,
          requesterFingerprint: "b".repeat(64),
        }),
        createLoginChallenge(secondRuntime.db, {
          consumerInviteToken: invitation.token,
          email: "growth-invitee-two@example.com",
          now,
          requesterFingerprint: "c".repeat(64),
        }),
      ]);
      const verified = await Promise.allSettled([
        verifyLoginChallenge(firstRuntime.db, {
          acceptTerms: true,
          challengeId: firstChallenge.challengeId,
          code: firstChallenge.code,
          now,
        }),
        verifyLoginChallenge(secondRuntime.db, {
          acceptTerms: true,
          challengeId: secondChallenge.challengeId,
          code: secondChallenge.code,
          now,
        }),
      ]);
      const successful = verified.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      const rejected = verified.flatMap((result) =>
        result.status === "rejected" ? [result.reason as { code?: string }] : [],
      );
      expect(successful).toHaveLength(1);
      expect(rejected).toEqual([
        expect.objectContaining({ code: "referral_registration_unavailable" }),
      ]);
      const invitee = successful[0]!;

      const [referral] = await handle.db
        .select()
        .from(consumerReferrals)
        .where(eq(consumerReferrals.id, invitation.invitationId));
      expect(referral).toMatchObject({
        inviteeAccountId: invitee.accountId,
        inviterAccountId: inviter.accountId,
        status: "redeemed",
      });
      const referralGrants = await handle.db
        .select()
        .from(membershipGrants)
        .where(eq(membershipGrants.sourceId, invitation.invitationId));
      expect(referralGrants).toHaveLength(2);
      expect(
        referralGrants.find((grant) => grant.kind === "consumer_inviter_quarter"),
      ).toMatchObject({ accountId: inviter.accountId, startsAt: existingGrantEndsAt });
      expect(
        referralGrants.find((grant) => grant.kind === "consumer_invitee_quarter"),
      ).toMatchObject({ accountId: invitee.accountId, startsAt: now });
      expect(
        await handle.db
          .select({ signupSource: accounts.signupSource })
          .from(accounts)
          .where(eq(accounts.id, invitee.accountId)),
      ).toEqual([{ signupSource: "consumer_referral" }]);

      await expect(
        createConsumerInvite(firstRuntime.db, { accountId: inviter.accountId, now }),
      ).rejects.toMatchObject({ code: "consumer_invite_used" });
      const downstreamInvite = await createConsumerInvite(firstRuntime.db, {
        accountId: invitee.accountId,
        now,
      });
      await handle.db.insert(filterProfiles).values({
        accountId: invitee.accountId,
        active: true,
        displayName: "New Filter",
        invitedAt: now,
        updatedAt: now,
      });
      await expect(
        createLoginChallenge(firstRuntime.db, {
          consumerInviteToken: downstreamInvite.token,
          email: "growth-downstream-invitee@example.com",
          now,
          requesterFingerprint: "9".repeat(64),
        }),
      ).resolves.toMatchObject({ email: "growth-downstream-invitee@example.com" });
      const filterInvitation = await createConsumerInvite(firstRuntime.db, {
        accountId: invitee.accountId,
        now,
        replaceActive: true,
      });
      const filterDashboard = await loadGrowthDashboard(firstRuntime.db, invitee.accountId, now);
      expect(filterDashboard.consumerInvite).toMatchObject({
        canCreate: true,
        status: "active",
      });
      expect(filterDashboard.isFilter).toBe(true);
      expect(filterInvitation.token).toHaveLength(43);
      await expect(
        createLoginChallenge(firstRuntime.db, {
          consumerInviteToken: filterInvitation.token,
          email: "growth-filter-invitee@example.com",
          now,
          requesterFingerprint: "a".repeat(64),
        }),
      ).resolves.toMatchObject({ email: "growth-filter-invitee@example.com" });
      const dashboard = await loadGrowthDashboard(firstRuntime.db, inviter.accountId, now);
      expect(dashboard.consumerInvite).toMatchObject({
        canCreate: false,
        status: "redeemed",
      });
      expect(dashboard.consumerInvite).not.toHaveProperty("token");

      const subscriptionId = await createActiveSubscription({
        accountId: invitee.accountId,
        currentPeriodEnd: new Date("2027-08-04T08:00:00.000Z"),
        currentPeriodStart: now,
        provider: "testpay",
        suffix: "referral-no-direct-trial",
      });
      await expect(
        recordPaidSubscriptionBound(workerRuntime.db, {
          accountId: invitee.accountId,
          occurredAt: now,
          provider: "testpay",
          providerEventId: "bound-referral-account",
          subscriptionId,
        }),
      ).resolves.toMatchObject({ trialGranted: false });
      expect(
        await handle.db
          .select()
          .from(membershipGrants)
          .where(eq(membershipGrants.kind, "direct_trial")),
      ).toHaveLength(0);
    } finally {
      await Promise.all([
        firstRuntime.sql.unsafe("RESET ROLE").catch(() => undefined),
        secondRuntime.sql.unsafe("RESET ROLE").catch(() => undefined),
        workerRuntime.sql.unsafe("RESET ROLE").catch(() => undefined),
      ]);
      await Promise.all([
        firstRuntime.close(),
        secondRuntime.close(),
        workerRuntime.close(),
      ]);
    }
  });

  it("holds the inviter quota lock while redeeming a Consumer referral", async () => {
    const now = new Date("2026-08-04T08:30:00.000Z");
    const inviter = await createEmailAccount(
      "growth-lock-inviter@example.com",
      now,
    );
    const invitee = await createEmailAccount(
      "growth-lock-invitee@example.com",
      new Date(now.getTime() + 61_000),
    );
    const invitation = await createConsumerInvite(handle.db, {
      accountId: inviter.accountId,
      now,
    });
    const blocker = createDatabase(databaseUrl!, { maxConnections: 1 });
    const redeemer = createDatabase(databaseUrl!, { maxConnections: 1 });
    let markLockReady: (() => void) | undefined;
    let releaseLock: (() => void) | undefined;
    const lockReady = new Promise<void>((resolve) => {
      markLockReady = resolve;
    });
    const holdLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const namespace = `consumer-invite:${inviter.accountId}`;

    try {
      const blockerTask = blocker.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${namespace}::text, 0))`,
        );
        markLockReady?.();
        await holdLock;
      });
      await lockReady;

      const redemption = redeemer.db.transaction((tx) =>
        redeemConsumerReferralRegistration(tx, {
          inviteeAccountId: invitee.accountId,
          now,
          referralId: invitation.invitationId,
        }),
      );
      const stateBeforeRelease = await Promise.race([
        redemption.then(() => "completed" as const),
        new Promise<"blocked">((resolve) => {
          setTimeout(() => resolve("blocked"), 150);
        }),
      ]);
      expect(stateBeforeRelease).toBe("blocked");

      releaseLock?.();
      await Promise.all([blockerTask, redemption]);
      const [stored] = await handle.db
        .select({ status: consumerReferrals.status })
        .from(consumerReferrals)
        .where(eq(consumerReferrals.id, invitation.invitationId));
      expect(stored?.status).toBe("redeemed");
      await expect(
        createConsumerInvite(handle.db, { accountId: inviter.accountId, now }),
      ).rejects.toMatchObject({ code: "consumer_invite_used" });
    } finally {
      releaseLock?.();
      await Promise.all([blocker.close(), redeemer.close()]);
    }
  });

  it("caps Filter annual codes at five and redeems one code only once", async () => {
    const now = new Date("2026-08-04T09:00:00.000Z");
    const filter = await createRedeemedAccount("filter", "growth-filter-codes");
    const issued = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        issueFilterAnnualCode(handle.db, {
          accountId: filter.redeemed.accountId,
          now,
          ttlDays: 30,
        }),
      ),
    );
    const codes = issued.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    expect(codes).toHaveLength(5);
    expect(
      issued.flatMap((result) =>
        result.status === "rejected" ? [result.reason as { code?: string }] : [],
      ),
    ).toEqual([expect.objectContaining({ code: "filter_code_annual_limit" })]);
    expect(
      await handle.db
        .select()
        .from(filterAnnualCodes)
        .where(eq(filterAnnualCodes.issuerFilterAccountId, filter.redeemed.accountId)),
    ).toHaveLength(5);
    const storedHashes = await handle.db
      .select({ tokenHash: filterAnnualCodes.tokenHash })
      .from(filterAnnualCodes);
    expect(storedHashes.every((row) => row.tokenHash.length === 64)).toBe(true);
    expect(storedHashes.some((row) => codes.some((code) => code.token === row.tokenHash))).toBe(false);

    const firstMember = await createEmailAccount(
      "filter-code-member-one@example.com",
      new Date("2026-01-03T00:00:00.000Z"),
    );
    const secondMember = await createEmailAccount(
      "filter-code-member-two@example.com",
      new Date("2026-01-04T00:00:00.000Z"),
    );
    const existingEndsAt = new Date("2026-10-31T09:00:00.000Z");
    await handle.db.insert(membershipGrants).values([
      {
        accountId: firstMember.accountId,
        endsAt: existingEndsAt,
        kind: "admin_grant",
        sourceId: "filter-code-existing-one",
        startsAt: new Date("2026-07-01T09:00:00.000Z"),
        status: "active",
      },
      {
        accountId: secondMember.accountId,
        endsAt: existingEndsAt,
        kind: "admin_grant",
        sourceId: "filter-code-existing-two",
        startsAt: new Date("2026-07-01T09:00:00.000Z"),
        status: "active",
      },
    ]);
    const firstRuntime = createDatabase(databaseUrl!, { maxConnections: 1 });
    const secondRuntime = createDatabase(databaseUrl!, { maxConnections: 1 });
    const redemption = await (async () => {
      try {
        await Promise.all([
          firstRuntime.sql.unsafe("SET ROLE attention_web_runtime"),
          secondRuntime.sql.unsafe("SET ROLE attention_web_runtime"),
        ]);
        return await Promise.allSettled([
          redeemFilterAnnualCode(firstRuntime.db, {
            accountId: firstMember.accountId,
            now,
            token: codes[0]!.token,
          }),
          redeemFilterAnnualCode(secondRuntime.db, {
            accountId: secondMember.accountId,
            now,
            token: codes[0]!.token,
          }),
        ]);
      } finally {
        await Promise.all([
          firstRuntime.sql.unsafe("RESET ROLE").catch(() => undefined),
          secondRuntime.sql.unsafe("RESET ROLE").catch(() => undefined),
        ]);
        await Promise.all([firstRuntime.close(), secondRuntime.close()]);
      }
    })();
    const winnerIndex = redemption.findIndex((result) => result.status === "fulfilled");
    expect(winnerIndex).toBeGreaterThanOrEqual(0);
    expect(redemption.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(redemption.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winner = [firstMember, secondMember][winnerIndex]!;
    const annualGrants = await handle.db
      .select()
      .from(membershipGrants)
      .where(eq(membershipGrants.kind, "filter_annual_redemption"));
    expect(annualGrants).toEqual([
      expect.objectContaining({ accountId: winner.accountId, startsAt: existingEndsAt }),
    ]);
    expect(
      await handle.db
        .select({ signupSource: accounts.signupSource })
        .from(accounts)
        .where(eq(accounts.id, winner.accountId)),
    ).toEqual([{ signupSource: "direct" }]);
    expect(await handle.db.select().from(consumerReferrals)).toHaveLength(0);
    expect(await handle.db.select().from(pointsBalances)).toHaveLength(0);

    const winnerSubscriptionId = await createActiveSubscription({
      accountId: winner.accountId,
      currentPeriodEnd: new Date("2028-08-04T09:00:00.000Z"),
      currentPeriodStart: now,
      provider: "testpay",
      suffix: "filter-code-direct-trial",
    });
    const workerRuntime = createDatabase(databaseUrl!, { maxConnections: 1 });
    try {
      await workerRuntime.sql.unsafe("SET ROLE attention_worker_runtime");
      await expect(
        recordPaidSubscriptionBound(workerRuntime.db, {
          accountId: winner.accountId,
          occurredAt: now,
          provider: "testpay",
          providerEventId: "bound-after-filter-code",
          subscriptionId: winnerSubscriptionId,
        }),
      ).resolves.toMatchObject({
        grant: expect.objectContaining({ startsAt: annualGrants[0]!.endsAt }),
        trialGranted: true,
      });
    } finally {
      await workerRuntime.sql.unsafe("RESET ROLE").catch(() => undefined);
      await workerRuntime.close();
    }

    const unused = codes[1]!;
    await expect(
      redeemFilterAnnualCode(handle.db, {
        accountId: filter.redeemed.accountId,
        now,
        token: unused.token,
      }),
    ).rejects.toMatchObject({ code: "filter_code_invalid" });
    await handle.db
      .update(filterProfiles)
      .set({ active: false, revokedAt: now, updatedAt: now })
      .where(eq(filterProfiles.accountId, filter.redeemed.accountId));
    await expect(
      redeemFilterAnnualCode(handle.db, {
        accountId: winner.accountId,
        now,
        token: unused.token,
      }),
    ).rejects.toMatchObject({ code: "filter_code_invalid" });
    expect(
      await handle.db
        .select()
        .from(membershipGrants)
        .where(eq(membershipGrants.kind, "filter_annual_redemption")),
    ).toHaveLength(1);
  });

  it("grants the direct first-subscription trial exactly once under Worker concurrency", async () => {
    const now = new Date("2026-08-04T10:00:00.000Z");
    const account = await createEmailAccount(
      "direct-trial-ledger@example.com",
      new Date("2026-01-05T00:00:00.000Z"),
    );
    const existingEndsAt = new Date("2026-11-30T10:00:00.000Z");
    await handle.db.insert(membershipGrants).values({
      accountId: account.accountId,
      endsAt: existingEndsAt,
      kind: "admin_grant",
      sourceId: "direct-trial-existing",
      startsAt: new Date("2026-07-01T10:00:00.000Z"),
      status: "active",
    });
    const subscriptionId = await createActiveSubscription({
      accountId: account.accountId,
      currentPeriodEnd: new Date("2027-08-04T10:00:00.000Z"),
      currentPeriodStart: now,
      provider: "testpay",
      suffix: "direct-trial",
    });
    const firstWorker = createDatabase(databaseUrl!, { maxConnections: 1 });
    const secondWorker = createDatabase(databaseUrl!, { maxConnections: 1 });
    try {
      await Promise.all([
        firstWorker.sql.unsafe("SET ROLE attention_worker_runtime"),
        secondWorker.sql.unsafe("SET ROLE attention_worker_runtime"),
      ]);
      const eventIds = ["bound-direct-one", "bound-direct-two"] as const;
      const results = await Promise.all([
        recordPaidSubscriptionBound(firstWorker.db, {
          accountId: account.accountId,
          occurredAt: now,
          provider: "testpay",
          providerEventId: eventIds[0],
          subscriptionId,
        }),
        recordPaidSubscriptionBound(secondWorker.db, {
          accountId: account.accountId,
          occurredAt: now,
          provider: "testpay",
          providerEventId: eventIds[1],
          subscriptionId,
        }),
      ]);
      expect(results.filter((result) => result.trialGranted)).toHaveLength(1);
      const winnerIndex = results.findIndex((result) => result.trialGranted);
      const winnerEventId = eventIds[winnerIndex]!;
      const replay = await recordPaidSubscriptionBound(firstWorker.db, {
        accountId: account.accountId,
        occurredAt: now,
        provider: "testpay",
        providerEventId: winnerEventId,
        subscriptionId,
      });
      expect(replay).toMatchObject({ duplicate: true, trialGranted: true });

      const directGrants = await handle.db
        .select()
        .from(membershipGrants)
        .where(eq(membershipGrants.kind, "direct_trial"));
      expect(directGrants).toEqual([
        expect.objectContaining({ accountId: account.accountId, startsAt: existingEndsAt }),
      ]);
      expect(
        await handle.db
          .select({
            consumedAt: accounts.directTrialConsumedAt,
            sourceEvent: accounts.directTrialSourceEventKey,
          })
          .from(accounts)
          .where(eq(accounts.id, account.accountId)),
      ).toEqual([
        expect.objectContaining({
          consumedAt: now,
          sourceEvent: `testpay:${winnerEventId}`,
        }),
      ]);
      expect(
        await handle.db
          .select()
          .from(growthBillingEvents)
          .where(eq(growthBillingEvents.eventType, "paid_subscription_bound")),
      ).toHaveLength(2);
    } finally {
      await Promise.all([
        firstWorker.sql.unsafe("RESET ROLE").catch(() => undefined),
        secondWorker.sql.unsafe("RESET ROLE").catch(() => undefined),
      ]);
      await Promise.all([firstWorker.close(), secondWorker.close()]);
    }
  });

  it("audits referral cash points, idempotent reversals, and nonnegative reservations", async () => {
    const now = new Date("2026-08-04T11:00:00.000Z");
    const inviter = await createEmailAccount(
      "points-inviter@example.com",
      new Date("2026-01-06T00:00:00.000Z"),
    );
    const invitation = await createConsumerInvite(handle.db, {
      accountId: inviter.accountId,
      now,
      ttlDays: 30,
    });
    const inviteeChallenge = await createLoginChallenge(handle.db, {
      consumerInviteToken: invitation.token,
      email: "points-invitee@example.com",
      now,
      requesterFingerprint: "d".repeat(64),
    });
    const invitee = await verifyLoginChallenge(handle.db, {
      acceptTerms: true,
      challengeId: inviteeChallenge.challengeId,
      code: inviteeChallenge.code,
      now,
    });
    const subscriptionId = await createActiveSubscription({
      accountId: invitee.accountId,
      currentPeriodEnd: new Date("2027-08-04T11:00:00.000Z"),
      currentPeriodStart: now,
      provider: "testpay",
      suffix: "points-invitee",
    });
    const worker = createDatabase(databaseUrl!, { maxConnections: 1 });
    const secondWorker = createDatabase(databaseUrl!, { maxConnections: 1 });
    const firstWeb = createDatabase(databaseUrl!, { maxConnections: 1 });
    const secondWeb = createDatabase(databaseUrl!, { maxConnections: 1 });
    try {
      await Promise.all([
        worker.sql.unsafe("SET ROLE attention_worker_runtime"),
        secondWorker.sql.unsafe("SET ROLE attention_worker_runtime"),
        firstWeb.sql.unsafe("SET ROLE attention_web_runtime"),
        secondWeb.sql.unsafe("SET ROLE attention_web_runtime"),
      ]);
      const settled = await recordSettledReferralRenewal(worker.db, {
        accountId: invitee.accountId,
        cashPaidMinor: 101,
        currency: "cny",
        occurredAt: now,
        provider: "testpay",
        providerEventId: "renewal-settled-101",
        subscriptionId,
      });
      expect(settled).toMatchObject({
        creditedAccountId: inviter.accountId,
        duplicate: false,
        pointsMinor: 15,
      });
      await expect(
        recordSettledReferralRenewal(worker.db, {
          accountId: invitee.accountId,
          cashPaidMinor: 101,
          currency: "CNY",
          occurredAt: now,
          provider: "testpay",
          providerEventId: "renewal-settled-101",
          subscriptionId,
        }),
      ).resolves.toMatchObject({ duplicate: true, pointsMinor: 15 });
      await expect(
        recordSettledReferralRenewal(worker.db, {
          accountId: invitee.accountId,
          cashPaidMinor: 102,
          currency: "CNY",
          occurredAt: now,
          provider: "testpay",
          providerEventId: "renewal-settled-101",
          subscriptionId,
        }),
      ).rejects.toMatchObject({ code: "billing_event_conflict" });

      const reservations = await Promise.allSettled([
        reserveRenewalPoints(firstWeb.db, {
          accountId: inviter.accountId,
          amountMinor: 10,
          currency: "CNY",
          idempotencyKey: "renewal-reservation-one",
          now,
        }),
        reserveRenewalPoints(secondWeb.db, {
          accountId: inviter.accountId,
          amountMinor: 10,
          currency: "CNY",
          idempotencyKey: "renewal-reservation-two",
          now,
        }),
      ]);
      const reserved = reservations.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      expect(reserved).toHaveLength(1);
      expect(
        reservations.flatMap((result) =>
          result.status === "rejected" ? [result.reason as { code?: string }] : [],
        ),
      ).toEqual([expect.objectContaining({ code: "insufficient_points" })]);

      const firstReversal = await recordReferralRenewalReversal(worker.db, {
        cashReversedMinor: 50,
        eventType: "renewal_refunded",
        occurredAt: now,
        originalProvider: "testpay",
        originalProviderEventId: "renewal-settled-101",
        provider: "testpay",
        providerEventId: "renewal-refund-50",
      });
      const secondReversal = await recordReferralRenewalReversal(worker.db, {
        cashReversedMinor: 51,
        eventType: "renewal_chargeback",
        occurredAt: now,
        originalProvider: "testpay",
        originalProviderEventId: "renewal-settled-101",
        provider: "testpay",
        providerEventId: "renewal-chargeback-51",
      });
      expect(firstReversal.pointsReversedMinor).toBe(7);
      expect(secondReversal.pointsReversedMinor).toBe(8);
      await expect(
        recordReferralRenewalReversal(worker.db, {
          cashReversedMinor: 50,
          eventType: "renewal_refunded",
          occurredAt: now,
          originalProvider: "testpay",
          originalProviderEventId: "different-original-event",
          provider: "testpay",
          providerEventId: "renewal-refund-50",
        }),
      ).rejects.toMatchObject({ code: "billing_event_conflict" });

      expect(
        await handle.db
          .select({
            availableMinor: pointsBalances.availableMinor,
            clawbackMinor: pointsBalances.clawbackMinor,
            reservedMinor: pointsBalances.reservedMinor,
          })
          .from(pointsBalances)
          .where(eq(pointsBalances.accountId, inviter.accountId)),
      ).toEqual([{ availableMinor: 0, clawbackMinor: 10, reservedMinor: 10 }]);
      await expect(
        consumeRenewalPoints(firstWeb.db, {
          accountId: inviter.accountId,
          now,
          reservationId: reserved[0]!.reservationId,
        }),
      ).rejects.toMatchObject({ code: "points_clawback_pending" });
      await expect(
        releaseRenewalPoints(firstWeb.db, {
          accountId: inviter.accountId,
          now,
          reservationId: reserved[0]!.reservationId,
        }),
      ).resolves.toEqual({ duplicate: false });

      await expect(
        recordSettledReferralRenewal(worker.db, {
          accountId: invitee.accountId,
          cashPaidMinor: 67,
          currency: "CNY",
          occurredAt: new Date("2026-09-04T11:00:00.000Z"),
          provider: "testpay",
          providerEventId: "renewal-settled-67",
          subscriptionId,
        }),
      ).resolves.toMatchObject({ pointsMinor: 10 });
      const spendable = await reserveRenewalPoints(firstWeb.db, {
        accountId: inviter.accountId,
        amountMinor: 10,
        currency: "CNY",
        idempotencyKey: "renewal-reservation-spendable",
        now: new Date("2026-09-04T11:00:00.000Z"),
      });
      await expect(
        consumeRenewalPoints(firstWeb.db, {
          accountId: inviter.accountId,
          now: new Date("2026-09-04T11:00:00.000Z"),
          reservationId: spendable.reservationId,
        }),
      ).resolves.toEqual({ duplicate: false });
      const [balance] = await handle.db
        .select()
        .from(pointsBalances)
        .where(eq(pointsBalances.accountId, inviter.accountId));
      expect(balance).toMatchObject({
        availableMinor: 0,
        clawbackMinor: 0,
        reservedMinor: 0,
      });
      expect(
        await handle.db
          .select()
          .from(pointsLedgerEntries)
          .where(eq(pointsLedgerEntries.accountId, inviter.accountId)),
      ).toHaveLength(8);
      expect(
        await handle.db
          .select()
          .from(pointsReservations)
          .where(eq(pointsReservations.accountId, inviter.accountId)),
      ).toHaveLength(2);

      const concurrentSettlement = await recordSettledReferralRenewal(worker.db, {
        accountId: invitee.accountId,
        cashPaidMinor: 100,
        currency: "CNY",
        occurredAt: new Date("2026-10-04T11:00:00.000Z"),
        provider: "testpay",
        providerEventId: "renewal-settled-concurrent-100",
        subscriptionId,
      });
      expect(concurrentSettlement).toMatchObject({
        creditedAccountId: inviter.accountId,
        duplicate: false,
        pointsMinor: 15,
      });
      const concurrentReversals = await Promise.allSettled([
        recordReferralRenewalReversal(worker.db, {
          cashReversedMinor: 60,
          eventType: "renewal_refunded",
          occurredAt: new Date("2026-10-05T11:00:00.000Z"),
          originalProvider: "testpay",
          originalProviderEventId: "renewal-settled-concurrent-100",
          provider: "testpay",
          providerEventId: "renewal-concurrent-refund-60",
        }),
        recordReferralRenewalReversal(secondWorker.db, {
          cashReversedMinor: 60,
          eventType: "renewal_chargeback",
          occurredAt: new Date("2026-10-05T11:00:00.000Z"),
          originalProvider: "testpay",
          originalProviderEventId: "renewal-settled-concurrent-100",
          provider: "testpay",
          providerEventId: "renewal-concurrent-chargeback-60",
        }),
      ]);
      expect(
        concurrentReversals.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        concurrentReversals.flatMap((result) =>
          result.status === "rejected" ? [result.reason as { code?: string }] : [],
        ),
      ).toEqual([expect.objectContaining({ code: "invalid_event" })]);
      expect(
        await handle.db
          .select({
            cashAmountMinor: growthBillingEvents.cashAmountMinor,
            pointsAmountMinor: growthBillingEvents.pointsAmountMinor,
          })
          .from(growthBillingEvents)
          .where(eq(growthBillingEvents.originalEventId, concurrentSettlement.eventId)),
      ).toEqual([{ cashAmountMinor: 60, pointsAmountMinor: 9 }]);
      expect(
        await handle.db
          .select({
            availableMinor: pointsBalances.availableMinor,
            clawbackMinor: pointsBalances.clawbackMinor,
            reservedMinor: pointsBalances.reservedMinor,
          })
          .from(pointsBalances)
          .where(eq(pointsBalances.accountId, inviter.accountId)),
      ).toEqual([{ availableMinor: 6, clawbackMinor: 0, reservedMinor: 0 }]);
    } finally {
      await Promise.all([
        worker.sql.unsafe("RESET ROLE").catch(() => undefined),
        secondWorker.sql.unsafe("RESET ROLE").catch(() => undefined),
        firstWeb.sql.unsafe("RESET ROLE").catch(() => undefined),
        secondWeb.sql.unsafe("RESET ROLE").catch(() => undefined),
      ]);
      await Promise.all([
        worker.close(),
        secondWorker.close(),
        firstWeb.close(),
        secondWeb.close(),
      ]);
    }
  });

  it("scopes growth attempt visibility and blocks token identity mutation for Web runtime", async () => {
    const now = new Date("2026-08-04T12:00:00.000Z");
    const first = await createEmailAccount(
      "growth-rls-one@example.com",
      new Date("2026-01-07T00:00:00.000Z"),
    );
    const second = await createEmailAccount(
      "growth-rls-two@example.com",
      new Date("2026-01-08T00:00:00.000Z"),
    );
    const invitation = await createConsumerInvite(handle.db, {
      accountId: first.accountId,
      now,
    });
    const fingerprint = "e".repeat(64);
    await handle.db.insert(growthTokenAttempts).values([
      {
        accountId: first.accountId,
        createdAt: now,
        tokenHash: "1".repeat(64),
        tokenKind: "filter_annual",
      },
      {
        accountId: second.accountId,
        createdAt: now,
        tokenHash: "2".repeat(64),
        tokenKind: "filter_annual",
      },
      {
        createdAt: now,
        requesterFingerprint: fingerprint,
        tokenHash: "3".repeat(64),
        tokenKind: "consumer_referral",
      },
    ]);
    const runtime = createDatabase(databaseUrl!, { maxConnections: 1 });
    try {
      await runtime.sql.unsafe("SET ROLE attention_web_runtime");
      const visibility = await runtime.sql.begin(async (transaction) => {
        const withoutContext = await transaction<{ id: string }[]>`
          SELECT id FROM growth_token_attempts
        `;
        await transaction`SELECT set_config('app.account_id', ${first.accountId}, true)`;
        const accountScoped = await transaction<{ account_id: string | null }[]>`
          SELECT account_id FROM growth_token_attempts ORDER BY account_id NULLS LAST
        `;
        await transaction`SELECT set_config('app.account_id', '', true)`;
        await transaction`
          SELECT set_config('app.growth_requester_fingerprint', ${fingerprint}, true)
        `;
        const fingerprintScoped = await transaction<{ requester_fingerprint: string | null }[]>`
          SELECT requester_fingerprint FROM growth_token_attempts
        `;
        return { accountScoped, fingerprintScoped, withoutContext };
      });
      expect(visibility.withoutContext).toEqual([]);
      expect(visibility.accountScoped).toEqual([{ account_id: first.accountId }]);
      expect(visibility.fingerprintScoped).toEqual([
        { requester_fingerprint: fingerprint },
      ]);

      await expect(
        runtime.sql.begin(async (transaction) => {
          await transaction`SELECT set_config('app.account_id', ${first.accountId}, true)`;
          await transaction`
            UPDATE consumer_referrals
            SET token_hash = ${"9".repeat(64)}
            WHERE id = ${invitation.invitationId}::uuid
          `;
        }),
      ).rejects.toThrow();
      await expect(
        runtime.sql.begin(async (transaction) => {
          await transaction`SELECT set_config('app.account_id', ${first.accountId}, true)`;
          await transaction`
            UPDATE consumer_referrals
            SET status = 'redeemed',
                invitee_account_id = ${second.accountId}::uuid,
                registered_at = ${now}
            WHERE id = ${invitation.invitationId}::uuid
          `;
        }),
      ).rejects.toThrow();
      await expect(
        runtime.sql`
          UPDATE growth_token_attempts
          SET requester_fingerprint = ${"f".repeat(64)}
        `,
      ).rejects.toThrow();

      const privileges = await handle.sql<{
        can_update_attempt_actor: boolean;
        can_update_consumer_token: boolean;
        can_update_filter_issuer: boolean;
        worker_can_update_direct_trial: boolean;
        worker_can_update_password: boolean;
      }[]>`
        SELECT
          has_column_privilege(
            'attention_web_runtime',
            'growth_token_attempts',
            'requester_fingerprint',
            'UPDATE'
          ) AS can_update_attempt_actor,
          has_column_privilege(
            'attention_web_runtime',
            'consumer_referrals',
            'token_hash',
            'UPDATE'
          ) AS can_update_consumer_token,
          has_column_privilege(
            'attention_web_runtime',
            'filter_annual_codes',
            'issuer_filter_account_id',
            'UPDATE'
          ) AS can_update_filter_issuer,
          has_column_privilege(
            'attention_worker_runtime',
            'accounts',
            'direct_trial_consumed_at',
            'UPDATE'
          ) AS worker_can_update_direct_trial,
          has_column_privilege(
            'attention_worker_runtime',
            'accounts',
            'password_hash',
            'UPDATE'
          ) AS worker_can_update_password
      `;
      expect(privileges).toEqual([
        {
          can_update_attempt_actor: false,
          can_update_consumer_token: false,
          can_update_filter_issuer: false,
          worker_can_update_direct_trial: true,
          worker_can_update_password: false,
        },
      ]);
    } finally {
      await runtime.sql.unsafe("RESET ROLE").catch(() => undefined);
      await runtime.close();
    }
  });
});
