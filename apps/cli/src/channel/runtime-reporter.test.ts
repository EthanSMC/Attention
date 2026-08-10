import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeCheckpoint } from "./state";
import {
  RUNTIME_REPORTER_SCOPES,
  createRuntimeReporter,
  type RuntimeReporterOptions,
  type RuntimeReporterSnapshot,
} from "./runtime-reporter";

const installationId = "11111111-1111-4111-8111-111111111111";
const bindingId = "22222222-2222-4222-8222-222222222222";
const challengeId = "33333333-3333-4333-8333-333333333333";
const observedAt = "2026-08-10T10:00:00.000Z";
const fingerprint = "a".repeat(64);

const checkpoint: RuntimeCheckpoint = {
  activeTurnMessageRef:
    "msg-72cad190ed71ed0309138ac14e9982dbc21abd357ff0820d",
  lastErrorCode: "codex_runtime_crashed",
  lastHealthyAt: "2026-08-10T09:59:00.000Z",
  lastSuccessfulMessageAt: "2026-08-10T09:58:00.000Z",
  lastTransitionAt: observedAt,
  nextRetryAt: "2026-08-10T10:00:01.000Z",
  phase: "restarting",
  retryAttempt: 1,
};

const snapshot: RuntimeReporterSnapshot = {
  bridgeStatus: "degraded",
  checkpoint,
  ilinkStatus: "connected",
  pendingInbound: 2,
  pendingOutbound: 1,
};

const installation = {
  adapter_version: "0.1.0",
  agent_integration_id: "codex",
  capabilities: {
    heartbeat_mode: "runtime",
    pairing_verification: true,
    restricted_profile: true,
  },
  device_name: "Ethan Mac",
  disconnected_at: null,
  installation_id: installationId,
  last_seen_at: null,
  owner_kind: "bridge",
  registered_at: observedAt,
  revoked_at: null,
  runtime_checkpoint: null,
  skill_version: "1.4.0",
  status: "registered",
  tool_contract_version: "2026-08-10",
};

const challenge = {
  binding_id: bindingId,
  challenge_id: challengeId,
  expires_at: "2026-08-10T10:10:00.000Z",
  issued_at: observedAt,
  pairing_code: "ABCD2345",
};

interface SeenRequest {
  readonly body: Record<string, unknown>;
  readonly headers: Headers;
  readonly url: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function identity(binding: string | null = bindingId) {
  return {
    adapterVersion: "0.1.0",
    agentIntegrationId: "codex" as const,
    bindingId: binding,
    channelAccountFingerprint: fingerprint,
    deviceName: "Ethan Mac",
    installationId,
    provider: "wechat_ilink" as const,
    restrictedProfile: true,
    skillVersion: "1.4.0",
    toolContractVersion: "2026-08-10",
  };
}

function reporterOptions(
  overrides: Partial<RuntimeReporterOptions> = {},
): RuntimeReporterOptions {
  let event = 4;
  return {
    accessTokenProvider: {
      accessToken: async () => "runtime-access-token",
    },
    eventId: () =>
      `${String(event++).repeat(8)}-${String(event - 1).repeat(4)}-4${String(event - 1).repeat(3)}-8${String(event - 1).repeat(3)}-${String(event - 1).repeat(12)}`,
    fetchImpl: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/installations")) {
        return jsonResponse({ installation }, 201);
      }
      return jsonResponse({ installation: { ...installation, status: "active" } });
    },
    identity: identity(),
    now: () => new Date(observedAt),
    runtimeBaseUrl: "https://attention.example/api/runtime",
    snapshot,
    ...overrides,
  };
}

async function waitForRequests(
  requests: readonly SeenRequest[],
  count: number,
): Promise<void> {
  await vi.waitFor(() => expect(requests).toHaveLength(count));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RuntimeReporter bootstrap", () => {
  it("registers the supplied installation then reports its fingerprinted binding", async () => {
    const requests: SeenRequest[] = [];
    const tokenRequests: Array<{
      forceRefresh: boolean;
      resource: string;
      scopes: readonly string[];
    }> = [];
    const seenChallenges: unknown[] = [];
    const reporter = createRuntimeReporter(reporterOptions({
      accessTokenProvider: {
        accessToken: async (request) => {
          tokenRequests.push(request);
          return "runtime-access-token";
        },
      },
      fetchImpl: async (url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push({ body, headers: new Headers(init?.headers), url: String(url) });
        if (String(url).endsWith("/installations")) {
          return jsonResponse({ installation }, 201);
        }
        return jsonResponse({ challenge }, 201);
      },
      identity: identity(null),
      onBindingChallenge: (value) => seenChallenges.push(value),
    }));

    expect(reporter.start()).toBeUndefined();
    await waitForRequests(requests, 2);

    expect(requests.map((request) => request.url)).toEqual([
      "https://attention.example/api/runtime/installations",
      "https://attention.example/api/runtime/channel-bindings",
    ]);
    expect(requests[0]?.body).toEqual({
      adapter_version: "0.1.0",
      agent_integration_id: "codex",
      api_version: "1",
      capabilities: {
        heartbeat_mode: "runtime",
        pairing_verification: true,
        restricted_profile: true,
      },
      device_name: "Ethan Mac",
      installation_id: installationId,
      skill_version: "1.4.0",
      tool_contract_version: "2026-08-10",
    });
    expect(requests[1]?.body).toEqual({
      api_version: "1",
      channel_account_fingerprint: fingerprint,
      installation_id: installationId,
      provider: "wechat_ilink",
    });
    expect(seenChallenges).toEqual([challenge]);
    expect(reporter.snapshot().bindingId).toBe(bindingId);
    expect(tokenRequests.every((request) =>
      request.resource === "https://attention.example/api/runtime" &&
      request.forceRefresh === false &&
      JSON.stringify(request.scopes) === JSON.stringify(RUNTIME_REPORTER_SCOPES)
    )).toBe(true);
    expect(requests.every((request) =>
      request.headers.get("authorization") === "Bearer runtime-access-token"
    )).toBe(true);

    await reporter.stop();
  });

  it("never includes local tokens, thread/message refs, URLs, replies, or raw ids in payloads", async () => {
    const bodies: string[] = [];
    const reporter = createRuntimeReporter(reporterOptions({
      fetchImpl: async (url, init) => {
        bodies.push(String(init?.body));
        if (String(url).endsWith("/installations")) {
          return jsonResponse({ installation }, 201);
        }
        return jsonResponse({ installation: { ...installation, status: "degraded" } });
      },
    }));

    reporter.start();
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    reporter.transition(snapshot);
    await vi.waitFor(() => expect(bodies).toHaveLength(2));

    const sent = bodies.join("\n");
    expect(sent).not.toContain("runtime-access-token");
    expect(sent).not.toContain("activeTurnMessageRef");
    expect(sent).not.toContain(checkpoint.activeTurnMessageRef);
    for (const forbidden of [
      '"token"',
      '"thread_id"',
      '"message"',
      '"url"',
      '"reply"',
      '"account_id"',
      '"owner_user_id"',
    ]) {
      expect(sent).not.toContain(forbidden);
    }

    await reporter.stop();
  });
});

describe("RuntimeReporter scheduling and delivery", () => {
  it("keeps transition non-throwing when event construction fails", async () => {
    const reporter = createRuntimeReporter(reporterOptions({
      eventId: () => {
        throw new Error("uuid source unavailable");
      },
    }));

    reporter.start();
    await vi.waitFor(() => expect(reporter.snapshot().status).toBe("active"));
    expect(() => reporter.transition(snapshot)).not.toThrow();
    await vi.waitFor(() => expect(reporter.snapshot().status).toBe("degraded"));
    await reporter.stop();
  });

  it("heartbeats every sixty seconds and immediately on transition", async () => {
    vi.useFakeTimers();
    const requests: SeenRequest[] = [];
    const reporter = createRuntimeReporter(reporterOptions({
      fetchImpl: async (url, init) => {
        requests.push({
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
          headers: new Headers(init?.headers),
          url: String(url),
        });
        return String(url).endsWith("/installations")
          ? jsonResponse({ installation }, 201)
          : jsonResponse({ installation: { ...installation, status: "degraded" } });
      },
    }));

    reporter.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(1);

    expect(reporter.transition(snapshot)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(requests[1]?.url).toBe(
      `https://attention.example/api/runtime/installations/${installationId}/heartbeat`,
    );
    expect(requests[1]?.body).toMatchObject({
      api_version: "1",
      installation_id: installationId,
      runtime_checkpoint: {
        bridge_status: "degraded",
        codex_phase: "restarting",
        ilink_status: "connected",
        last_error_code: "codex_runtime_crashed",
        pending_inbound: 2,
        pending_outbound: 1,
      },
      runtime_health: "degraded",
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(requests[2]?.url).toBe(
      `https://attention.example/api/runtime/installations/${installationId}/heartbeat`,
    );

    const stopping = reporter.stop();
    await vi.advanceTimersByTimeAsync(0);
    await stopping;
  });

  it("reuses one refreshed token and event id when 401 recovery hits a network retry", async () => {
    const heartbeatBodies: Record<string, unknown>[] = [];
    const heartbeatTokens: Array<string | null> = [];
    const refreshFlags: boolean[] = [];
    let heartbeatAttempts = 0;
    const reporter = createRuntimeReporter(reporterOptions({
      accessTokenProvider: {
        accessToken: async ({ forceRefresh }) => {
          refreshFlags.push(forceRefresh);
          return forceRefresh ? "fresh-token" : "stale-token";
        },
      },
      fetchImpl: async (url, init) => {
        if (String(url).endsWith("/installations")) {
          return jsonResponse({ installation }, 201);
        }
        heartbeatAttempts += 1;
        heartbeatTokens.push(new Headers(init?.headers).get("authorization"));
        heartbeatBodies.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>,
        );
        if (heartbeatAttempts === 1) {
          return jsonResponse({ error: { code: "invalid_token" } }, 401);
        }
        if (heartbeatAttempts === 2) throw new Error("network unavailable");
        return jsonResponse({ installation: { ...installation, status: "degraded" } });
      },
      retryBackoffMs: [1],
      sleep: async () => undefined,
    }));

    reporter.start();
    await vi.waitFor(() => expect(refreshFlags).toHaveLength(1));
    reporter.transition(snapshot);
    await vi.waitFor(() => expect(heartbeatBodies).toHaveLength(3));

    expect(new Set(heartbeatBodies.map((body) => body.event_id)).size).toBe(1);
    expect(heartbeatTokens).toEqual([
      "Bearer stale-token",
      "Bearer fresh-token",
      "Bearer fresh-token",
    ]);
    expect(refreshFlags).toEqual([false, false, true]);
    await reporter.stop();
  });

  it("retries network failures exponentially without reordering later activity", async () => {
    const paths: string[] = [];
    const eventIds: unknown[] = [];
    const delays: number[] = [];
    let failures = 2;
    const reporter = createRuntimeReporter(reporterOptions({
      fetchImpl: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/installations")) {
          return jsonResponse({ installation }, 201);
        }
        paths.push(path);
        eventIds.push(
          (JSON.parse(String(init?.body)) as Record<string, unknown>).event_id,
        );
        if (path.endsWith("/heartbeat") && failures-- > 0) {
          throw new Error("network unavailable");
        }
        return path.endsWith("/activity")
          ? jsonResponse({ binding: {} })
          : jsonResponse({ installation: { ...installation, status: "degraded" } });
      },
      retryBackoffMs: [1_000, 2_000, 4_000],
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    }));

    reporter.start();
    await vi.waitFor(() => expect(paths).toHaveLength(0));
    reporter.transition(snapshot);
    reporter.activity();
    await vi.waitFor(() => expect(paths).toHaveLength(4));

    expect(delays).toEqual([1_000, 2_000]);
    expect(paths.slice(0, 3).every((path) => path.endsWith("/heartbeat"))).toBe(true);
    expect(paths[3]).toBe(
      `/api/runtime/channel-bindings/${bindingId}/activity`,
    );
    expect(new Set(eventIds.slice(0, 3)).size).toBe(1);
    await reporter.stop();
  });

  it("reports verified binding activity without blocking the caller", async () => {
    let release: (() => void) | undefined;
    const activityStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const paths: string[] = [];
    const reporter = createRuntimeReporter(reporterOptions({
      fetchImpl: async (url) => {
        const path = new URL(String(url)).pathname;
        paths.push(path);
        if (path.endsWith("/installations")) {
          return jsonResponse({ installation }, 201);
        }
        await activityStarted;
        return jsonResponse({ binding: {} });
      },
    }));

    reporter.start();
    await vi.waitFor(() => expect(paths).toHaveLength(1));
    expect(reporter.activity()).toBeUndefined();
    await vi.waitFor(() => expect(paths).toHaveLength(2));
    expect(paths[1]).toBe(
      `/api/runtime/channel-bindings/${bindingId}/activity`,
    );

    release?.();
    await reporter.stop();
  });

  it("reports pairing verification with only the irreversible peer fingerprint", async () => {
    const requests: SeenRequest[] = [];
    const peerFingerprint = "b".repeat(64);
    const verified: string[] = [];
    const reporter = createRuntimeReporter(reporterOptions({
      fetchImpl: async (url, init) => {
        requests.push({
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
          headers: new Headers(init?.headers),
          url: String(url),
        });
        return String(url).endsWith("/installations")
          ? jsonResponse({ installation }, 201)
          : jsonResponse({ binding: {} });
      },
      onBindingVerified: (value) => verified.push(value),
    }));

    reporter.start();
    await waitForRequests(requests, 1);
    reporter.verifyPairing({
      challengeId,
      pairedPeerFingerprint: peerFingerprint,
      pairingCode: "ABCD2345",
    });
    await waitForRequests(requests, 2);

    expect(requests[1]?.url).toBe(
      `https://attention.example/api/runtime/channel-bindings/${bindingId}/verify`,
    );
    expect(requests[1]?.body).toMatchObject({
      api_version: "1",
      binding_id: bindingId,
      challenge_id: challengeId,
      installation_id: installationId,
      paired_peer_fingerprint: peerFingerprint,
      pairing_code: "ABCD2345",
    });
    expect(JSON.stringify(requests[1]?.body)).not.toContain("owner_user_id");
    await vi.waitFor(() => expect(verified).toEqual([bindingId]));
    await reporter.stop();
  });

  it("aborts the in-flight report and drops queued work after bounded stop", async () => {
    vi.useFakeTimers();
    const paths: string[] = [];
    const inFlight: { signal: AbortSignal | null } = { signal: null };
    const reporter = createRuntimeReporter(reporterOptions({
      fetchImpl: async (url, init) => {
        const path = new URL(String(url)).pathname;
        paths.push(path);
        if (path.endsWith("/installations")) {
          return jsonResponse({ installation }, 201);
        }
        if (path.endsWith("/heartbeat") && inFlight.signal === null) {
          inFlight.signal = init?.signal ?? null;
          return await new Promise<Response>((_resolve, reject) => {
            inFlight.signal?.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            }, { once: true });
          });
        }
        return jsonResponse({ binding: {} });
      },
      stopTimeoutMs: 250,
    }));

    reporter.start();
    await vi.advanceTimersByTimeAsync(0);
    reporter.transition(snapshot);
    await vi.advanceTimersByTimeAsync(0);
    reporter.activity();
    expect(paths).toEqual([
      "/api/runtime/installations",
      `/api/runtime/installations/${installationId}/heartbeat`,
    ]);

    const stopping = reporter.stop();
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(249);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(stopped).toBe(true);
    expect(inFlight.signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(paths).toEqual([
      "/api/runtime/installations",
      `/api/runtime/installations/${installationId}/heartbeat`,
    ]);
    expect(reporter.snapshot().status).toBe("stopped");
  });
});
