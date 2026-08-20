import { createHmac } from "node:crypto";

import { hashRuntimeInstallationId } from "@attention/auth";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  accounts,
  collections,
  contents,
  createDatabase,
  domains,
  eq,
  eventLedger,
  agentInstallations,
  externalChannelBindingChallenges,
  externalChannelBindings,
  oauthClients,
  oauthConnections,
  type DatabaseHandle,
} from "@attention/db";
import { migrateDatabase } from "@attention/db/migrate";

import {
  ChannelRuntimeService,
  type RuntimePrincipal,
} from "./channel-runtime-service";

// This suite truncates lifecycle tables and therefore deliberately requires a
// dedicated database instead of sharing TEST_DATABASE_URL with db-auth.test.
const databaseUrl = process.env.TEST_CHANNEL_RUNTIME_DATABASE_URL;
const accountId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const installationId = "11111111-1111-4111-8111-111111111111";
const challengeId = "33333333-3333-4333-8333-333333333333";
const bindingId = "22222222-2222-4222-8222-222222222222";
const clientId = "runtime-integration-client";
const replacementAccountId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const replacementClientId = "runtime-replacement-client";
const replacementInstallationId = "44444444-4444-4444-8444-444444444444";
const pairingSecret =
  "runtime-pairing-secret-that-is-longer-than-32-characters";

const principal: RuntimePrincipal = { accountId, clientId };
const registration = {
  api_version: "1",
  installation_id: installationId,
  agent_integration_id: "codex",
  device_name: "Integration Mac",
  adapter_version: "1.2.0",
  skill_version: "2.0.0",
  tool_contract_version: "2026-08-07",
  capabilities: {
    heartbeat_mode: "runtime",
    pairing_verification: true,
    restricted_profile: true,
  },
} as const;
const runtimeCheckpoint = {
  bridge_status: "online",
  ilink_status: "connected",
  codex_phase: "restarting",
  last_healthy_at: "2026-08-07T08:00:00.000Z",
  last_successful_message_at: "2026-08-07T07:59:00.000Z",
  last_error_code: "codex_runtime_crashed",
  pending_inbound: 2,
  pending_outbound: 0,
} as const;

describe.skipIf(!databaseUrl)("local channel runtime service with PostgreSQL", () => {
  let handle: DatabaseHandle;
  let now = new Date("2026-08-07T08:00:00.000Z");

  async function asWebRuntime<T>(
    run: (runtime: DatabaseHandle) => Promise<T>,
  ): Promise<T> {
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
    vi.stubEnv(
      "ATTENTION_HMAC_SECRET",
      "runtime-service-integration-secret-at-least-32-characters",
    );
    handle = createDatabase(databaseUrl!, { maxConnections: 2 });
    await migrateDatabase(handle.db);
  });

  beforeEach(async () => {
    await handle.sql.unsafe(
      "TRUNCATE TABLE external_channel_binding_challenges, external_channel_bindings, agent_installations, event_ledger, oauth_clients, accounts RESTART IDENTITY CASCADE",
    );
    await handle.db.insert(accounts).values({
      id: accountId,
      stableHandle: "runtime-integration-account",
    });
    await handle.db.insert(oauthClients).values({
      allowedScopes: [
        "runtime:register",
        "runtime:heartbeat",
        "channel:bind:report",
        "channel:disconnect:report",
      ],
      clientId,
      name: "Runtime integration client",
      redirectUris: ["http://127.0.0.1/callback"],
    });
    now = new Date("2026-08-07T08:00:00.000Z");
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await handle.close();
  });

  it("rebinds an installation only after its trusted logical connection rotates DCR clients", async () => {
    const oldService = new ChannelRuntimeService(handle.db, {
      now: () => now,
      pairingSecret,
    });
    await oldService.registerInstallation(principal, registration);

    const nextClientId = "runtime-integration-client-rotated";
    const installationKeyHash = hashRuntimeInstallationId(installationId);
    await handle.db.insert(oauthClients).values({
      allowedScopes: [
        "runtime:register",
        "runtime:heartbeat",
        "channel:bind:report",
        "channel:disconnect:report",
      ],
      clientId: nextClientId,
      connectionKind: "runtime",
      deviceName: registration.device_name,
      installationKeyHash,
      name: "Rotated Runtime integration client",
      redirectUris: ["http://127.0.0.1/rotated-callback"],
    });
    await handle.db.insert(oauthConnections).values({
      accountId,
      audience: "attention-channel-runtime",
      clientId: nextClientId,
      deviceName: registration.device_name,
      installationKeyHash,
      kind: "runtime",
      label: "Integration Mac",
      lastAuthorizedAt: now,
      normalizedLabel: "integration mac",
    });

    const rotatedPrincipal = { accountId, clientId: nextClientId };
    await expect(oldService.registerInstallation(
      rotatedPrincipal,
      registration,
    )).resolves.toMatchObject({ installation_id: installationId });
    const [stored] = await handle.db.select().from(agentInstallations);
    expect(stored?.oauthClientId).toBe(nextClientId);
    await expect(oldService.getInstallation(rotatedPrincipal, installationId))
      .resolves.toMatchObject({ installation_id: installationId });
    await expect(oldService.getInstallation(principal, installationId))
      .rejects.toMatchObject({ code: "installation_not_found", status: 404 });
  });

  it("updates release metadata without replacing the logical device installation", async () => {
    const service = new ChannelRuntimeService(handle.db, {
      now: () => now,
      pairingSecret,
    });
    await service.registerInstallation(principal, registration);
    now = new Date("2026-08-07T08:01:00.000Z");

    await expect(
      service.registerInstallation(principal, {
        ...registration,
        adapter_version: "1.2.1",
        skill_version: "2.0.1",
        tool_contract_version: "2026-08-08",
      }),
    ).resolves.toMatchObject({
      adapter_version: "1.2.1",
      installation_id: installationId,
      skill_version: "2.0.1",
      tool_contract_version: "2026-08-08",
    });
    const [stored] = await handle.db.select().from(agentInstallations);
    expect(stored).toMatchObject({
      adapterVersion: "1.2.1",
      id: installationId,
      oauthClientId: clientId,
      skillVersion: "2.0.1",
      toolContractVersion: "2026-08-08",
      updatedAt: now,
    });
  });

  it("atomically retires a cross-account owner and tombstones its WeChat session", async () => {
    const channelFingerprint = "a".repeat(64);
    const oldSessionFingerprint = "b".repeat(64);
    const newSessionFingerprint = "c".repeat(64);
    const service = new ChannelRuntimeService(handle.db, {
      now: () => now,
      pairingSecret,
    });
    await service.registerInstallation(principal, registration);
    await handle.db.insert(externalChannelBindings).values({
      accountId,
      channelAccountFingerprint: channelFingerprint,
      channelSessionFingerprint: oldSessionFingerprint,
      createdAt: now,
      id: bindingId,
      installationId,
      pairedPeerFingerprint: "d".repeat(64),
      provider: "wechat_ilink",
      status: "healthy",
      updatedAt: now,
      verifiedAt: now,
    });
    await handle.db.insert(externalChannelBindingChallenges).values({
      accountId,
      bindingId,
      expiresAt: new Date("2026-08-07T08:10:00.000Z"),
      id: challengeId,
      issuedAt: now,
      pairingCodeHash: "e".repeat(64),
    });
    await handle.db.insert(accounts).values({
      id: replacementAccountId,
      stableHandle: "runtime-replacement-account",
    });
    await handle.db.insert(oauthClients).values({
      allowedScopes: [
        "runtime:register",
        "runtime:heartbeat",
        "channel:bind:report",
        "channel:disconnect:report",
      ],
      clientId: replacementClientId,
      name: "Replacement Runtime client",
      redirectUris: ["http://127.0.0.1/replacement-callback"],
    });
    const replacementPrincipal = {
      accountId: replacementAccountId,
      clientId: replacementClientId,
    };
    await service.registerInstallation(replacementPrincipal, {
      ...registration,
      installation_id: replacementInstallationId,
    });

    async function replaceOwner(sessionFingerprint: string | null) {
      return asWebRuntime((runtime) => runtime.sql.begin(async (tx) => {
        await tx`select set_config('app.account_id', ${replacementAccountId}, true)`;
        const [row] = await tx<{ outcome: string }[]>`
          select public.replace_active_channel_binding_owner(
            ${replacementAccountId}::uuid,
            ${replacementInstallationId}::uuid,
            'wechat_ilink'::public.local_channel_provider,
            ${channelFingerprint}::char(64),
            ${sessionFingerprint}::char(64),
            ${now.toISOString()}::timestamptz
          ) as outcome
        `;
        return row?.outcome;
      }));
    }

    await expect(replaceOwner(newSessionFingerprint)).resolves.toBe(
      "replaced",
    );
    const [retiredBinding] = await handle.db
      .select()
      .from(externalChannelBindings)
      .where(eq(externalChannelBindings.id, bindingId));
    const [retiredChallenge] = await handle.db
      .select()
      .from(externalChannelBindingChallenges)
      .where(eq(externalChannelBindingChallenges.id, challengeId));
    expect(retiredBinding).toMatchObject({
      accountId,
      channelSessionFingerprint: oldSessionFingerprint,
      status: "revoked",
    });
    expect(retiredBinding?.revokedAt).toEqual(now);
    expect(retiredChallenge?.revokedAt).toEqual(now);
    await expect(replaceOwner(oldSessionFingerprint)).resolves.toBe(
      "channel_session_superseded",
    );
    await expect(replaceOwner(null)).resolves.toBe(
      "channel_session_proof_required",
    );
  });

  it("returns a summary only to a verified device for a prior WeChat collection", async () => {
    const contentId = "77777777-7777-4777-8777-777777777777";
    const domainId = "88888888-8888-4888-8888-888888888888";
    const notificationId = "99999999-9999-4999-8999-999999999999";
    const service = new ChannelRuntimeService(handle.db, {
      now: () => now,
      pairingSecret,
    });
    await service.registerInstallation(principal, registration);
    await handle.db.insert(externalChannelBindings).values({
      accountId,
      channelAccountFingerprint: "a".repeat(64),
      createdAt: now,
      id: bindingId,
      installationId,
      pairedPeerFingerprint: "b".repeat(64),
      provider: "wechat_ilink",
      status: "healthy",
      updatedAt: now,
      verifiedAt: now,
    });
    await handle.db.insert(domains).values({
      id: domainId,
      name: "AI",
      slug: "ai-notification",
    });
    await handle.db.insert(contents).values({
      aiSummary: "已经完成的摘要。",
      canonicalUrl: "https://example.com/article",
      contentType: "article",
      id: contentId,
      normalizedUrl: "https://example.com/article",
      outboundUrl: "https://example.com/article",
      source: "generic_web",
      summaryStatus: "ready",
      title: "测试文章",
    });
    await handle.db.insert(collections).values({
      accountId,
      collectedAt: new Date("2026-08-07T07:59:00.000Z"),
      contentId,
      domainId,
      sourceChannel: "wechat",
      visibility: "private",
    });
    await handle.db.insert(eventLedger).values({
      accountId: null,
      contentId,
      dedupeKey: `content.summary.ready.v1:${contentId}`,
      eventType: "content.summary.ready.v1",
      id: notificationId,
      metadata: { schema_version: 1 },
      occurredAt: now,
      requestId: "summary-job",
      scope: "private",
    });

    await expect(asWebRuntime((runtime) =>
      new ChannelRuntimeService(runtime.db, {
        now: () => now,
        pairingSecret,
      }).listSummaryNotifications(principal, {
        after: null,
        bindingId,
        installationId,
        limit: 20,
      })
    )).resolves.toEqual({
      items: [{
        completed_at: now.toISOString(),
        content_id: contentId,
        notification_id: notificationId,
        original_url: "https://example.com/article",
        summary: "已经完成的摘要。",
        title: "测试文章",
      }],
      nextCursor: `${now.toISOString()}|${notificationId}`,
    });

    await handle.db
      .update(collections)
      .set({ collectedAt: new Date("2026-08-07T08:01:00.000Z") })
      .where(eq(collections.accountId, accountId));
    await expect(asWebRuntime((runtime) =>
      new ChannelRuntimeService(runtime.db, {
        now: () => now,
        pairingSecret,
      }).listSummaryNotifications(principal, {
        after: null,
        bindingId,
        installationId,
        limit: 20,
      })
    )).resolves.toEqual({ items: [], nextCursor: null });
  });

  it("persists the complete lifecycle without storing the pairing code", async () => {
    const generatedIds = [challengeId, bindingId];
    const service = new ChannelRuntimeService(handle.db, {
      generateId: () => {
        const id = generatedIds.shift();
        if (!id) throw new Error("unexpected id request");
        return id;
      },
      generatePairingCode: () => "A7K92Q",
      now: () => now,
      pairingSecret,
    });

    const registered = await service.registerInstallation(principal, registration);
    expect(registered).toMatchObject({
      installation_id: installationId,
      owner_kind: "bridge",
      status: "registered",
    });
    expect(await service.registerInstallation(principal, registration)).toEqual(
      registered,
    );

    now = new Date("2026-08-07T08:01:00.000Z");
    const heartbeat = await service.recordInstallationHeartbeat(principal, {
      api_version: "1",
      event_id: "44444444-4444-4444-8444-444444444444",
      installation_id: installationId,
      observed_at: "2026-08-07T08:00:30.000Z",
      runtime_checkpoint: runtimeCheckpoint,
      runtime_health: "active",
    });
    expect(heartbeat).toMatchObject({
      last_seen_at: "2026-08-07T08:01:00.000Z",
      status: "active",
      runtime_checkpoint: runtimeCheckpoint,
    });
    expect(await service.recordInstallationHeartbeat(principal, {
      api_version: "1",
      event_id: "44444444-4444-4444-8444-444444444444",
      installation_id: installationId,
      observed_at: "2026-08-07T08:00:30.000Z",
      runtime_checkpoint: runtimeCheckpoint,
      runtime_health: "active",
    })).toEqual(heartbeat);

    now = new Date("2026-08-07T08:01:30.000Z");
    const healthyCheckpoint = {
      ...runtimeCheckpoint,
      codex_phase: "healthy" as const,
      last_error_code: null,
      pending_inbound: 0,
    };
    const newerHeartbeat = await service.recordInstallationHeartbeat(principal, {
      api_version: "1",
      event_id: "99999999-9999-4999-8999-999999999999",
      installation_id: installationId,
      observed_at: "2026-08-07T08:01:30.000Z",
      runtime_checkpoint: healthyCheckpoint,
      runtime_health: "active",
    });
    expect(newerHeartbeat.runtime_checkpoint).toEqual(healthyCheckpoint);
    const [storedInstallation] = await handle.db
      .select()
      .from(agentInstallations);
    expect(storedInstallation?.runtimeCheckpoint).toEqual(healthyCheckpoint);
    await expect(service.getInstallation(
      {
        accountId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        clientId,
      },
      installationId,
    )).rejects.toMatchObject({ code: "installation_not_found", status: 404 });

    const challenge = await service.createChannelBinding(principal, {
      api_version: "1",
      channel_account_fingerprint: "a".repeat(64),
      installation_id: installationId,
      provider: "wechat_ilink",
    });
    expect(challenge).toMatchObject({
      binding_id: bindingId,
      challenge_id: challengeId,
      pairing_code: "A7K92Q",
    });
    const [storedChallenge] = await handle.db
      .select()
      .from(externalChannelBindingChallenges);
    expect(storedChallenge?.pairingCodeHash).toBe(
      createHmac("sha256", pairingSecret)
        .update(`${challengeId}:A7K92Q`, "utf8")
        .digest("hex"),
    );
    expect(storedChallenge).not.toHaveProperty("pairingCode");

    now = new Date("2026-08-07T08:02:00.000Z");
    const verified = await service.verifyPairing(principal, {
      api_version: "1",
      binding_id: bindingId,
      challenge_id: challengeId,
      event_id: "55555555-5555-4555-8555-555555555555",
      installation_id: installationId,
      observed_at: "2026-08-07T08:01:30.000Z",
      paired_peer_fingerprint: "b".repeat(64),
      pairing_code: "A7K92Q",
    });
    expect(verified).toMatchObject({
      last_seen_at: "2026-08-07T08:02:00.000Z",
      status: "verified",
      verified_at: "2026-08-07T08:02:00.000Z",
    });
    await expect(service.createChannelBinding(principal, {
      api_version: "1",
      channel_account_fingerprint: "a".repeat(64),
      installation_id: installationId,
      provider: "wechat_ilink",
    })).rejects.toMatchObject({ code: "binding_already_bound", status: 409 });

    now = new Date("2026-08-07T08:03:00.000Z");
    const healthy = await service.recordChannelActivity(principal, {
      activity: "message_processed",
      api_version: "1",
      binding_id: bindingId,
      event_id: "66666666-6666-4666-8666-666666666666",
      installation_id: installationId,
      observed_at: "2026-08-07T08:02:45.000Z",
    });
    expect(healthy).toMatchObject({
      last_seen_at: "2026-08-07T08:03:00.000Z",
      status: "healthy",
    });

    now = new Date("2026-08-07T08:04:00.000Z");
    const disconnected = await service.disconnectChannelBinding(principal, {
      api_version: "1",
      binding_id: bindingId,
      disconnected_at: "2026-08-07T08:03:30.000Z",
      event_id: "77777777-7777-4777-8777-777777777777",
      installation_id: installationId,
      reason: "local_requested",
    });
    expect(disconnected).toMatchObject({
      disconnected_at: "2026-08-07T08:04:00.000Z",
      status: "disconnected",
    });

    now = new Date("2026-08-07T08:05:00.000Z");
    const revoked = await service.revokeInstallation(principal, {
      event_id: "88888888-8888-4888-8888-888888888888",
      installation_id: installationId,
      reason: "user_requested",
    });
    expect(revoked).toMatchObject({
      installation: {
        revoked_at: "2026-08-07T08:05:00.000Z",
        status: "revoked",
      },
      oauthClientId: clientId,
    });
    expect(await handle.db.select().from(oauthClients)).toEqual([
      expect.objectContaining({ active: true, clientId }),
    ]);

    const events = await handle.db.select().from(eventLedger);
    expect(events).toHaveLength(8);
    expect(JSON.stringify(events)).not.toContain("A7K92Q");
  });
});
