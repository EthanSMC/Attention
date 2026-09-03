import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultAttentionMcpCheckpoint } from "./mcp-readiness";
import { createMcpRecoverySupervisor } from "./mcp-recovery-supervisor";

const verifiedAccount = {
  attentionId: "ethan_01",
  displayName: "Ethan",
  isFilter: true,
  isMember: true,
} as const;

describe("MCP recovery supervisor", () => {
  afterEach(() => vi.useRealTimers());

  it("coalesces concurrent manual retries into one restart and probe", async () => {
    let releaseRestart!: () => void;
    const restartGate = new Promise<void>((resolve) => {
      releaseRestart = resolve;
    });
    let restartCount = 0;
    let probeCount = 0;
    const supervisor = createMcpRecoverySupervisor({
      checkpoint: defaultAttentionMcpCheckpoint(),
      now: () => new Date("2026-09-03T08:00:00.000Z"),
      persist: async () => undefined,
      probe: async () => {
        probeCount += 1;
        return { account: verifiedAccount, ok: true };
      },
      restart: async () => {
        restartCount += 1;
        await restartGate;
      },
    });

    const first = supervisor.retryNow();
    const second = supervisor.retryNow();

    expect(first).toBe(second);
    await Promise.resolve();
    expect(restartCount).toBe(1);
    releaseRestart();
    await expect(first).resolves.toEqual({
      account: verifiedAccount,
      kind: "ready",
    });
    expect(probeCount).toBe(1);
  });

  it("restarts before probing and marks ready only after the real probe", async () => {
    const events: string[] = [];
    const checkpoint = defaultAttentionMcpCheckpoint();
    const supervisor = createMcpRecoverySupervisor({
      checkpoint,
      now: () => new Date("2026-09-03T08:00:00.000Z"),
      persist: async () => {
        events.push(`persist:${checkpoint.status}`);
      },
      probe: async () => {
        events.push("probe");
        return { account: verifiedAccount, ok: true };
      },
      restart: async () => {
        events.push("restart");
      },
    });

    await expect(supervisor.retryNow()).resolves.toMatchObject({
      kind: "ready",
    });
    expect(events).toEqual([
      "persist:reconnecting",
      "restart",
      "probe",
      "persist:ready",
    ]);
    expect(checkpoint).toEqual({
      lastCheckedAt: "2026-09-03T08:00:00.000Z",
      lastErrorCode: null,
      lastReadyAt: "2026-09-03T08:00:00.000Z",
      nextRetryAt: null,
      retryAttempt: 0,
      status: "ready",
    });
  });

  it("uses capped 1, 3, 10, 30, and 60 second retries for an unreachable server", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T08:00:00.000Z"));
    const checkpoint = defaultAttentionMcpCheckpoint();
    let restartCount = 0;
    const supervisor = createMcpRecoverySupervisor({
      checkpoint,
      now: () => new Date(Date.now()),
      persist: async () => undefined,
      probe: async () => ({
        errorCode: "mcp_server_unreachable",
        ok: false,
        retryable: true,
      }),
      restart: async () => {
        restartCount += 1;
      },
    });

    await expect(
      supervisor.recordProbe({
        errorCode: "mcp_server_unreachable",
        ok: false,
        retryable: true,
      }),
    ).resolves.toMatchObject({
      kind: "scheduled",
      nextRetryAt: "2026-09-03T08:00:01.000Z",
    });

    const expectedDelays = [1_000, 3_000, 10_000, 30_000, 60_000, 60_000];
    const expectedAttempts = [2, 3, 4, 5, 6, 7];
    for (let index = 0; index < expectedDelays.length; index += 1) {
      await vi.advanceTimersByTimeAsync(expectedDelays[index]!);
      expect(checkpoint.retryAttempt).toBe(expectedAttempts[index]);
    }
    expect(restartCount).toBe(6);
    expect(checkpoint.status).toBe("unreachable");
    supervisor.stop();
  });

  it("stops protocol retries as tool_error after five failed probes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T08:00:00.000Z"));
    const checkpoint = defaultAttentionMcpCheckpoint();
    const supervisor = createMcpRecoverySupervisor({
      checkpoint,
      now: () => new Date(Date.now()),
      persist: async () => undefined,
      probe: async () => ({
        errorCode: "mcp_protocol_failed",
        ok: false,
        retryable: true,
      }),
      restart: async () => undefined,
    });

    await supervisor.recordProbe({
      errorCode: "mcp_protocol_failed",
      ok: false,
      retryable: true,
    });
    for (const delay of [1_000, 3_000, 10_000, 30_000]) {
      await vi.advanceTimersByTimeAsync(delay);
    }

    expect(checkpoint).toMatchObject({
      lastErrorCode: "mcp_protocol_failed",
      nextRetryAt: null,
      retryAttempt: 5,
      status: "tool_error",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["mcp_auth_required", "mcp_token_refresh_failed"] as const)(
    "stops automatic retries for %s",
    async (errorCode) => {
      vi.useFakeTimers();
      const checkpoint = defaultAttentionMcpCheckpoint();
      const supervisor = createMcpRecoverySupervisor({
        checkpoint,
        now: () => new Date("2026-09-03T08:00:00.000Z"),
        persist: async () => undefined,
        probe: async () => ({ errorCode, ok: false, retryable: false }),
        restart: async () => undefined,
      });

      await expect(
        supervisor.recordProbe({ errorCode, ok: false, retryable: false }),
      ).resolves.toEqual({ kind: "auth_required" });
      expect(checkpoint).toMatchObject({
        lastErrorCode: errorCode,
        nextRetryAt: null,
        status: "auth_required",
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("applies a three second cooldown after a manual retry", async () => {
    let nowMs = Date.parse("2026-09-03T08:00:00.000Z");
    const supervisor = createMcpRecoverySupervisor({
      checkpoint: defaultAttentionMcpCheckpoint(),
      now: () => new Date(nowMs),
      persist: async () => undefined,
      probe: async () => ({ account: verifiedAccount, ok: true }),
      restart: async () => undefined,
    });

    await expect(supervisor.retryNow()).resolves.toMatchObject({ kind: "ready" });
    nowMs += 1_000;
    await expect(supervisor.retryNow()).resolves.toEqual({
      kind: "cooldown",
      retryAt: "2026-09-03T08:00:03.000Z",
    });
  });

  it("cancels a scheduled retry when stopped", async () => {
    vi.useFakeTimers();
    const checkpoint = defaultAttentionMcpCheckpoint();
    let restartCount = 0;
    const supervisor = createMcpRecoverySupervisor({
      checkpoint,
      now: () => new Date("2026-09-03T08:00:00.000Z"),
      persist: async () => undefined,
      probe: async () => ({
        errorCode: "mcp_server_unreachable",
        ok: false,
        retryable: true,
      }),
      restart: async () => {
        restartCount += 1;
      },
    });
    await supervisor.recordProbe({
      errorCode: "mcp_server_unreachable",
      ok: false,
      retryable: true,
    });

    supervisor.stop();
    await vi.runAllTimersAsync();

    expect(restartCount).toBe(0);
    expect(checkpoint.nextRetryAt).toBeNull();
  });
});
