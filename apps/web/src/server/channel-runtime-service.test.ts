import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CHANNEL_PAIRING_CHALLENGE_TTL_MS,
  ChannelRuntimeServiceError,
  assertObservedAtWithinSkew,
  deriveInstallationRegistration,
  hashPairingChallenge,
  isExactInstallationReplay,
  isExactRuntimeEventReplay,
  isPairingCodeMatch,
  isRuntimeHeartbeatSupported,
  mapChannelRuntimeDatabaseError,
} from "./channel-runtime-service";

const accountId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const clientId = "runtime-client-1";
const installationId = "11111111-1111-4111-8111-111111111111";

describe("local channel runtime service invariants", () => {
  it("derives owner and capabilities from the Agent manifest", () => {
    expect(deriveInstallationRegistration({
      accountId,
      clientId,
      input: {
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
      },
      now: new Date("2026-08-07T08:00:00.000Z"),
    })).toMatchObject({
      accountId,
      oauthClientId: clientId,
      ownerKind: "bridge",
      capabilities: {
        heartbeat_mode: "runtime",
        pairing_verification: true,
        restricted_profile: true,
      },
    });

    expect(() => deriveInstallationRegistration({
      accountId,
      clientId,
      input: {
        api_version: "1",
        installation_id: installationId,
        agent_integration_id: "codex",
        device_name: "Ethan's MacBook",
        adapter_version: "1.2.0",
        skill_version: "2.0.0",
        tool_contract_version: "2026-08-07",
        capabilities: {
          heartbeat_mode: "event_driven",
          pairing_verification: true,
          restricted_profile: false,
        },
      },
      now: new Date("2026-08-07T08:00:00.000Z"),
    })).toThrowError(expect.objectContaining({
      code: "capabilities_mismatch",
    }));
  });

  it("recognizes only an exact registration replay", () => {
    const registration = deriveInstallationRegistration({
      accountId,
      clientId,
      input: {
        api_version: "1",
        installation_id: installationId,
        agent_integration_id: "openclaw",
        device_name: "Home server",
        adapter_version: "1.0.0",
        skill_version: "2.0.0",
        tool_contract_version: "2026-08-07",
        capabilities: {
          heartbeat_mode: "runtime",
          pairing_verification: true,
          restricted_profile: false,
        },
      },
      now: new Date("2026-08-07T08:00:00.000Z"),
    });
    const stored = {
      ...registration,
      disconnectedAt: null,
      lastSeenAt: null,
      revokedAt: null,
      status: "registered" as const,
      updatedAt: registration.registeredAt,
    };

    expect(isExactInstallationReplay(stored, registration)).toBe(true);
    expect(isExactInstallationReplay(
      { ...stored, deviceName: "Different device" },
      registration,
    )).toBe(false);
    expect(isExactInstallationReplay(
      { ...stored, oauthClientId: "another-client" },
      registration,
    )).toBe(false);
  });

  it("stores an HMAC of challenge id plus code and compares it safely", () => {
    const secret = "runtime-pairing-secret-that-is-longer-than-32-characters";
    const challengeId = "33333333-3333-4333-8333-333333333333";
    const code = "A7K92Q";
    const expected = createHmac("sha256", secret)
      .update(`${challengeId}:${code}`, "utf8")
      .digest("hex");

    expect(hashPairingChallenge(secret, challengeId, code)).toBe(expected);
    expect(isPairingCodeMatch(secret, challengeId, code, expected)).toBe(true);
    expect(isPairingCodeMatch(secret, challengeId, "WRONG1", expected)).toBe(false);
    expect(`${challengeId}:${code}`).not.toContain(expected);
  });

  it("rejects short pairing secrets before hashing", () => {
    expect(() => hashPairingChallenge("too-short", installationId, "A7K92Q"))
      .toThrowError(expect.objectContaining({
        code: "pairing_secret_invalid",
      }));
  });

  it("uses server time by rejecting observations outside the bounded skew", () => {
    const now = new Date("2026-08-07T08:00:00.000Z");
    expect(assertObservedAtWithinSkew(
      "2026-08-07T07:55:00.000Z",
      now,
    )).toEqual(new Date("2026-08-07T07:55:00.000Z"));
    expect(assertObservedAtWithinSkew(
      "2026-08-07T08:05:00.000Z",
      now,
    )).toEqual(new Date("2026-08-07T08:05:00.000Z"));
    expect(() => assertObservedAtWithinSkew(
      "2026-08-07T08:05:00.001Z",
      now,
    )).toThrowError(expect.objectContaining({
      code: "observed_at_out_of_range",
    }));
    expect(assertObservedAtWithinSkew(
      "2026-08-07T07:50:00.000Z",
      now,
      CHANNEL_PAIRING_CHALLENGE_TTL_MS,
    )).toEqual(new Date("2026-08-07T07:50:00.000Z"));
  });

  it("reserves runtime heartbeats for manifest integrations with runtime heartbeat mode", () => {
    expect(isRuntimeHeartbeatSupported("codex")).toBe(true);
    expect(isRuntimeHeartbeatSupported("openclaw")).toBe(true);
    expect(isRuntimeHeartbeatSupported("workbuddy")).toBe(false);
  });

  it("accepts only exact event-ledger replays", () => {
    const expected = {
      accountId,
      dedupeKey: `channel-runtime:${accountId}:${clientId}:event-1`,
      eventType: "channel.binding.activity.v1" as const,
      metadata: {
        activity: "message_processed",
        binding_id: "22222222-2222-4222-8222-222222222222",
        installation_id: installationId,
      },
      now: new Date("2026-08-07T08:00:00.000Z"),
      requestId: "event-1",
    };
    expect(isExactRuntimeEventReplay({
      eventType: expected.eventType,
      metadata: expected.metadata,
      requestId: expected.requestId,
    }, expected)).toBe(true);
    expect(isExactRuntimeEventReplay({
      eventType: expected.eventType,
      metadata: { ...expected.metadata, binding_id: "another-binding" },
      requestId: expected.requestId,
    }, expected)).toBe(false);
    expect(isExactRuntimeEventReplay({
      eventType: "channel.binding.disconnected.v1",
      metadata: expected.metadata,
      requestId: expected.requestId,
    }, expected)).toBe(false);
  });

  it("maps only known unique constraints to stable conflict codes", () => {
    expect(mapChannelRuntimeDatabaseError({
      code: "23505",
      constraint_name: "agent_installations_oauth_client_unique",
    })).toMatchObject({ code: "oauth_client_conflict", status: 409 });
    expect(mapChannelRuntimeDatabaseError({
      cause: {
        code: "23505",
        constraint: "external_channel_bindings_active_owner_unique",
      },
    })).toMatchObject({ code: "channel_owner_conflict", status: 409 });
    expect(mapChannelRuntimeDatabaseError(new Error("database offline")))
      .toBeNull();
  });

  it("exposes stable typed service errors without leaking input", () => {
    const error = new ChannelRuntimeServiceError("pairing_code_invalid", 400);
    expect(error).toMatchObject({
      code: "pairing_code_invalid",
      message: "pairing_code_invalid",
      name: "ChannelRuntimeServiceError",
      status: 400,
    });
  });
});
