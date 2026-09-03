import type {
  AttentionMcpCheckpoint,
  AttentionMcpErrorCode,
  AttentionMcpProbeResult,
  VerifiedAttentionAccount,
} from "./mcp-readiness";

export const ATTENTION_MCP_RETRY_DELAYS_MS = [
  1_000,
  3_000,
  10_000,
  30_000,
  60_000,
] as const;

export const ATTENTION_MCP_MANUAL_RETRY_COOLDOWN_MS = 3_000;
const ATTENTION_MCP_PROTOCOL_MAX_ATTEMPTS = 5;

export type McpRecoveryOutcome =
  | { account: VerifiedAttentionAccount; kind: "ready" }
  | { kind: "auth_required" }
  | { kind: "cooldown"; retryAt: string }
  | {
      errorCode: AttentionMcpErrorCode;
      kind: "scheduled";
      nextRetryAt: string;
    }
  | { errorCode: AttentionMcpErrorCode; kind: "failed" };

export interface McpRecoverySupervisor {
  recordProbe(result: AttentionMcpProbeResult): Promise<McpRecoveryOutcome>;
  retryNow(): Promise<McpRecoveryOutcome>;
  stop(): void;
}

export interface McpRecoveryDependencies {
  readonly checkpoint: AttentionMcpCheckpoint;
  readonly now: () => Date;
  readonly persist: () => Promise<void>;
  readonly probe: () => Promise<AttentionMcpProbeResult>;
  readonly restart: () => Promise<void>;
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export function createMcpRecoverySupervisor(
  dependencies: McpRecoveryDependencies,
): McpRecoverySupervisor {
  const setTimer =
    dependencies.setTimer ??
    ((callback: () => void, delayMs: number) =>
      globalThis.setTimeout(callback, delayMs));
  const clearTimer =
    dependencies.clearTimer ??
    ((handle: unknown) => globalThis.clearTimeout(handle as NodeJS.Timeout));

  let inFlight: Promise<McpRecoveryOutcome> | null = null;
  let lastManualRetryAt: number | null = null;
  let retryTimer: unknown | null = null;
  let stopped = false;

  const cancelRetryTimer = (): void => {
    if (retryTimer !== null) clearTimer(retryTimer);
    retryTimer = null;
  };

  const markReady = async (
    account: VerifiedAttentionAccount,
  ): Promise<McpRecoveryOutcome> => {
    cancelRetryTimer();
    const checkedAt = dependencies.now().toISOString();
    Object.assign(dependencies.checkpoint, {
      lastCheckedAt: checkedAt,
      lastErrorCode: null,
      lastReadyAt: checkedAt,
      nextRetryAt: null,
      retryAttempt: 0,
      status: "ready" as const,
    });
    await dependencies.persist();
    return { account, kind: "ready" };
  };

  const applyFailure = async (
    result: Extract<AttentionMcpProbeResult, { ok: false }>,
  ): Promise<McpRecoveryOutcome> => {
    cancelRetryTimer();
    const checkedAt = dependencies.now().toISOString();
    dependencies.checkpoint.lastCheckedAt = checkedAt;
    dependencies.checkpoint.lastErrorCode = result.errorCode;
    dependencies.checkpoint.nextRetryAt = null;

    if (
      result.errorCode === "mcp_auth_required" ||
      result.errorCode === "mcp_token_refresh_failed"
    ) {
      dependencies.checkpoint.retryAttempt = 0;
      dependencies.checkpoint.status = "auth_required";
      await dependencies.persist();
      return { kind: "auth_required" };
    }

    const nextAttempt = dependencies.checkpoint.retryAttempt + 1;
    dependencies.checkpoint.retryAttempt = nextAttempt;
    const protocolLimitReached =
      result.errorCode === "mcp_protocol_failed" &&
      nextAttempt >= ATTENTION_MCP_PROTOCOL_MAX_ATTEMPTS;
    if (!result.retryable || protocolLimitReached || stopped) {
      dependencies.checkpoint.status = "tool_error";
      await dependencies.persist();
      return { errorCode: result.errorCode, kind: "failed" };
    }

    dependencies.checkpoint.status =
      result.errorCode === "mcp_server_unreachable"
        ? "unreachable"
        : "tool_error";
    const delay =
      ATTENTION_MCP_RETRY_DELAYS_MS[
        Math.min(nextAttempt - 1, ATTENTION_MCP_RETRY_DELAYS_MS.length - 1)
      ] ?? ATTENTION_MCP_RETRY_DELAYS_MS.at(-1)!;
    const nextRetryAt = new Date(
      dependencies.now().getTime() + delay,
    ).toISOString();
    dependencies.checkpoint.nextRetryAt = nextRetryAt;
    await dependencies.persist();
    if (!stopped) {
      retryTimer = setTimer(() => {
        retryTimer = null;
        void beginRecovery();
      }, delay);
    }
    return { errorCode: result.errorCode, kind: "scheduled", nextRetryAt };
  };

  const applyProbe = async (
    result: AttentionMcpProbeResult,
  ): Promise<McpRecoveryOutcome> =>
    result.ok ? await markReady(result.account) : await applyFailure(result);

  const recover = async (): Promise<McpRecoveryOutcome> => {
    cancelRetryTimer();
    dependencies.checkpoint.status = "reconnecting";
    dependencies.checkpoint.nextRetryAt = null;
    await dependencies.persist();
    try {
      await dependencies.restart();
      return await applyProbe(await dependencies.probe());
    } catch {
      return await applyFailure({
        errorCode: "mcp_protocol_failed",
        ok: false,
        retryable: true,
      });
    }
  };

  const beginRecovery = (): Promise<McpRecoveryOutcome> => {
    if (inFlight) return inFlight;
    const task = recover();
    inFlight = task;
    void task.finally(() => {
      if (inFlight === task) inFlight = null;
    });
    return task;
  };

  return {
    async recordProbe(
      result: AttentionMcpProbeResult,
    ): Promise<McpRecoveryOutcome> {
      return await applyProbe(result);
    },
    retryNow(): Promise<McpRecoveryOutcome> {
      if (inFlight) return inFlight;
      const now = dependencies.now().getTime();
      if (
        lastManualRetryAt !== null &&
        now - lastManualRetryAt < ATTENTION_MCP_MANUAL_RETRY_COOLDOWN_MS
      ) {
        return Promise.resolve({
          kind: "cooldown",
          retryAt: new Date(
            lastManualRetryAt + ATTENTION_MCP_MANUAL_RETRY_COOLDOWN_MS,
          ).toISOString(),
        });
      }
      lastManualRetryAt = now;
      return beginRecovery();
    },
    stop(): void {
      stopped = true;
      cancelRetryTimer();
      dependencies.checkpoint.nextRetryAt = null;
    },
  };
}
