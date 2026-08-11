import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  agentInstallations,
  eventLedger,
  type AttentionDatabase,
  type AttentionTransaction,
} from "@attention/db";

import {
  CHANNEL_PAIRING_CHALLENGE_TTL_MS,
  ChannelRuntimeService,
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
const runtimeCheckpoint = {
  bridge_status: "online",
  ilink_status: "connected",
  codex_phase: "restarting",
  last_healthy_at: "2026-08-10T10:00:00.000Z",
  last_successful_message_at: "2026-08-10T09:59:00.000Z",
  last_error_code: "codex_runtime_crashed",
  pending_inbound: 2,
  pending_outbound: 0,
} as const;

function sqlParameterValues(value: unknown): unknown[] {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return [value];
  }
  if (!value || typeof value !== "object") return [];
  const candidate = value as { queryChunks?: unknown[]; value?: unknown };
  if (Array.isArray(candidate.queryChunks)) {
    return candidate.queryChunks.flatMap(sqlParameterValues);
  }
  if (
    Object.hasOwn(candidate, "value") &&
    (typeof candidate.value === "string" ||
      typeof candidate.value === "number" ||
      typeof candidate.value === "boolean")
  ) {
    return [candidate.value];
  }
  return [];
}

function heartbeatDatabase() {
  let currentAccountId = "";
  let installation = {
    accountId,
    adapterVersion: "1.2.0",
    agentIntegrationId: "codex" as const,
    capabilities: {
      heartbeat_mode: "runtime" as const,
      pairing_verification: true as const,
      restricted_profile: true,
    },
    deviceName: "Runtime Mac",
    disconnectedAt: null,
    id: installationId,
    lastSeenAt: null as Date | null,
    oauthClientId: clientId,
    ownerKind: "bridge" as const,
    registeredAt: new Date("2026-08-10T09:00:00.000Z"),
    revokedAt: null,
    runtimeCheckpoint: null as typeof runtimeCheckpoint | null,
    skillVersion: "2.0.0",
    status: "registered" as
      | "registered"
      | "active"
      | "degraded"
      | "stale"
      | "disconnected"
      | "revoked",
    toolContractVersion: "2026-08-10",
    updatedAt: new Date("2026-08-10T09:00:00.000Z"),
  };
  const events = new Map<string, {
    eventType: string;
    metadata: Record<string, unknown>;
    requestId: string | null;
  }>();

  const installationRows = (condition: unknown) => {
    const values = sqlParameterValues(condition);
    return currentAccountId === installation.accountId &&
        values.includes(installation.id) &&
        values.includes(installation.accountId) &&
        values.includes(installation.oauthClientId)
      ? [installation]
      : [];
  };
  const eventRows = (condition: unknown) => {
    const values = sqlParameterValues(condition);
    const dedupeKey = values.find(
      (value): value is string =>
        typeof value === "string" && value.startsWith("channel-runtime:"),
    );
    const stored = dedupeKey ? events.get(dedupeKey) : undefined;
    return stored && currentAccountId === installation.accountId
      ? [stored]
      : [];
  };

  const transaction = {
    execute: async (statement: unknown) => {
      currentAccountId = sqlParameterValues(statement).find(
        (value): value is string =>
          typeof value === "string" &&
          /^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(value),
      ) ?? "";
      return [];
    },
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (table !== eventLedger) return [];
            const dedupeKey = String(values.dedupeKey);
            if (events.has(dedupeKey)) return [];
            events.set(dedupeKey, {
              eventType: String(values.eventType),
              metadata: values.metadata as Record<string, unknown>,
              requestId: String(values.requestId),
            });
            return [{ id: "99999999-9999-4999-8999-999999999999" }];
          },
        }),
      }),
    }),
    select: () => ({
      from: (table: unknown) => ({
        where: (condition: unknown) => {
          const rows = table === agentInstallations
            ? installationRows(condition)
            : table === eventLedger
            ? eventRows(condition)
            : [];
          return {
            for: () => ({ limit: async () => rows }),
            limit: async () => rows,
          };
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: (condition: unknown) => ({
          returning: async () => {
            if (
              table !== agentInstallations ||
              installationRows(condition).length === 0
            ) {
              return [];
            }
            installation = { ...installation, ...values } as typeof installation;
            return [installation];
          },
        }),
      }),
    }),
  } as unknown as AttentionTransaction;
  const database = {
    transaction: async <T>(
      callback: (tx: AttentionTransaction) => Promise<T>,
    ): Promise<T> => callback(transaction),
  } as unknown as AttentionDatabase;

  return { database, eventCount: () => events.size };
}

describe("local channel runtime service invariants", () => {
  it("persists only accepted heartbeat checkpoints and leaves replays idempotent", async () => {
    const fake = heartbeatDatabase();
    let now = new Date("2026-08-10T10:00:00.000Z");
    const service = new ChannelRuntimeService(fake.database, {
      now: () => now,
      pairingSecret: "runtime-pairing-secret-that-is-longer-than-32-characters",
    });
    const firstHeartbeat = {
      api_version: "1",
      event_id: "55555555-5555-4555-8555-555555555555",
      installation_id: installationId,
      observed_at: "2026-08-10T10:00:00.000Z",
      runtime_checkpoint: runtimeCheckpoint,
      runtime_health: "active",
    } as const;

    const first = await service.recordInstallationHeartbeat(
      { accountId, clientId },
      firstHeartbeat,
    );
    now = new Date("2026-08-10T10:01:00.000Z");
    const replay = await service.recordInstallationHeartbeat(
      { accountId, clientId },
      firstHeartbeat,
    );
    const newerCheckpoint = {
      ...runtimeCheckpoint,
      codex_phase: "healthy" as const,
      last_error_code: null,
      pending_inbound: 0,
    };
    await expect(service.recordInstallationHeartbeat(
      { accountId, clientId },
      { ...firstHeartbeat, runtime_checkpoint: newerCheckpoint },
    )).rejects.toMatchObject({ code: "event_replay_conflict", status: 409 });
    now = new Date("2026-08-10T10:02:00.000Z");
    const latest = await service.recordInstallationHeartbeat(
      { accountId, clientId },
      {
        ...firstHeartbeat,
        event_id: "66666666-6666-4666-8666-666666666666",
        observed_at: "2026-08-10T10:02:00.000Z",
        runtime_checkpoint: newerCheckpoint,
      },
    );

    expect(first.runtime_checkpoint).toEqual(runtimeCheckpoint);
    expect(replay).toEqual(first);
    expect(latest.runtime_checkpoint).toEqual(newerCheckpoint);
    expect(fake.eventCount()).toBe(2);
  });

  it("does not return another account's installation checkpoint", async () => {
    const fake = heartbeatDatabase();
    const service = new ChannelRuntimeService(fake.database, {
      pairingSecret: "runtime-pairing-secret-that-is-longer-than-32-characters",
    });

    await expect(service.getInstallation(
      {
        accountId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        clientId,
      },
      installationId,
    )).rejects.toMatchObject({ code: "installation_not_found", status: 404 });
  });

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
      runtimeCheckpoint: null,
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
