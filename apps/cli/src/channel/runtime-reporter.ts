import { randomUUID } from "node:crypto";

import {
  CHANNEL_RUNTIME_API_VERSION,
  CHANNEL_RUNTIME_SCOPES,
  ChannelBindingChallengeSchema,
  ChannelActivityReportSchema,
  CreateChannelBindingRequestSchema,
  InstallationHeartbeatSchema,
  PairingVerificationReportSchema,
  RegisterInstallationRequestSchema,
  type AgentIntegrationId,
  type ChannelBindingChallenge,
  type LocalChannelProvider,
} from "@attention/contracts";

import type { RuntimeCheckpoint } from "./state";

export const RUNTIME_REPORTER_SCOPES = [...CHANNEL_RUNTIME_SCOPES] as const;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;

export interface RuntimeReporterTokenRequest {
  readonly forceRefresh: boolean;
  readonly resource: string;
  readonly scopes: readonly string[];
}

export interface RuntimeAccessTokenProvider {
  accessToken(request: RuntimeReporterTokenRequest): Promise<string | null>;
}

export interface RuntimeReporterIdentity {
  readonly adapterVersion: string;
  readonly agentIntegrationId: AgentIntegrationId;
  readonly bindingId: string | null;
  readonly channelAccountFingerprint: string;
  readonly channelSessionFingerprint: string;
  readonly deviceName: string;
  readonly installationId: string;
  readonly provider: LocalChannelProvider;
  readonly restrictedProfile: boolean;
  readonly skillVersion: string;
  readonly toolContractVersion: string;
}

export interface RuntimeReporterSnapshot {
  readonly bridgeStatus: "online" | "degraded" | "stopping";
  readonly checkpoint: RuntimeCheckpoint;
  readonly ilinkStatus: "connected" | "reconnecting" | "signed_out";
  readonly pendingInbound: number;
  readonly pendingOutbound: number;
}

export interface RuntimePairingVerification {
  readonly bindingId?: string;
  readonly challengeId: string;
  readonly pairedPeerFingerprint: string;
  readonly pairingCode: string;
}

export interface RuntimeReporterOptions {
  readonly accessTokenProvider: RuntimeAccessTokenProvider;
  readonly eventId?: () => string;
  readonly fetchImpl?: typeof fetch;
  readonly heartbeatIntervalMs?: number;
  readonly identity: RuntimeReporterIdentity;
  readonly now?: () => Date;
  readonly onBindingChallenge?: (
    challenge: ChannelBindingChallenge,
  ) => void;
  readonly onBindingInvalidated?: () => void;
  readonly onBindingVerified?: (bindingId: string) => void;
  readonly onInstallationInvalidated?: () => void;
  readonly onPairingVerificationFailed?: () => void;
  readonly onStatusChange?: (status: RuntimeReporterStatus) => void;
  readonly requestTimeoutMs?: number;
  readonly retryBackoffMs?: readonly number[];
  readonly runtimeBaseUrl: string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly snapshot: RuntimeReporterSnapshot;
  readonly stopTimeoutMs?: number;
}

export type RuntimeReporterStatus =
  | "idle"
  | "registering"
  | "active"
  | "degraded"
  | "stopped";

export interface RuntimeReporterState {
  readonly bindingId: string | null;
  readonly lastErrorCode: string | null;
  readonly status: RuntimeReporterStatus;
}

interface DeliveryResult {
  readonly body: unknown;
  readonly ok: boolean;
  readonly status: number | null;
}

export interface RuntimeReporter {
  activity(): void;
  renewPairing(): void;
  snapshot(): RuntimeReporterState;
  start(): void;
  stop(options?: RuntimeReporterStopOptions): Promise<void>;
  transition(snapshot: RuntimeReporterSnapshot): void;
  verifyPairing(input: RuntimePairingVerification): void;
}

export interface RuntimeReporterStopOptions {
  readonly discardPending?: boolean;
}

export function createRuntimeReporter(
  options: RuntimeReporterOptions,
): RuntimeReporter {
  return new LocalRuntimeReporter(options);
}

class LocalRuntimeReporter implements RuntimeReporter {
  readonly #accessTokenProvider: RuntimeAccessTokenProvider;
  readonly #eventId: () => string;
  readonly #fetch: typeof fetch;
  readonly #heartbeatIntervalMs: number;
  readonly #identity: RuntimeReporterIdentity;
  readonly #now: () => Date;
  readonly #onBindingChallenge:
    | ((challenge: ChannelBindingChallenge) => void)
    | undefined;
  readonly #onBindingInvalidated: (() => void) | undefined;
  readonly #onBindingVerified: ((bindingId: string) => void) | undefined;
  readonly #onInstallationInvalidated: (() => void) | undefined;
  readonly #onPairingVerificationFailed: (() => void) | undefined;
  readonly #onStatusChange:
    | ((status: RuntimeReporterStatus) => void)
    | undefined;
  readonly #requestTimeoutMs: number;
  readonly #retryBackoffMs: readonly number[];
  readonly #runtimeBaseUrl: string;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #stopTimeoutMs: number;

  #accepting = true;
  readonly #activeRequests = new Set<AbortController>();
  #bindingId: string | null;
  #currentSnapshot: RuntimeReporterSnapshot;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #installationInvalidated = false;
  #lastErrorCode: string | null = null;
  #registered = false;
  #stoppingDeliveryOpen = false;
  #started = false;
  #status: RuntimeReporterStatus = "idle";
  #tail: Promise<void> = Promise.resolve();

  constructor(options: RuntimeReporterOptions) {
    this.#runtimeBaseUrl = normalizeRuntimeBaseUrl(options.runtimeBaseUrl);
    this.#accessTokenProvider = options.accessTokenProvider;
    this.#eventId = options.eventId ?? randomUUID;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#heartbeatIntervalMs = positiveDuration(
      options.heartbeatIntervalMs,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
    );
    this.#identity = options.identity;
    this.#bindingId = options.identity.bindingId;
    this.#currentSnapshot = options.snapshot;
    this.#now = options.now ?? (() => new Date());
    this.#onBindingChallenge = options.onBindingChallenge;
    this.#onBindingInvalidated = options.onBindingInvalidated;
    this.#onBindingVerified = options.onBindingVerified;
    this.#onInstallationInvalidated = options.onInstallationInvalidated;
    this.#onPairingVerificationFailed =
      options.onPairingVerificationFailed;
    this.#onStatusChange = options.onStatusChange;
    this.#requestTimeoutMs = positiveDuration(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    this.#retryBackoffMs =
      options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#stopTimeoutMs = positiveDuration(
      options.stopTimeoutMs,
      DEFAULT_STOP_TIMEOUT_MS,
    );
  }

  start(): void {
    if (this.#started || !this.#accepting) return;
    this.#started = true;
    this.#setStatus("registering", null);
    this.#enqueue(async () => void (await this.#ensureRegistered()));

    this.#heartbeatTimer = setInterval(() => {
      if (this.#accepting) this.#enqueueHeartbeat(this.#currentSnapshot);
    }, this.#heartbeatIntervalMs);
    this.#heartbeatTimer.unref?.();
  }

  transition(snapshot: RuntimeReporterSnapshot): void {
    this.#currentSnapshot = snapshot;
    if (
      !this.#started ||
      !this.#accepting ||
      this.#installationInvalidated
    ) return;
    this.#enqueueHeartbeat(snapshot);
  }

  activity(): void {
    if (
      !this.#started ||
      !this.#accepting ||
      this.#installationInvalidated
    ) return;
    const bindingId = this.#bindingId;
    if (!bindingId) return;
    this.#enqueue(async () => {
      const body = ChannelActivityReportSchema.parse({
        activity: "message_processed",
        api_version: CHANNEL_RUNTIME_API_VERSION,
        binding_id: bindingId,
        event_id: this.#eventId(),
        installation_id: this.#identity.installationId,
        observed_at: this.#now().toISOString(),
      });
      const result = await this.#post(
        `/channel-bindings/${encodeURIComponent(bindingId)}/activity`,
        body,
      );
      if (bindingRejected(result)) {
        this.#invalidateBinding();
        await this.#ensureRegistered();
      }
    });
  }

  renewPairing(): void {
    if (
      !this.#started ||
      !this.#accepting ||
      this.#installationInvalidated
    ) return;
    this.#enqueue(async () => {
      this.#invalidateBinding();
      await this.#ensureRegistered();
    });
  }

  verifyPairing(input: RuntimePairingVerification): void {
    if (
      !this.#started ||
      !this.#accepting ||
      this.#installationInvalidated
    ) return;
    const bindingId = input.bindingId ?? this.#bindingId;
    if (!bindingId) return;
    this.#enqueue(async () => {
      const body = PairingVerificationReportSchema.parse({
        api_version: CHANNEL_RUNTIME_API_VERSION,
        binding_id: bindingId,
        challenge_id: input.challengeId,
        event_id: this.#eventId(),
        installation_id: this.#identity.installationId,
        observed_at: this.#now().toISOString(),
        paired_peer_fingerprint: input.pairedPeerFingerprint,
        pairing_code: input.pairingCode,
      });
      const result = await this.#post(
        `/channel-bindings/${encodeURIComponent(bindingId)}/verify`,
        body,
      );
      if (result.ok) {
        this.#bindingId = bindingId;
        this.#onBindingVerified?.(bindingId);
      } else if (bindingRejected(result)) {
        this.#invalidateBinding();
        await this.#ensureRegistered();
        this.#onPairingVerificationFailed?.();
      } else {
        this.#onPairingVerificationFailed?.();
      }
    });
  }

  snapshot(): RuntimeReporterState {
    return {
      bindingId: this.#bindingId,
      lastErrorCode: this.#lastErrorCode,
      status: this.#status,
    };
  }

  async stop(options: RuntimeReporterStopOptions = {}): Promise<void> {
    if (!this.#started) {
      this.#accepting = false;
      this.#setStatus("stopped", null);
      return;
    }
    if (!this.#accepting) return;
    this.#accepting = false;
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    if (options.discardPending) {
      for (const controller of this.#activeRequests) controller.abort();
      await boundedWait(this.#tail, this.#stopTimeoutMs);
      this.#setStatus("stopped", this.#lastErrorCode);
      return;
    }
    this.#stoppingDeliveryOpen = true;
    const stoppingSnapshot: RuntimeReporterSnapshot = {
      ...this.#currentSnapshot,
      bridgeStatus: "stopping",
    };
    this.#enqueueHeartbeat(stoppingSnapshot, true);
    const pending = this.#tail;
    const settled = await boundedWait(pending, this.#stopTimeoutMs);
    this.#stoppingDeliveryOpen = false;
    if (!settled) {
      for (const controller of this.#activeRequests) controller.abort();
    }
    this.#setStatus("stopped", this.#lastErrorCode);
  }

  #enqueueHeartbeat(
    snapshot: RuntimeReporterSnapshot,
    duringStop = false,
  ): void {
    if (!duringStop && !this.#accepting) return;
    this.#enqueue(async () => {
      if (!(await this.#ensureRegistered())) return;
      const body = InstallationHeartbeatSchema.parse({
        api_version: CHANNEL_RUNTIME_API_VERSION,
        event_id: this.#eventId(),
        installation_id: this.#identity.installationId,
        observed_at: this.#now().toISOString(),
        runtime_checkpoint: checkpointReport(snapshot),
        runtime_health: runtimeHealth(snapshot),
      });
      const result = await this.#post(
        `/installations/${encodeURIComponent(this.#identity.installationId)}/heartbeat`,
        body,
      );
      if (!result.ok && result.status === 404) {
        this.#registered = false;
        await this.#ensureRegistered();
      } else if (!result.ok && result.status === 409) {
        this.#invalidateInstallation();
      }
    }, duringStop);
  }

  #enqueue(
    operation: () => Promise<void>,
    duringStop = false,
  ): void {
    const run = async (): Promise<void> => {
      if (
        this.#installationInvalidated ||
        !this.#accepting &&
        (!duringStop || !this.#stoppingDeliveryOpen)
      ) {
        return;
      }
      try {
        await operation();
      } catch {
        this.#setStatus("degraded", "runtime_report_failed");
      }
    };
    this.#tail = this.#tail.then(run, run);
  }

  async #ensureRegistered(): Promise<boolean> {
    if (!this.#registered) {
      this.#setStatus("registering", null);
      const registration = RegisterInstallationRequestSchema.parse({
        adapter_version: this.#identity.adapterVersion,
        agent_integration_id: this.#identity.agentIntegrationId,
        api_version: CHANNEL_RUNTIME_API_VERSION,
        capabilities: {
          heartbeat_mode: "runtime",
          pairing_verification: true,
          restricted_profile: this.#identity.restrictedProfile,
        },
        device_name: this.#identity.deviceName,
        installation_id: this.#identity.installationId,
        skill_version: this.#identity.skillVersion,
        tool_contract_version: this.#identity.toolContractVersion,
      });
      const registered = await this.#post("/installations", registration);
      if (!registered.ok) {
        if (registered.status === 409) this.#invalidateInstallation();
        return false;
      }
      this.#registered = true;
    }

    if (this.#bindingId === null) {
      const binding = CreateChannelBindingRequestSchema.parse({
        api_version: CHANNEL_RUNTIME_API_VERSION,
        channel_account_fingerprint:
          this.#identity.channelAccountFingerprint,
        channel_session_fingerprint:
          this.#identity.channelSessionFingerprint,
        installation_id: this.#identity.installationId,
        provider: this.#identity.provider,
      });
      const reported = await this.#post("/channel-bindings", binding);
      if (!reported.ok) return false;
      const challenge = ChannelBindingChallengeSchema.parse(
        responseMember(reported.body, "challenge"),
      );
      this.#bindingId = challenge.binding_id;
      this.#onBindingChallenge?.(challenge);
    }
    this.#setStatus("active", null);
    return true;
  }

  #invalidateBinding(): void {
    if (this.#bindingId === null) return;
    this.#bindingId = null;
    this.#onBindingInvalidated?.();
  }

  #invalidateInstallation(): void {
    if (this.#installationInvalidated) return;
    this.#installationInvalidated = true;
    this.#registered = false;
    this.#bindingId = null;
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#setStatus("degraded", "runtime_installation_conflict");
    try {
      this.#onInstallationInvalidated?.();
    } catch {
      // The reporter is already terminal for this immutable installation.
    }
  }

  async #post(path: string, payload: unknown): Promise<DeliveryResult> {
    const body = JSON.stringify(payload);
    let refreshed = false;
    let token: string | null = null;
    for (let attempt = 0; ; attempt += 1) {
      if (
        this.#installationInvalidated ||
        !this.#accepting && !this.#stoppingDeliveryOpen
      ) {
        return { body: null, ok: false, status: null };
      }
      try {
        token ??= await this.#accessTokenProvider.accessToken({
          forceRefresh: refreshed,
          resource: this.#runtimeBaseUrl,
          scopes: RUNTIME_REPORTER_SCOPES,
        });
        if (!token) {
          this.#setStatus("degraded", "runtime_auth_required");
          return { body: null, ok: false, status: null };
        }
        if (
          this.#installationInvalidated ||
          !this.#accepting && !this.#stoppingDeliveryOpen
        ) {
          return { body: null, ok: false, status: null };
        }
        let response = await this.#send(path, body, token);
        if (response.status === 401 && !refreshed) {
          refreshed = true;
          token = null;
          token = await this.#accessTokenProvider.accessToken({
            forceRefresh: true,
            resource: this.#runtimeBaseUrl,
            scopes: RUNTIME_REPORTER_SCOPES,
          });
          if (!token) {
            this.#setStatus("degraded", "runtime_auth_required");
            return { body: null, ok: false, status: null };
          }
          if (
            this.#installationInvalidated ||
            !this.#accepting && !this.#stoppingDeliveryOpen
          ) {
            return { body: null, ok: false, status: null };
          }
          response = await this.#send(path, body, token);
        }
        if (response.ok) {
          return {
            body: await responseBody(response),
            ok: true,
            status: response.status,
          };
        }
        if (!retryableStatus(response.status)) {
          const responsePayload = await safeResponseBody(response);
          this.#setStatus(
            "degraded",
            response.status === 401
              ? "runtime_auth_required"
              : runtimeBindingErrorCode(responsePayload) ??
                "runtime_report_rejected",
          );
          return {
            body: null,
            ok: false,
            status: response.status,
          };
        }
      } catch {
        // Network and token-provider failures share the bounded retry policy.
      }
      if (
        this.#installationInvalidated ||
        !this.#accepting && !this.#stoppingDeliveryOpen
      ) {
        return { body: null, ok: false, status: null };
      }
      const delay = this.#retryBackoffMs[attempt];
      if (delay === undefined) {
        this.#setStatus("degraded", "runtime_report_failed");
        return { body: null, ok: false, status: null };
      }
      await this.#sleep(delay);
    }
  }

  async #send(path: string, body: string, token: string): Promise<Response> {
    const controller = new AbortController();
    this.#activeRequests.add(controller);
    const timeout = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
    timeout.unref?.();
    try {
      return await this.#fetch(`${this.#runtimeBaseUrl}${path}`, {
        body,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        method: "POST",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
      this.#activeRequests.delete(controller);
    }
  }

  #setStatus(
    status: RuntimeReporterStatus,
    lastErrorCode: string | null,
  ): void {
    if (this.#status === "stopped" && status !== "stopped") return;
    const changed =
      this.#status !== status || this.#lastErrorCode !== lastErrorCode;
    this.#status = status;
    this.#lastErrorCode = lastErrorCode;
    if (changed) this.#onStatusChange?.(status);
  }
}

function checkpointReport(snapshot: RuntimeReporterSnapshot): {
  bridge_status: RuntimeReporterSnapshot["bridgeStatus"];
  codex_phase: RuntimeCheckpoint["phase"];
  ilink_status: RuntimeReporterSnapshot["ilinkStatus"];
  last_error_code: string | null;
  last_healthy_at: string | null;
  last_successful_message_at: string | null;
  pending_inbound: number;
  pending_outbound: number;
} {
  return {
    bridge_status: snapshot.bridgeStatus,
    codex_phase: snapshot.checkpoint.phase,
    ilink_status: snapshot.ilinkStatus,
    last_error_code: stableErrorCode(snapshot.checkpoint.lastErrorCode),
    last_healthy_at: snapshot.checkpoint.lastHealthyAt,
    last_successful_message_at:
      snapshot.checkpoint.lastSuccessfulMessageAt,
    pending_inbound: boundedQueueCount(snapshot.pendingInbound),
    pending_outbound: boundedQueueCount(snapshot.pendingOutbound),
  };
}

function runtimeHealth(
  snapshot: RuntimeReporterSnapshot,
): "active" | "degraded" {
  return snapshot.bridgeStatus === "online" &&
    snapshot.ilinkStatus === "connected" &&
    snapshot.checkpoint.phase === "healthy"
    ? "active"
    : "degraded";
}

function stableErrorCode(value: string | null): string | null {
  return value !== null && /^[a-z][a-z0-9_]{0,99}$/u.test(value)
    ? value
    : null;
}

function boundedQueueCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(10_000, Math.max(0, Math.trunc(value)));
}

function normalizeRuntimeBaseUrl(value: string): string {
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.pathname.replace(/\/+$/u, "") !== "/api/runtime" ||
    url.search ||
    url.hash
  ) {
    throw new Error("runtimeBaseUrl must be the exact /api/runtime resource");
  }
  url.pathname = "/api/runtime";
  return url.toString().replace(/\/$/u, "");
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function bindingRejected(result: DeliveryResult): boolean {
  return !result.ok && (result.status === 404 || result.status === 409);
}

function responseMember(body: unknown, key: string): unknown {
  if (body === null || typeof body !== "object") return undefined;
  return (body as Record<string, unknown>)[key];
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function safeResponseBody(response: Response): Promise<unknown> {
  try {
    return await responseBody(response);
  } catch {
    return null;
  }
}

function runtimeBindingErrorCode(body: unknown): string | null {
  const errorBody = responseMember(body, "error");
  const code = responseMember(errorBody, "code");
  switch (code) {
    case "channel_session_proof_required":
      return "runtime_channel_session_proof_required";
    case "channel_session_superseded":
      return "runtime_channel_session_superseded";
    default:
      return null;
  }
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

async function boundedWait(
  pending: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
    void pending.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(true);
      },
    );
  });
}
