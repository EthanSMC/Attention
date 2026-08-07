import { describe, expect, it } from "vitest";

import {
  CHANNEL_BINDING_STATUS_TRANSITIONS,
  CHANNEL_RUNTIME_RESOURCE,
  CHANNEL_RUNTIME_SCOPES,
  ChannelActivityReportSchema,
  ChannelBindingChallengeSchema,
  ChannelBindingViewSchema,
  ChannelRuntimeResourceSchema,
  ChannelRuntimeScopeSchema,
  CreateChannelBindingRequestSchema,
  DisconnectChannelBindingRequestSchema,
  InstallationHeartbeatSchema,
  InstallationViewSchema,
  OpaqueSha256FingerprintSchema,
  PairingVerificationReportSchema,
  RegisterInstallationRequestSchema,
  RevokeChannelBindingRequestSchema,
  canTransitionChannelBindingStatus,
  canTransitionInstallationStatus,
  isChannelProviderSupportedByAgent,
} from "./channel-runtime";

const installationId = "11111111-1111-4111-8111-111111111111";
const bindingId = "22222222-2222-4222-8222-222222222222";
const challengeId = "33333333-3333-4333-8333-333333333333";
const eventId = "44444444-4444-4444-8444-444444444444";
const channelFingerprint = "a".repeat(64);
const peerFingerprint = "b".repeat(64);

const registration = {
  api_version: "1",
  installation_id: installationId,
  agent_integration_id: "codex",
  device_name: "Ethan's MacBook",
  adapter_version: "1.2.0",
  skill_version: "2.0.0",
  tool_contract_version: "2026-08-07",
  capabilities: {
    heartbeat_mode: "runtime",
    pairing_verification: true,
    restricted_profile: true,
  },
} as const;

const createBinding = {
  api_version: "1",
  installation_id: installationId,
  provider: "wechat_ilink",
  channel_account_fingerprint: channelFingerprint,
} as const;

const challenge = {
  binding_id: bindingId,
  challenge_id: challengeId,
  pairing_code: "A7K92Q",
  issued_at: "2026-08-07T08:00:00.000Z",
  expires_at: "2026-08-07T08:10:00.000Z",
} as const;

const verification = {
  api_version: "1",
  event_id: eventId,
  installation_id: installationId,
  binding_id: bindingId,
  challenge_id: challengeId,
  pairing_code: "A7K92Q",
  paired_peer_fingerprint: peerFingerprint,
  observed_at: "2026-08-07T08:02:00.000Z",
} as const;

const installationHeartbeat = {
  api_version: "1",
  event_id: "55555555-5555-4555-8555-555555555555",
  installation_id: installationId,
  runtime_health: "active",
  observed_at: "2026-08-07T08:03:00.000Z",
} as const;

const channelActivity = {
  api_version: "1",
  event_id: "88888888-8888-4888-8888-888888888888",
  installation_id: installationId,
  binding_id: bindingId,
  activity: "message_processed",
  observed_at: "2026-08-07T08:03:00.000Z",
} as const;

const verifiedBindingView = {
  binding_id: bindingId,
  installation_id: installationId,
  provider: "wechat_ilink",
  channel_account_fingerprint: channelFingerprint,
  paired_peer_fingerprint: peerFingerprint,
  status: "verified",
  created_at: "2026-08-07T08:00:00.000Z",
  verified_at: "2026-08-07T08:02:00.000Z",
  last_seen_at: "2026-08-07T08:02:00.000Z",
  disconnected_at: null,
  revoked_at: null,
} as const;

describe("local channel runtime v1 contract", () => {
  it("accepts a complete installation and binding lifecycle", () => {
    expect(RegisterInstallationRequestSchema.parse(registration)).toEqual(
      registration,
    );
    expect(CreateChannelBindingRequestSchema.parse(createBinding)).toEqual(
      createBinding,
    );
    expect(ChannelBindingChallengeSchema.parse(challenge)).toEqual(challenge);

    expect(
      ChannelBindingViewSchema.parse({
        ...verifiedBindingView,
        paired_peer_fingerprint: null,
        status: "reported",
        verified_at: null,
        last_seen_at: null,
      }),
    ).toMatchObject({ status: "reported", verified_at: null });
    expect(PairingVerificationReportSchema.parse(verification)).toEqual(
      verification,
    );
    expect(ChannelBindingViewSchema.parse(verifiedBindingView)).toEqual(
      verifiedBindingView,
    );
    expect(InstallationHeartbeatSchema.parse(installationHeartbeat)).toEqual(
      installationHeartbeat,
    );
    expect(ChannelActivityReportSchema.parse(channelActivity)).toEqual(
      channelActivity,
    );
    expect(
      ChannelBindingViewSchema.parse({
        ...verifiedBindingView,
        status: "healthy",
        last_seen_at: channelActivity.observed_at,
      }),
    ).toMatchObject({ status: "healthy" });

    const disconnect = {
      api_version: "1",
      event_id: "66666666-6666-4666-8666-666666666666",
      installation_id: installationId,
      binding_id: bindingId,
      reason: "owner_switch",
      disconnected_at: "2026-08-07T08:04:00.000Z",
    } as const;
    expect(DisconnectChannelBindingRequestSchema.parse(disconnect)).toEqual(
      disconnect,
    );
    expect(
      ChannelBindingViewSchema.parse({
        ...verifiedBindingView,
        status: "disconnected",
        disconnected_at: disconnect.disconnected_at,
      }),
    ).toMatchObject({ status: "disconnected" });

    const revoke = {
      api_version: "1",
      event_id: "77777777-7777-4777-8777-777777777777",
      installation_id: installationId,
      binding_id: bindingId,
      reason: "user_requested",
      revoked_at: "2026-08-07T08:05:00.000Z",
    } as const;
    expect(RevokeChannelBindingRequestSchema.parse(revoke)).toEqual(revoke);
    expect(
      ChannelBindingViewSchema.parse({
        ...verifiedBindingView,
        status: "revoked",
        revoked_at: revoke.revoked_at,
      }),
    ).toMatchObject({ status: "revoked" });
  });

  it("ties installations and provider support to the Agent manifest IDs", () => {
    expect(
      RegisterInstallationRequestSchema.safeParse({
        ...registration,
        agent_integration_id: "unknown-agent",
      }).success,
    ).toBe(false);
    expect(isChannelProviderSupportedByAgent("codex", "wechat_ilink")).toBe(
      true,
    );
    expect(
      isChannelProviderSupportedByAgent("codex", "workbuddy_wechat"),
    ).toBe(false);
    expect(
      isChannelProviderSupportedByAgent("workbuddy", "workbuddy_wechat"),
    ).toBe(true);
  });

  it("defines deterministic, idempotent state transitions", () => {
    expect(canTransitionInstallationStatus("registered", "active")).toBe(
      true,
    );
    expect(canTransitionInstallationStatus("active", "active")).toBe(true);
    expect(canTransitionInstallationStatus("revoked", "active")).toBe(false);

    expect(canTransitionChannelBindingStatus("reported", "verified")).toBe(
      true,
    );
    expect(canTransitionChannelBindingStatus("verified", "healthy")).toBe(
      true,
    );
    expect(canTransitionChannelBindingStatus("healthy", "stale")).toBe(true);
    expect(canTransitionChannelBindingStatus("stale", "healthy")).toBe(true);
    expect(canTransitionChannelBindingStatus("revoked", "healthy")).toBe(
      false,
    );
    for (const [status, transitions] of Object.entries(
      CHANNEL_BINDING_STATUS_TRANSITIONS,
    )) {
      expect(transitions).toContain(status);
    }
  });

  it("defines the exact runtime OAuth resource and narrow scopes", () => {
    expect(CHANNEL_RUNTIME_RESOURCE).toBe("attention-channel-runtime");
    expect(ChannelRuntimeResourceSchema.parse(CHANNEL_RUNTIME_RESOURCE)).toBe(
      CHANNEL_RUNTIME_RESOURCE,
    );
    expect(CHANNEL_RUNTIME_SCOPES).toEqual([
      "runtime:register",
      "runtime:heartbeat",
      "channel:bind:report",
      "channel:disconnect:report",
    ]);
    for (const scope of CHANNEL_RUNTIME_SCOPES) {
      expect(ChannelRuntimeScopeSchema.parse(scope)).toBe(scope);
    }
    expect(ChannelRuntimeResourceSchema.safeParse("attention-mcp").success)
      .toBe(false);
    expect(ChannelRuntimeScopeSchema.safeParse("channel:write").success).toBe(
      false,
    );
  });

  it("keeps installation health independent from binding activity", () => {
    expect(InstallationHeartbeatSchema.parse(installationHeartbeat)).toEqual(
      installationHeartbeat,
    );
    expect(
      InstallationHeartbeatSchema.safeParse({
        ...installationHeartbeat,
        binding_id: bindingId,
      }).success,
    ).toBe(false);
    expect(
      ChannelActivityReportSchema.safeParse({
        ...channelActivity,
        activity: "runtime_heartbeat",
      }).success,
    ).toBe(false);
    expect(
      ChannelActivityReportSchema.safeParse({
        ...channelActivity,
        binding_id: undefined,
      }).success,
    ).toBe(false);
  });

  it("requires UUIDs, ISO datetimes, bounded labels and lowercase digests", () => {
    expect(OpaqueSha256FingerprintSchema.safeParse(channelFingerprint).success)
      .toBe(true);
    expect(OpaqueSha256FingerprintSchema.safeParse("A".repeat(64)).success)
      .toBe(false);
    expect(OpaqueSha256FingerprintSchema.safeParse("a".repeat(63)).success)
      .toBe(false);
    expect(
      RegisterInstallationRequestSchema.safeParse({
        ...registration,
        installation_id: "not-a-uuid",
      }).success,
    ).toBe(false);
    expect(
      RegisterInstallationRequestSchema.safeParse({
        ...registration,
        device_name: "x".repeat(101),
      }).success,
    ).toBe(false);
    expect(
      InstallationHeartbeatSchema.safeParse({
        ...installationHeartbeat,
        observed_at: "Friday morning",
      }).success,
    ).toBe(false);
    expect(
      ChannelBindingChallengeSchema.safeParse({
        ...challenge,
        expires_at: challenge.issued_at,
      }).success,
    ).toBe(false);
  });

  it("rejects raw secrets, cursors, messages and QR material", () => {
    const forbiddenPayloads = [
      [RegisterInstallationRequestSchema, registration, "ilink_token"],
      [CreateChannelBindingRequestSchema, createBinding, "bot_token"],
      [CreateChannelBindingRequestSchema, createBinding, "sync_cursor"],
      [PairingVerificationReportSchema, verification, "context_token"],
      [PairingVerificationReportSchema, verification, "message_body"],
      [InstallationHeartbeatSchema, installationHeartbeat, "cursor"],
      [ChannelActivityReportSchema, channelActivity, "context_token"],
      [DisconnectChannelBindingRequestSchema, {
        api_version: "1",
        event_id: eventId,
        installation_id: installationId,
        binding_id: bindingId,
        reason: "local_requested",
        disconnected_at: "2026-08-07T08:04:00.000Z",
      }, "qr_code"],
      [RevokeChannelBindingRequestSchema, {
        api_version: "1",
        event_id: eventId,
        installation_id: installationId,
        binding_id: bindingId,
        reason: "security",
        revoked_at: "2026-08-07T08:05:00.000Z",
      }, "qr"],
      [ChannelBindingViewSchema, verifiedBindingView, "message_body"],
    ] as const;

    for (const [schema, payload, forbiddenField] of forbiddenPayloads) {
      expect(
        schema.safeParse({
          ...payload,
          [forbiddenField]: "must-never-cross-the-control-plane",
        }).success,
        forbiddenField,
      ).toBe(false);
    }
  });

  it("rejects lifecycle views whose status contradicts their timestamps", () => {
    expect(
      ChannelBindingViewSchema.safeParse({
        ...verifiedBindingView,
        status: "reported",
      }).success,
    ).toBe(false);
    expect(
      ChannelBindingViewSchema.safeParse({
        ...verifiedBindingView,
        status: "disconnected",
        disconnected_at: null,
      }).success,
    ).toBe(false);
    expect(
      InstallationViewSchema.safeParse({
        installation_id: installationId,
        agent_integration_id: "codex",
        owner_kind: "bridge",
        device_name: "Ethan's MacBook",
        adapter_version: "1.2.0",
        skill_version: "2.0.0",
        tool_contract_version: "2026-08-07",
        capabilities: registration.capabilities,
        status: "revoked",
        registered_at: "2026-08-07T08:00:00.000Z",
        last_seen_at: null,
        disconnected_at: null,
        revoked_at: null,
      }).success,
    ).toBe(false);
  });
});
