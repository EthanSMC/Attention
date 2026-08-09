import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  channelLogout,
  channelStart,
  channelStatus,
  isBridgeHost,
  verifyAttentionAccount,
} from "./channel-command";
import { defaultChannelState, loadChannelState, saveChannelState } from "./state";
import { acquireChannelLock } from "./lock";

describe("channel subcommands", () => {
  const tempDirs: string[] = [];

  const makeTempBase = async (): Promise<string> => {
    const directory = await mkdtemp(join(tmpdir(), "attention-channel-cli-"));
    tempDirs.push(directory);
    return directory;
  };

  afterEach(async () => {
    for (const directory of tempDirs.splice(0)) {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("recognizes only codex and claude-code as bridge hosts", () => {
    expect(isBridgeHost("codex")).toBe(true);
    expect(isBridgeHost("claude-code")).toBe(true);
    expect(isBridgeHost("openclaw")).toBe(false);
    expect(isBridgeHost("workbuddy")).toBe(false);
    expect(isBridgeHost("nope")).toBe(false);
  });

  it("refuses to start the bridge for native-channel hosts", async () => {
    const lines: string[] = [];
    const exitCode = await channelStart("openclaw", {
      writeOutput: (text) => lines.push(text),
    });
    expect(exitCode).toBe(2);
    expect(lines.join("")).toMatch(/宿主自己的微信渠道/u);
  });

  it("requires a live Attention account tool result before iLink login", async () => {
    const base = await makeTempBase();
    const lines: string[] = [];
    let qrRequestAttempted = false;
    const exitCode = await channelStart("codex", {
      accountVerifier: async () => null,
      baseDirectory: base,
      brainFactory: () => ({
        hostId: "codex",
        invoke: async () => ({
          ok: false,
          reply: "",
          resumeFailed: false,
          sessionId: null,
          timedOut: false,
        }),
      }),
      fetchImpl: async () => {
        qrRequestAttempted = true;
        return new Response(null, { status: 500 });
      },
      hostCliCheck: async () => true,
      origin: "https://attention.example",
      writeOutput: (text) => lines.push(text),
    });

    expect(exitCode).toBe(1);
    expect(qrRequestAttempted).toBe(false);
    expect(lines.join("")).toContain("attention_get_my_account");
    expect(lines.join("")).not.toContain("扫码");
  });

  it("installs the background bridge only after a persisted iLink login exists", async () => {
    const base = await makeTempBase();
    const state = defaultChannelState();
    state.token = "local-ilink-token";
    state.accountId = "local-account";
    await saveChannelState(state, base);
    const installs: Array<{ hostId: string; origin: string }> = [];
    const lines: string[] = [];
    const signalListenersBefore = process.listenerCount("SIGINT");

    expect(
      await channelStart("claude-code", {
        accountVerifier: async () => ({
          attentionId: "filter-demo",
          displayName: "Filter Demo",
          isFilter: true,
          isMember: true,
        }),
        background: true,
        backgroundInstaller: async (input) => {
          installs.push(input);
        },
        baseDirectory: base,
        brainFactory: () => ({
          hostId: "claude-code",
          invoke: async () => {
            throw new Error("background activation must not invoke the brain loop");
          },
        }),
        fetchImpl: async () => {
          throw new Error("background activation must not poll iLink");
        },
        hostCliCheck: async () => true,
        origin: "https://attention.example",
        writeOutput: (text) => lines.push(text),
      }),
    ).toBe(0);
    expect(installs).toEqual([
      { hostId: "claude-code", origin: "https://attention.example" },
    ]);
    expect(lines.join("")).toContain("后台");
    expect(process.listenerCount("SIGINT")).toBe(signalListenersBefore);
  });

  it("does not open an interactive QR prompt from a background service", async () => {
    const base = await makeTempBase();
    let qrRequested = false;
    const lines: string[] = [];
    expect(
      await channelStart("codex", {
        accountVerifier: async () => ({
          attentionId: null,
          displayName: "Member",
          isFilter: false,
          isMember: true,
        }),
        baseDirectory: base,
        brainFactory: () => ({
          hostId: "codex",
          invoke: async () => {
            throw new Error("not reached");
          },
        }),
        fetchImpl: async () => {
          qrRequested = true;
          throw new Error("not reached");
        },
        hostCliCheck: async () => true,
        origin: "https://attention.example",
        service: true,
        writeOutput: (text) => lines.push(text),
      }),
    ).toBe(0);
    expect(qrRequested).toBe(false);
    expect(lines.join("")).toContain("重新运行");
  });

  it("stops a background service cleanly when Attention OAuth needs repair", async () => {
    const base = await makeTempBase();
    const lines: string[] = [];
    expect(
      await channelStart("codex", {
        accountVerifier: async () => null,
        baseDirectory: base,
        hostCliCheck: async () => true,
        origin: "https://attention.example",
        service: true,
        writeOutput: (text) => lines.push(text),
      }),
    ).toBe(0);
    expect(lines.join("")).toContain("OAuth");
    expect(lines.join("")).toContain("重新运行");
  });

  it("refuses to start a second bridge against the same local state", async () => {
    const base = await makeTempBase();
    const lock = await acquireChannelLock(base);
    expect(lock).not.toBeNull();
    let verified = false;
    const lines: string[] = [];
    expect(
      await channelStart("codex", {
        accountVerifier: async () => {
          verified = true;
          return null;
        },
        baseDirectory: base,
        hostCliCheck: async () => true,
        origin: "https://attention.example",
        writeOutput: (text) => lines.push(text),
      }),
    ).toBe(1);
    expect(verified).toBe(false);
    expect(lines.join("")).toContain("已经运行");
    await lock?.release();
  });

  it("parses the verified account identity returned by the Agent", async () => {
    const result = await verifyAttentionAccount(
      {
        hostId: "claude-code",
        invoke: async ({ prompt, sessionId }) => {
          expect(prompt).toContain("attention_get_my_account");
          expect(sessionId).toBeNull();
          return {
            ok: true,
            reply:
              'ATTENTION_ACCOUNT_OK {"display_name":"Ethan","attention_id":"ethancc","is_filter":true,"is_member":true}',
            resumeFailed: false,
            sessionId: "preflight-session",
            timedOut: false,
          };
        },
      },
      "/tmp",
    );

    expect(result).toEqual({
      attentionId: "ethancc",
      displayName: "Ethan",
      isFilter: true,
      isMember: true,
    });
  });

  it("reports status from local state only", async () => {
    const base = await makeTempBase();
    const lines: string[] = [];
    expect(
      await channelStatus({ baseDirectory: base, writeOutput: (t) => lines.push(t) }),
    ).toBe(0);
    expect(lines.join("")).toContain("已登录: 否");
  });

  it("renders machine-readable status without secrets", async () => {
    const base = await makeTempBase();
    const state = defaultChannelState();
    state.token = "super-secret-token";
    state.accountId = "account-123456";
    await saveChannelState(state, base);
    const lines: string[] = [];
    await channelStatus({
      baseDirectory: base,
      json: true,
      serviceInspector: async () => true,
      writeOutput: (text) => lines.push(text),
    });
    const report = JSON.parse(lines.join("")) as Record<string, unknown>;
    expect(report.loggedIn).toBe(true);
    expect(report.accountIdPrefix).toBe("accoun…");
    expect(report.pendingInbound).toBe(0);
    expect(report.pendingOutbound).toBe(0);
    expect(report.backgroundConfigured).toBe(true);
    expect(lines.join("")).not.toContain("super-secret-token");
  });

  it("logout removes the local iLink state", async () => {
    const base = await makeTempBase();
    const state = defaultChannelState();
    state.token = "token";
    await saveChannelState(state, base);
    const lines: string[] = [];
    let serviceRemoved = false;
    expect(
      await channelLogout({
        baseDirectory: base,
        serviceUninstaller: async () => {
          serviceRemoved = true;
        },
        writeOutput: (t) => lines.push(t),
      }),
    ).toBe(0);
    expect(serviceRemoved).toBe(true);
    expect(await loadChannelState(base)).toEqual(defaultChannelState());
    expect(lines.join("")).toContain("已删除");
  });
});
