import type {
  ChannelBindingChallenge,
  ChannelBindingView,
  InstallationView,
} from "@attention/contracts";
import type { AttentionDatabase } from "@attention/db";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OAuthCloudPrincipal } from "./cloud-credentials";
import {
  MAX_CHANNEL_RUNTIME_BODY_BYTES,
  handleChannelBindingActivity,
  handleCreateChannelBinding,
  handleDisconnectChannelBinding,
  handleGetChannelBinding,
  handleGetInstallation,
  handleInstallationHeartbeat,
  handleListChannelBindings,
  handleListInstallations,
  handleRegisterInstallation,
  handleRevokeInstallation,
  handleVerifyChannelBinding,
  resolveChannelPairingSecret,
  type ChannelRuntimeHttpDependencies,
  type ChannelRuntimeHttpService,
} from "./channel-runtime-http";

afterEach(() => {
  vi.unstubAllEnvs();
});

const accountId = "11111111-1111-4111-8111-111111111111";
const installationId = "22222222-2222-4222-8222-222222222222";
const bindingId = "33333333-3333-4333-8333-333333333333";
const challengeId = "44444444-4444-4444-8444-444444444444";
const eventId = "55555555-5555-4555-8555-555555555555";
const observedAt = "2026-08-07T08:00:00.000Z";
const fingerprint = "a".repeat(64);
const peerFingerprint = "b".repeat(64);
const runtimeCheckpoint = {
  bridge_status: "online",
  ilink_status: "connected",
  codex_phase: "restarting",
  last_healthy_at: "2026-08-07T07:59:00.000Z",
  last_successful_message_at: "2026-08-07T07:58:00.000Z",
  last_error_code: "codex_runtime_crashed",
  pending_inbound: 2,
  pending_outbound: 0,
} as const;

const principal: OAuthCloudPrincipal = {
  accountId,
  clientId: "runtime-client",
  credentialId: "token-id",
  credentialKind: "oauth",
  isFilter: false,
  isMember: true,
  scopes: [
    "runtime:register",
    "runtime:heartbeat",
    "channel:bind:report",
    "channel:disconnect:report",
  ],
};

const installation: InstallationView = {
  adapter_version: "1.0.0",
  agent_integration_id: "openclaw",
  capabilities: {
    heartbeat_mode: "runtime",
    pairing_verification: true,
    restricted_profile: false,
  },
  device_name: "Ethan Mac",
  disconnected_at: null,
  installation_id: installationId,
  last_seen_at: null,
  owner_kind: "native",
  registered_at: observedAt,
  revoked_at: null,
  runtime_checkpoint: null,
  skill_version: "1.0.0",
  status: "registered",
  tool_contract_version: "1.0.0",
};

const binding: ChannelBindingView = {
  binding_id: bindingId,
  channel_account_fingerprint: fingerprint,
  created_at: observedAt,
  disconnected_at: null,
  installation_id: installationId,
  last_seen_at: observedAt,
  paired_peer_fingerprint: peerFingerprint,
  provider: "wechat_ilink",
  revoked_at: null,
  status: "healthy",
  verified_at: observedAt,
};

const challenge: ChannelBindingChallenge = {
  binding_id: bindingId,
  challenge_id: challengeId,
  expires_at: "2026-08-07T08:10:00.000Z",
  issued_at: observedAt,
  pairing_code: "ABCD2345",
};

function service(
  overrides: Partial<ChannelRuntimeHttpService> = {},
): ChannelRuntimeHttpService {
  return {
    createChannelBinding: vi.fn(async () => challenge),
    disconnectChannelBinding: vi.fn(async () => binding),
    getChannelBinding: vi.fn(async () => binding),
    getInstallation: vi.fn(async () => installation),
    listChannelBindings: vi.fn(async () => [binding]),
    listInstallations: vi.fn(async () => [installation]),
    recordChannelActivity: vi.fn(async () => binding),
    recordInstallationHeartbeat: vi.fn(async () => installation),
    registerInstallation: vi.fn(async () => installation),
    revokeInstallation: vi.fn(async () => ({
      installation: {
        ...installation,
        revoked_at: observedAt,
        status: "revoked" as const,
      },
      oauthClientId: principal.clientId,
    })),
    verifyPairing: vi.fn(async () => binding),
    ...overrides,
  };
}

function dependencies(
  runtimeService = service(),
  principalValue: OAuthCloudPrincipal | null = principal,
): ChannelRuntimeHttpDependencies & {
  createService: ReturnType<typeof vi.fn>;
  resolvePrincipal: ReturnType<typeof vi.fn>;
  revokeRuntimeAuthorization: ReturnType<typeof vi.fn>;
} {
  return {
    createService: vi.fn(() => runtimeService),
    getDatabase: vi.fn(() => ({} as AttentionDatabase)),
    resolvePrincipal: vi.fn(async () => principalValue),
    revokeRuntimeAuthorization: vi.fn(async () => true),
  };
}

function jsonRequest(
  path: string,
  body: unknown,
  method = "POST",
): Request {
  return new Request(`https://attention.example${path}`, {
    body: JSON.stringify(body),
    headers: {
      authorization: "Bearer runtime-token",
      "content-type": "application/json",
    },
    method,
  });
}

function registerBody(agentIntegrationId: "openclaw" | "workbuddy" = "openclaw") {
  const workbuddy = agentIntegrationId === "workbuddy";
  return {
    adapter_version: "1.0.0",
    agent_integration_id: agentIntegrationId,
    api_version: "1",
    capabilities: {
      heartbeat_mode: workbuddy ? "event_driven" : "runtime",
      pairing_verification: true,
      restricted_profile: false,
    },
    device_name: "Ethan Mac",
    installation_id: installationId,
    skill_version: "1.0.0",
    tool_contract_version: "1.0.0",
  };
}

describe("channel runtime HTTP authorization", () => {
  it("rejects PAT-shaped credentials and advertises runtime metadata", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    const deps = dependencies(service(), null);
    const response = await handleListInstallations(
      new Request("https://attention.example/api/runtime/installations", {
        headers: { authorization: "Bearer att_pat_example" },
      }),
      deps,
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "invalid_token" },
    });
    expect(response.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://attention.example/.well-known/oauth-protected-resource/api/runtime"',
    );
    expect(response.headers.get("www-authenticate")).toContain(
      'scope="runtime:register"',
    );
    expect(deps.createService).not.toHaveBeenCalled();
  });

  it("returns a scoped 403 before touching the service", async () => {
    const deps = dependencies(service(), { ...principal, scopes: [] });
    const response = await handleListChannelBindings(
      new Request(
        `https://attention.example/api/runtime/channel-bindings?installation_id=${installationId}`,
        { headers: { authorization: "Bearer wrong-scope" } },
      ),
      deps,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "insufficient_scope" },
    });
    expect(response.headers.get("www-authenticate")).toContain(
      'scope="channel:bind:report"',
    );
    expect(deps.createService).not.toHaveBeenCalled();
  });

  it("does not accept WorkBuddy's host-managed channel over runtime HTTP", async () => {
    const runtimeService = service();
    const deps = dependencies(runtimeService);
    const response = await handleRegisterInstallation(
      jsonRequest("/api/runtime/installations", registerBody("workbuddy")),
      deps,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: { code: "control_plane_not_supported" },
    });
    expect(runtimeService.registerInstallation).not.toHaveBeenCalled();
  });
});

describe("channel runtime pairing secret", () => {
  it("accepts an independent server-only secret", () => {
    expect(resolveChannelPairingSecret({
      ATTENTION_AUTH_SECRET: "b".repeat(64),
      ATTENTION_CHANNEL_PAIRING_SECRET: "a".repeat(64),
      ATTENTION_CHANNEL_SECRET: "c".repeat(64),
    })).toBe("a".repeat(64));
  });

  it("rejects short or reused secrets", () => {
    expect(() => resolveChannelPairingSecret({
      ATTENTION_CHANNEL_PAIRING_SECRET: "too-short",
    })).toThrow("at least 32 characters");
    expect(() => resolveChannelPairingSecret({
      ATTENTION_AUTH_SECRET: "a".repeat(64),
      ATTENTION_CHANNEL_PAIRING_SECRET: "a".repeat(64),
    })).toThrow("independent from ATTENTION_AUTH_SECRET");
  });
});

describe("channel runtime HTTP request contracts", () => {
  it("cancels an oversized streamed request before creating the service", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      pull(controller) {
        controller.enqueue(
          new Uint8Array(MAX_CHANNEL_RUNTIME_BODY_BYTES + 1),
        );
      },
    });
    const request = new Request(
      "https://attention.example/api/runtime/installations",
      {
        body: stream,
        duplex: "half",
        headers: {
          authorization: "Bearer runtime-token",
          "content-type": "application/json",
        },
        method: "POST",
      } as RequestInit & { duplex: "half" },
    );
    const deps = dependencies();
    const response = await handleRegisterInstallation(request, deps);

    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(deps.createService).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: { code: "request_too_large" },
    });
  });

  it("rejects unknown JSON fields", async () => {
    const deps = dependencies();
    const response = await handleRegisterInstallation(
      jsonRequest("/api/runtime/installations", {
        ...registerBody(),
        raw_wechat_token: "must-never-be-accepted",
      }),
      deps,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "invalid_request" },
    });
    expect(deps.createService).not.toHaveBeenCalled();
  });

  it("rejects privacy-sensitive fields inside a runtime checkpoint", async () => {
    const deps = dependencies();
    const response = await handleInstallationHeartbeat(
      jsonRequest(`/api/runtime/installations/${installationId}/heartbeat`, {
        api_version: "1",
        event_id: eventId,
        installation_id: installationId,
        observed_at: observedAt,
        runtime_checkpoint: { ...runtimeCheckpoint, thread_id: "secret" },
        runtime_health: "active",
      }),
      { installationId },
      deps,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "invalid_request" },
    });
    expect(deps.createService).not.toHaveBeenCalled();
  });

  it("rejects a binding id that disagrees with the route", async () => {
    const deps = dependencies();
    const response = await handleChannelBindingActivity(
      jsonRequest(`/api/runtime/channel-bindings/${bindingId}/activity`, {
        activity: "message_processed",
        api_version: "1",
        binding_id: "66666666-6666-4666-8666-666666666666",
        event_id: eventId,
        installation_id: installationId,
        observed_at: observedAt,
      }),
      { bindingId },
      deps,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "invalid_request" },
    });
  });

  it("rejects duplicate or unknown list query parameters", async () => {
    const deps = dependencies();
    const response = await handleListChannelBindings(
      new Request(
        `https://attention.example/api/runtime/channel-bindings?installation_id=${installationId}&installation_id=${installationId}&cursor=bad`,
        { headers: { authorization: "Bearer runtime-token" } },
      ),
      deps,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "invalid_request" },
    });
  });
});

describe("channel runtime HTTP route operations", () => {
  it("registers an installation and returns the contract view", async () => {
    const runtimeService = service();
    const response = await handleRegisterInstallation(
      jsonRequest("/api/runtime/installations", registerBody()),
      dependencies(runtimeService),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ installation });
    expect(runtimeService.registerInstallation).toHaveBeenCalledWith(
      { accountId, clientId: principal.clientId },
      registerBody(),
    );
  });

  it("returns the accepted runtime checkpoint in the installation view", async () => {
    const checkpointView = {
      ...installation,
      last_seen_at: observedAt,
      runtime_checkpoint: runtimeCheckpoint,
      status: "degraded" as const,
    };
    const runtimeService = service({
      recordInstallationHeartbeat: vi.fn(async () => checkpointView),
    });
    const response = await handleInstallationHeartbeat(
      jsonRequest(`/api/runtime/installations/${installationId}/heartbeat`, {
        api_version: "1",
        event_id: eventId,
        installation_id: installationId,
        observed_at: observedAt,
        runtime_checkpoint: runtimeCheckpoint,
        runtime_health: "degraded",
      }),
      { installationId },
      dependencies(runtimeService),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      installation: checkpointView,
    });
  });

  it("routes installation and binding state operations to the core service", async () => {
    const runtimeService = service();
    const deps = dependencies(runtimeService);

    const listInstallations = await handleListInstallations(
      new Request("https://attention.example/api/runtime/installations", {
        headers: { authorization: "Bearer runtime-token" },
      }),
      deps,
    );
    const getInstallation = await handleGetInstallation(
      new Request(
        `https://attention.example/api/runtime/installations/${installationId}`,
        { headers: { authorization: "Bearer runtime-token" } },
      ),
      { installationId },
      deps,
    );
    const heartbeat = await handleInstallationHeartbeat(
      jsonRequest(
        `/api/runtime/installations/${installationId}/heartbeat`,
        {
          api_version: "1",
          event_id: eventId,
          installation_id: installationId,
          observed_at: observedAt,
          runtime_checkpoint: runtimeCheckpoint,
          runtime_health: "active",
        },
      ),
      { installationId },
      deps,
    );
    const createBinding = await handleCreateChannelBinding(
      jsonRequest("/api/runtime/channel-bindings", {
        api_version: "1",
        channel_account_fingerprint: fingerprint,
        installation_id: installationId,
        provider: "wechat_ilink",
      }),
      deps,
    );
    const listBindings = await handleListChannelBindings(
      new Request(
        `https://attention.example/api/runtime/channel-bindings?installation_id=${installationId}`,
        { headers: { authorization: "Bearer runtime-token" } },
      ),
      deps,
    );
    const getBinding = await handleGetChannelBinding(
      new Request(
        `https://attention.example/api/runtime/channel-bindings/${bindingId}?installation_id=${installationId}`,
        { headers: { authorization: "Bearer runtime-token" } },
      ),
      { bindingId },
      deps,
    );
    const verify = await handleVerifyChannelBinding(
      jsonRequest(`/api/runtime/channel-bindings/${bindingId}/verify`, {
        api_version: "1",
        binding_id: bindingId,
        challenge_id: challengeId,
        event_id: eventId,
        installation_id: installationId,
        observed_at: observedAt,
        paired_peer_fingerprint: peerFingerprint,
        pairing_code: "ABCD2345",
      }),
      { bindingId },
      deps,
    );
    const activity = await handleChannelBindingActivity(
      jsonRequest(`/api/runtime/channel-bindings/${bindingId}/activity`, {
        activity: "message_processed",
        api_version: "1",
        binding_id: bindingId,
        event_id: eventId,
        installation_id: installationId,
        observed_at: observedAt,
      }),
      { bindingId },
      deps,
    );
    const disconnect = await handleDisconnectChannelBinding(
      jsonRequest(`/api/runtime/channel-bindings/${bindingId}/disconnect`, {
        api_version: "1",
        binding_id: bindingId,
        disconnected_at: observedAt,
        event_id: eventId,
        installation_id: installationId,
        reason: "local_requested",
      }),
      { bindingId },
      deps,
    );

    expect(listInstallations.status).toBe(200);
    expect(getInstallation.status).toBe(200);
    expect(heartbeat.status).toBe(200);
    expect(createBinding.status).toBe(201);
    expect(listBindings.status).toBe(200);
    expect(getBinding.status).toBe(200);
    expect(verify.status).toBe(200);
    expect(activity.status).toBe(200);
    expect(disconnect.status).toBe(200);
    expect(runtimeService.recordInstallationHeartbeat).toHaveBeenCalledOnce();
    expect(runtimeService.createChannelBinding).toHaveBeenCalledOnce();
    expect(runtimeService.verifyPairing).toHaveBeenCalledOnce();
    expect(runtimeService.recordChannelActivity).toHaveBeenCalledOnce();
    expect(runtimeService.disconnectChannelBinding).toHaveBeenCalledOnce();
  });

  it("revokes the installation and its dedicated runtime OAuth tokens", async () => {
    const runtimeService = service();
    const deps = dependencies(runtimeService);
    const response = await handleRevokeInstallation(
      jsonRequest(
        `/api/runtime/installations/${installationId}`,
        {
          api_version: "1",
          event_id: eventId,
          reason: "user_requested",
        },
        "DELETE",
      ),
      { installationId },
      deps,
    );

    expect(response.status).toBe(200);
    expect(deps.revokeRuntimeAuthorization).toHaveBeenCalledWith(
      expect.anything(),
      {
        accountId,
        clientId: principal.clientId,
        installationId,
      },
    );
    await expect(response.json()).resolves.toMatchObject({
      installation: { installation_id: installationId, status: "revoked" },
      tokens_revoked: true,
    });
  });
});
