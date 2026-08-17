import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { BrainRuntimeSnapshot } from "./brain";
import type {
  RuntimeReporter,
  RuntimeReporterOptions,
  RuntimeReporterSnapshot,
} from "./runtime-reporter";
import {
  channelLogout,
  channelStart,
  channelStatus,
  isBridgeHost,
  loadRuntimeRegistrationIdentity,
  verifyAttentionAccount,
} from "./channel-command";
import { defaultChannelState, loadChannelState, saveChannelState } from "./state";
import { acquireChannelLock } from "./lock";
import { handleInboundMessage } from "./pipeline";

function brainLifecycle() {
  return {
    runtimeSnapshot: (): BrainRuntimeSnapshot => ({
      lastErrorCode: null,
      phase: "healthy",
      retryAttempt: 0,
    }),
    shutdown: async (): Promise<void> => undefined,
    start: async (): Promise<void> => undefined,
  };
}

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
        ...brainLifecycle(),
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

  it("installs a background bridge without starting a duplicate Agent preflight", async () => {
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
        accountVerifier: async () => {
          throw new Error("background activation must defer account verification to the service");
        },
        background: true,
        backgroundInstaller: async (input) => {
          installs.push(input);
        },
        baseDirectory: base,
        brainFactory: () => {
          throw new Error("background activation must not start a duplicate Agent runtime");
        },
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

  it("completes first-time iLink login before installing without starting an Agent preflight", async () => {
    const base = await makeTempBase();
    const installs: Array<{ hostId: string; origin: string }> = [];

    expect(
      await channelStart("codex", {
        accountVerifier: async () => {
          throw new Error("background activation must defer account verification to the service");
        },
        background: true,
        backgroundInstaller: async (input) => {
          installs.push(input);
        },
        baseDirectory: base,
        brainFactory: () => {
          throw new Error("background activation must not start a duplicate Agent runtime");
        },
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.includes("get_bot_qrcode")) {
            return new Response(
              JSON.stringify({
                qrcode: "qr-1",
                qrcode_img_content: "https://weixin.qq.com/x/qr-1",
              }),
            );
          }
          if (url.includes("get_qrcode_status")) {
            return new Response(
              JSON.stringify({
                bot_token: "local-ilink-token",
                ilink_bot_id: "local-account",
                status: "confirmed",
              }),
            );
          }
          throw new Error(`unexpected iLink request: ${url}`);
        },
        hostCliCheck: async () => true,
        origin: "https://attention.example",
        writeOutput: () => undefined,
      }),
    ).toBe(0);

    expect(installs).toEqual([
      { hostId: "codex", origin: "https://attention.example" },
    ]);
    const persisted = await loadChannelState(base);
    expect(persisted.token).toBe("local-ilink-token");
    expect(persisted.accountId).toBe("local-account");
  });

  it("restores a background bridge from a recent account verification without another LLM preflight", async () => {
    const base = await makeTempBase();
    const state = defaultChannelState();
    state.token = "local-ilink-token";
    state.accountId = "local-account";
    Object.assign(state, {
      accountVerification: {
        hostId: "codex",
        mcpUrl: "https://attention.example/mcp",
        verifiedAt: new Date().toISOString(),
      },
    });
    await saveChannelState(state, base);
    let verificationAttempts = 0;
    const lines: string[] = [];

    expect(
      await channelStart("codex", {
        accountVerifier: async () => {
          verificationAttempts += 1;
          return null;
        },
        baseDirectory: base,
        brainFactory: () => ({
          ...brainLifecycle(),
          hostId: "codex",
          invoke: async () => {
            throw new Error("not reached");
          },
        }),
        fetchImpl: async () =>
          new Response(JSON.stringify({ errcode: -14 })),
        hostCliCheck: async () => true,
        origin: "https://attention.example",
        runtimeCredentialLoader: async () => false,
        service: true,
        writeOutput: (text) => lines.push(text),
      }),
    ).toBe(0);

    expect(verificationAttempts).toBe(0);
    expect(lines.join("")).toContain("最近已验收");
  });

  it("pulls a completed summary and durably sends it to the bound WeChat owner", async () => {
    const base = await makeTempBase();
    const state = defaultChannelState();
    state.token = "local-ilink-token";
    state.accountId = "local-account";
    state.ownerUserId = "wechat-owner";
    state.contextTokens = { "wechat-owner": "ctx-owner" };
    state.runtimeReporter = {
      bindingId: "22222222-2222-4222-8222-222222222222",
      installationId: "11111111-1111-4111-8111-111111111111",
      runtimeClientFingerprint: null,
    };
    await saveChannelState(state, base);
    const sentTexts: string[] = [];
    const summaryNotificationPoller = vi.fn(async () => ({
      items: [{
        completed_at: "2026-08-14T08:30:00.000Z",
        content_id: "33333333-3333-4333-8333-333333333333",
        notification_id: "44444444-4444-4444-8444-444444444444",
        original_url: "https://example.com/article",
        summary: "这是一段摘要。",
        title: "测试文章",
      }],
      next_cursor:
        "2026-08-14T08:30:00.000Z|44444444-4444-4444-8444-444444444444",
    }));

    expect(
      await channelStart("codex", {
        accountVerifier: async () => ({
          attentionId: "filter-demo",
          displayName: "Filter Demo",
          isFilter: true,
          isMember: true,
        }),
        baseDirectory: base,
        brainFactory: () => ({
          ...brainLifecycle(),
          hostId: "codex",
          invoke: async () => ({
            ok: true,
            reply: "not reached",
            resumeFailed: false,
            sessionId: "thread-1",
            timedOut: false,
          }),
        }),
        fetchImpl: async (url, init) => {
          const path = new URL(String(url)).pathname;
          if (path.endsWith("/sendmessage")) {
            const body = JSON.parse(String(init?.body)) as {
              msg: { item_list: Array<{ text_item: { text: string } }> };
            };
            sentTexts.push(body.msg.item_list[0]?.text_item.text ?? "");
            return new Response(JSON.stringify({ errcode: 0, ret: 0 }));
          }
          if (path.endsWith("/getupdates")) {
            return new Response(JSON.stringify({ errcode: -14, ret: 0 }));
          }
          throw new Error(`Unexpected iLink path: ${path}`);
        },
        hostCliCheck: async () => true,
        origin: "https://attention.example",
        runtimeCredentialLoader: async () => true,
        runtimeReporterFactory: () => ({
          activity: () => undefined,
          renewPairing: () => undefined,
          snapshot: () => ({
            bindingId: state.runtimeReporter.bindingId,
            lastErrorCode: null,
            status: "active",
          }),
          start: () => undefined,
          stop: async () => undefined,
          transition: () => undefined,
          verifyPairing: () => undefined,
        }),
        service: true,
        summaryNotificationPoller,
        writeOutput: () => undefined,
      }),
    ).toBe(0);

    expect(summaryNotificationPoller).toHaveBeenCalledOnce();
    expect(sentTexts).toEqual([
      "你收藏的《测试文章》摘要已完成：\n\n这是一段摘要。\n\n查看原文：https://example.com/article",
    ]);
    const persisted = await loadChannelState(base);
    expect(persisted.summaryNotificationCursor).toContain(
      "44444444-4444-4444-8444-444444444444",
    );
    expect(persisted.pendingOutbound).toEqual([]);
  });

  it("uses a disposable preflight while preserving the persisted Channel thread", async () => {
    const base = await makeTempBase();
    const state = defaultChannelState();
    state.token = "local-ilink-token";
    state.accountId = "local-account";
    state.brainSession = {
      hostId: "codex",
      sessionId: "private-thread-id",
      updatedAt: "2026-08-10T10:00:00.000Z",
    };
    await saveChannelState(state, base);
    let starts = 0;
    let shutdowns = 0;
    let receivedCodexHome: string | undefined;

    expect(
      await channelStart("codex", {
        accountVerifier: async () => ({
          attentionId: "filter-demo",
          displayName: "Filter Demo",
          isFilter: true,
          isMember: true,
        }),
        baseDirectory: base,
        brainFactory: (_hostId, options) => {
          receivedCodexHome = options.codexHomeDirectory;
          return {
            hostId: "codex",
            invoke: async () => {
              throw new Error("not reached");
            },
            runtimeSnapshot: () => ({
              lastErrorCode: null,
              phase: starts > shutdowns ? "healthy" : "stopped",
              retryAttempt: 0,
            }),
            shutdown: async () => {
              shutdowns += 1;
            },
            start: async () => {
              starts += 1;
            },
          };
        },
        codexHomePreparer: async () => "/tmp/isolated-codex-home",
        fetchImpl: async () =>
          new Response(JSON.stringify({ errcode: -14 })),
        hostCliCheck: async () => true,
        origin: "https://attention.example",
        runtimeCredentialLoader: async () => false,
        service: true,
        writeOutput: () => undefined,
      }),
    ).toBe(0);

    expect(receivedCodexHome).toBe("/tmp/isolated-codex-home");
    expect(starts).toBe(1);
    expect(shutdowns).toBe(1);
    expect((await loadChannelState(base)).brainSession?.sessionId).toBe(
      "private-thread-id",
    );
  });

  it("does not persist the preflight thread and gives the first real link the full Channel prompt", async () => {
    const base = await makeTempBase();
    const state = defaultChannelState();
    state.token = "local-ilink-token";
    state.accountId = "local-account";
    await saveChannelState(state, base);
    const prompts: Array<{ prompt: string; sessionId: string | null }> = [];

    expect(
      await channelStart("codex", {
        baseDirectory: base,
        brainFactory: () => ({
          ...brainLifecycle(),
          hostId: "codex",
          invoke: async (input) => {
            prompts.push(input);
            return {
              ok: true,
              reply:
                'ATTENTION_ACCOUNT_OK {"display_name":"Ethan","attention_id":"ethancc","is_filter":true,"is_member":true}',
              resumeFailed: false,
              sessionId: "preflight-session",
              timedOut: false,
            };
          },
        }),
        fetchImpl: async () =>
          new Response(JSON.stringify({ errcode: -14 })),
        hostCliCheck: async () => true,
        origin: "https://attention.example",
        runtimeCredentialLoader: async () => false,
        service: true,
        writeOutput: () => undefined,
      }),
    ).toBe(0);

    const persisted = await loadChannelState(base);
    expect(prompts[0]?.sessionId).toBeNull();
    expect(prompts[0]?.prompt).toContain("attention_get_my_account");
    expect(persisted.brainSession).toBeNull();

    await handleInboundMessage({
      brain: {
        ...brainLifecycle(),
        hostId: "codex",
        invoke: async () => {
          throw new Error("invokeBrain seam should be used");
        },
      },
      cwd: "/tmp",
      invokeBrain: async (input) => {
        prompts.push(input);
        return {
          ok: true,
          reply: "已收藏",
          resumeFailed: false,
          sessionId: "channel-session",
          timedOut: false,
        };
      },
      message: {
        contextToken: "ctx-1",
        fromUserId: "owner",
        itemList: [
          { text_item: { text: "https://example.com/first" }, type: 1 },
        ],
        raw: {
          client_id: "first-real-message",
          context_token: "ctx-1",
          from_user_id: "owner",
        },
      },
      state: persisted,
    });

    expect(prompts[1]?.sessionId).toBeNull();
    expect(prompts[1]?.prompt).toContain("专用收藏渠道");
    expect(prompts[1]?.prompt).toContain("https://example.com/first");
    expect(persisted.brainSession?.sessionId).toBe("channel-session");
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
          ...brainLifecycle(),
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

  it("pins pairing to the local owner, preserves reply order, and reports signed-out", async () => {
    const base = await makeTempBase();
    const state = defaultChannelState();
    state.token = "local-ilink-token";
    state.accountId = "local-account";
    await saveChannelState(state, base);
    const pairingCode = "ABCD2345";
    const sentTexts: string[] = [];
    const transitions: RuntimeReporterSnapshot[] = [];
    let update = 0;
    let reporterOptions: RuntimeReporterOptions | null = null;

    const reporter: RuntimeReporter = {
      activity: () => undefined,
      renewPairing: () => undefined,
      snapshot: () => ({
        bindingId: null,
        lastErrorCode: null,
        status: "active",
      }),
      start: () => {
        reporterOptions?.onBindingChallenge?.({
          binding_id: "22222222-2222-4222-8222-222222222222",
          challenge_id: "33333333-3333-4333-8333-333333333333",
          expires_at: "2099-08-10T10:10:00.000Z",
          issued_at: "2099-08-10T10:00:00.000Z",
          pairing_code: pairingCode,
        });
      },
      stop: async () => undefined,
      transition: (value) => transitions.push(value),
      verifyPairing: () => {
        setTimeout(() => {
          reporterOptions?.onBindingVerified?.(
            "22222222-2222-4222-8222-222222222222",
          );
        }, 5);
      },
    };

    expect(
      await channelStart("codex", {
        accountVerifier: async () => ({
          attentionId: "filter-demo",
          displayName: "Filter Demo",
          isFilter: true,
          isMember: true,
        }),
        baseDirectory: base,
        brainFactory: () => ({
          ...brainLifecycle(),
          hostId: "codex",
          invoke: async () => ({
            ok: true,
            reply: "not reached for local controls",
            resumeFailed: false,
            sessionId: "thread-1",
            timedOut: false,
          }),
        }),
        fetchImpl: async (url, init) => {
          const path = new URL(String(url)).pathname;
          if (path.endsWith("/getupdates")) {
            update += 1;
            if (update === 1) {
              return new Response(JSON.stringify({
                errcode: 0,
                get_updates_buf: "cursor-1",
                msgs: [{
                  client_id: "message-1",
                  context_token: "ctx-owner",
                  from_user_id: "owner",
                  item_list: [{ text_item: { text: "状态" }, type: 1 }],
                }],
                ret: 0,
              }));
            }
            if (update === 2) {
              return new Response(JSON.stringify({
                errcode: 0,
                get_updates_buf: "cursor-2",
                msgs: [{
                  client_id: "message-2",
                  context_token: "ctx-owner",
                  from_user_id: "owner",
                  item_list: [{ text_item: { text: pairingCode }, type: 1 }],
                }],
                ret: 0,
              }));
            }
            for (
              let attempt = 0;
              attempt < 20 &&
              !sentTexts.includes("Attention 设备绑定成功。");
              attempt += 1
            ) {
              await new Promise<void>((resolve) => setTimeout(resolve, 1));
            }
            return new Response(JSON.stringify({ errcode: -14, ret: 0 }));
          }
          if (path.endsWith("/sendmessage")) {
            const body = JSON.parse(String(init?.body)) as {
              msg: { item_list: Array<{ text_item: { text: string } }> };
            };
            sentTexts.push(body.msg.item_list[0]?.text_item.text ?? "");
            return new Response(JSON.stringify({ errcode: 0, ret: 0 }));
          }
          throw new Error(`Unexpected iLink path: ${path}`);
        },
        hostCliCheck: async () => true,
        origin: "https://attention.example",
        runtimeCredentialLoader: async () => true,
        runtimeReporterFactory: (options) => {
          reporterOptions = options;
          return reporter;
        },
        service: true,
        writeOutput: () => undefined,
      }),
    ).toBe(0);

    expect(sentTexts[0]).toContain(`Attention 设备绑定码：${pairingCode}`);
    expect(sentTexts.indexOf("正在验证设备绑定…")).toBeGreaterThan(-1);
    expect(
      sentTexts.filter((text) => text === "正在验证设备绑定…"),
    ).toHaveLength(1);
    expect(sentTexts.indexOf("Attention 设备绑定成功。")).toBeGreaterThan(
      sentTexts.indexOf("正在验证设备绑定…"),
    );
    expect(transitions.some((item) => item.ilinkStatus === "signed_out")).toBe(
      true,
    );
    expect((await loadChannelState(base)).ownerUserId).toBe("owner");
  });

  it("replaces the live reporter after DCR client rotation without rotating device identity", async () => {
    const base = await makeTempBase();
    const dcrInstallationId = "11111111-1111-4111-8111-111111111111";
    const state = defaultChannelState();
    state.token = "local-ilink-token";
    state.accountId = "local-account";
    state.runtimeReporter.installationId = dcrInstallationId;
    await saveChannelState(state, base);
    const dcrIdentity = await loadRuntimeRegistrationIdentity(base);
    expect(dcrIdentity.installationId).toBe(dcrInstallationId);

    const reporterOptions: RuntimeReporterOptions[] = [];
    const reporterStops: Array<{
      readonly discardPending: boolean | undefined;
      readonly index: number;
    }> = [];
    const persistedReporterStates: Array<{
      readonly bindingId: string | null;
      readonly installationId: string | null;
      readonly runtimeClientFingerprint: string | null;
    }> = [];
    let credentialLoads = 0;
    let updates = 0;

    expect(
      await channelStart("codex", {
        accountVerifier: async () => ({
          attentionId: "filter-demo",
          displayName: "Filter Demo",
          isFilter: true,
          isMember: true,
        }),
        baseDirectory: base,
        brainFactory: () => ({
          ...brainLifecycle(),
          hostId: "codex",
          invoke: async () => ({
            ok: true,
            reply: "not reached",
            resumeFailed: false,
            sessionId: "thread-1",
            timedOut: false,
          }),
        }),
        fetchImpl: async (url) => {
          const path = new URL(String(url)).pathname;
          if (!path.endsWith("/getupdates")) {
            throw new Error(`Unexpected iLink path: ${path}`);
          }
          updates += 1;
          if (updates === 1) {
            let current = await loadChannelState(base);
            for (
              let attempt = 0;
              attempt < 200 && current.runtimeReporter.bindingId === null;
              attempt += 1
            ) {
              await new Promise<void>((resolve) => setTimeout(resolve, 5));
              current = await loadChannelState(base);
            }
            expect(current.runtimeReporter.bindingId).not.toBeNull();
            persistedReporterStates.push(current.runtimeReporter);
            return new Response(JSON.stringify({
              errcode: 0,
              get_updates_buf: "cursor-1",
              msgs: [],
              ret: 0,
            }));
          }
          await vi.waitFor(() => expect(reporterOptions).toHaveLength(2));
          persistedReporterStates.push(
            (await loadChannelState(base)).runtimeReporter,
          );
          return new Response(JSON.stringify({ errcode: -14, ret: 0 }));
        },
        hostCliCheck: async () => true,
        origin: "https://attention.example",
        runtimeCredentialLoader: async () => ({
          clientId: credentialLoads++ === 0
            ? "runtime-client-account-a"
            : "runtime-client-account-b",
        }),
        runtimeReporterFactory: (options) => {
          const index = reporterOptions.push(options) - 1;
          return {
            activity: () => undefined,
            renewPairing: () => undefined,
            snapshot: () => ({
              bindingId: null,
              lastErrorCode: null,
              status: "active",
            }),
            start: () => {
              if (index === 0) {
                options.onBindingVerified?.(
                  "22222222-2222-4222-8222-222222222222",
                );
              }
            },
            stop: async (stopOptions) => {
              reporterStops.push({
                discardPending: stopOptions?.discardPending,
                index,
              });
            },
            transition: () => undefined,
            verifyPairing: () => undefined,
          };
        },
        service: true,
        writeOutput: () => undefined,
      }),
    ).toBe(0);

    expect(reporterOptions).toHaveLength(2);
    expect(reporterOptions[0]?.identity.installationId).toBe(
      dcrIdentity.installationId,
    );
    expect(reporterOptions[1]?.identity.installationId).toBe(
      dcrIdentity.installationId,
    );
    expect(reporterOptions[1]?.identity.bindingId).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
    expect(reporterStops).toContainEqual({ discardPending: true, index: 0 });
    expect(persistedReporterStates).toHaveLength(2);
    expect(persistedReporterStates[0]?.bindingId).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
    expect(persistedReporterStates[1]?.bindingId).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
    expect(persistedReporterStates[1]?.installationId).toBe(dcrInstallationId);
    expect(persistedReporterStates[1]?.runtimeClientFingerprint).not.toBe(
      persistedReporterStates[0]?.runtimeClientFingerprint,
    );
  });

  it("rotates a conflicted installation and starts a fresh Reporter without restarting the bridge", async () => {
    const base = await makeTempBase();
    const state = defaultChannelState();
    state.token = "local-ilink-token";
    state.accountId = "local-account";
    state.runtimeReporter = {
      bindingId: "22222222-2222-4222-8222-222222222222",
      installationId: "11111111-1111-4111-8111-111111111111",
      runtimeClientFingerprint: null,
    };
    await saveChannelState(state, base);

    const reporterOptions: RuntimeReporterOptions[] = [];
    const reporterStarts: number[] = [];
    const reporterStops: Array<{
      readonly discardPending: boolean | undefined;
      readonly index: number;
    }> = [];
    let brainStarts = 0;
    let brainShutdowns = 0;
    let updates = 0;

    expect(
      await channelStart("codex", {
        accountVerifier: async () => ({
          attentionId: "filter-demo",
          displayName: "Filter Demo",
          isFilter: true,
          isMember: true,
        }),
        baseDirectory: base,
        brainFactory: () => ({
          hostId: "codex",
          invoke: async () => ({
            ok: true,
            reply: "not reached",
            resumeFailed: false,
            sessionId: "thread-1",
            timedOut: false,
          }),
          runtimeSnapshot: () => ({
            lastErrorCode: null,
            phase: brainStarts > brainShutdowns ? "healthy" : "stopped",
            retryAttempt: 0,
          }),
          shutdown: async () => {
            brainShutdowns += 1;
          },
          start: async () => {
            brainStarts += 1;
          },
        }),
        fetchImpl: async (url) => {
          const path = new URL(String(url)).pathname;
          if (!path.endsWith("/getupdates")) {
            throw new Error(`Unexpected iLink path: ${path}`);
          }
          updates += 1;
          if (updates === 1) {
            return new Response(JSON.stringify({
              errcode: 0,
              get_updates_buf: "cursor-1",
              msgs: [],
              ret: 0,
            }));
          }
          await vi.waitFor(() => expect(reporterOptions).toHaveLength(2));
          await vi.waitFor(async () => {
            expect(
              (await loadChannelState(base)).runtimeReporter.bindingId,
            ).toBe("44444444-4444-4444-8444-444444444444");
          });
          return new Response(JSON.stringify({ errcode: -14, ret: 0 }));
        },
        hostCliCheck: async () => true,
        origin: "https://attention.example",
        runtimeCredentialLoader: async () => ({
          clientId: "same-runtime-client",
        }),
        runtimeReporterFactory: (options) => {
          const index = reporterOptions.push(options) - 1;
          return {
            activity: () => undefined,
            renewPairing: () => undefined,
            snapshot: () => ({
              bindingId: options.identity.bindingId,
              lastErrorCode: null,
              status: "active",
            }),
            start: () => {
              reporterStarts.push(index);
              if (index === 0) {
                options.onInstallationInvalidated?.();
              } else {
                options.onBindingVerified?.(
                  "44444444-4444-4444-8444-444444444444",
                );
              }
            },
            stop: async (stopOptions) => {
              reporterStops.push({
                discardPending: stopOptions?.discardPending,
                index,
              });
              if (index === 0) {
                options.onBindingVerified?.(
                  "33333333-3333-4333-8333-333333333333",
                );
              }
            },
            transition: () => undefined,
            verifyPairing: () => undefined,
          };
        },
        service: true,
        writeOutput: () => undefined,
      }),
    ).toBe(0);

    expect(brainStarts).toBe(1);
    expect(brainShutdowns).toBe(1);
    expect(reporterStarts).toEqual([0, 1]);
    expect(reporterOptions[0]?.identity.installationId).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(reporterOptions[1]?.identity.installationId).not.toBe(
      reporterOptions[0]?.identity.installationId,
    );
    expect(reporterOptions[1]?.identity.bindingId).toBeNull();
    expect(reporterStops).toContainEqual({ discardPending: true, index: 0 });
    expect(
      reporterStops.filter(
        (item) => item.index === 0 && item.discardPending === true,
      ),
    ).toHaveLength(1);
    const persisted = await loadChannelState(base);
    expect(persisted.runtimeReporter.installationId).toBe(
      reporterOptions[1]?.identity.installationId,
    );
    expect(persisted.runtimeReporter.bindingId).toBe(
      "44444444-4444-4444-8444-444444444444",
    );
  });

  it("keeps failed business messages FIFO while allowing local status to bypass cooldown", async () => {
    const base = await makeTempBase();
    const state = defaultChannelState();
    state.token = "local-ilink-token";
    state.accountId = "local-account";
    await saveChannelState(state, base);
    const brainPrompts: string[] = [];
    const sentTexts: string[] = [];
    let update = 0;

    expect(
      await channelStart("codex", {
        accountVerifier: async () => ({
          attentionId: "filter-demo",
          displayName: "Filter Demo",
          isFilter: true,
          isMember: true,
        }),
        baseDirectory: base,
        brainFactory: () => ({
          ...brainLifecycle(),
          hostId: "codex",
          invoke: async ({ prompt }) => {
            brainPrompts.push(prompt);
            if (brainPrompts.length === 1) {
              return {
                ok: false,
                reply: "",
                resumeFailed: false,
                sessionId: "thread-1",
                timedOut: false,
              };
            }
            return {
              ok: true,
              reply: "B 不应越过 A",
              resumeFailed: false,
              sessionId: "thread-1",
              timedOut: false,
            };
          },
        }),
        fetchImpl: async (url, init) => {
          const path = new URL(String(url)).pathname;
          if (path.endsWith("/getupdates")) {
            update += 1;
            if (update === 1) {
              return new Response(JSON.stringify({
                errcode: 0,
                get_updates_buf: "cursor-1",
                msgs: [
                  {
                    client_id: "message-a",
                    context_token: "ctx-owner",
                    from_user_id: "owner",
                    item_list: [{ text_item: { text: "A 收藏" }, type: 1 }],
                  },
                  {
                    client_id: "message-b",
                    context_token: "ctx-owner",
                    from_user_id: "owner",
                    item_list: [{ text_item: { text: "B 收藏" }, type: 1 }],
                  },
                  {
                    client_id: "message-status",
                    context_token: "ctx-owner",
                    from_user_id: "owner",
                    item_list: [{ text_item: { text: "状态" }, type: 1 }],
                  },
                ],
                ret: 0,
              }));
            }
            return new Response(JSON.stringify({ errcode: -14, ret: 0 }));
          }
          if (path.endsWith("/sendmessage")) {
            const body = JSON.parse(String(init?.body)) as {
              msg: { item_list: Array<{ text_item: { text: string } }> };
            };
            sentTexts.push(body.msg.item_list[0]?.text_item.text ?? "");
            return new Response(JSON.stringify({ errcode: 0, ret: 0 }));
          }
          throw new Error(`Unexpected iLink path: ${path}`);
        },
        hostCliCheck: async () => true,
        origin: "https://attention.example",
        runtimeCredentialLoader: async () => false,
        service: true,
        writeOutput: () => undefined,
      }),
    ).toBe(0);

    expect(brainPrompts).toHaveLength(1);
    expect(brainPrompts[0]).toContain("A 收藏");
    expect(sentTexts.some((text) => text.includes("Codex Runtime"))).toBe(true);
    const persisted = await loadChannelState(base);
    expect(persisted.pendingInbound.map((item) => item.id)).toEqual([
      "message-a",
      "message-b",
    ]);
    expect(persisted.pendingInbound[0]?.attempts).toBe(1);
  });

  it("stops a background service cleanly when Attention OAuth needs repair", async () => {
    const base = await makeTempBase();
    const lines: string[] = [];
    expect(
      await channelStart("codex", {
        accountVerifier: async () => null,
        baseDirectory: base,
        brainFactory: () => ({
          ...brainLifecycle(),
          hostId: "codex",
          invoke: async () => ({
            ok: false,
            reply: "",
            resumeFailed: false,
            sessionId: null,
            timedOut: false,
          }),
        }),
        hostCliCheck: async () => true,
        origin: "https://attention.example",
        service: true,
        writeOutput: (text) => lines.push(text),
      }),
    ).toBe(0);
    expect(lines.join("")).toContain("OAuth");
    expect(lines.join("")).toContain("重新运行");
  });

  it("checks for a managed update only after the service is healthy and idle", async () => {
    const base = await makeTempBase();
    const state = defaultChannelState();
    state.token = "local-ilink-token";
    state.accountId = "local-account";
    await saveChannelState(state, base);
    const events: string[] = [];

    expect(
      await channelStart("codex", {
        accountVerifier: async () => ({
          attentionId: "filter-demo",
          displayName: "Filter Demo",
          isFilter: true,
          isMember: true,
        }),
        baseDirectory: base,
        brainFactory: () => ({
          ...brainLifecycle(),
          hostId: "codex",
          invoke: async () => ({
            ok: true,
            reply: "not reached",
            resumeFailed: false,
            sessionId: "thread-1",
            timedOut: false,
          }),
        }),
        bridgeHealthyMarker: async () => {
          events.push("healthy");
        },
        bridgeUpdateChecker: async () => {
          events.push("check");
          return { status: "staged", version: "0.3.6" };
        },
        fetchImpl: async () => {
          throw new Error("iLink long poll must not start after an update is staged");
        },
        hostCliCheck: async () => true,
        origin: "https://attention.example",
        runtimeCredentialLoader: async () => false,
        service: true,
      }),
    ).toBe(75);
    expect(events).toEqual(["healthy", "check"]);
  });

  it("defers a managed update while a durable reply remains unsent", async () => {
    const base = await makeTempBase();
    const state = defaultChannelState();
    state.token = "local-ilink-token";
    state.accountId = "local-account";
    state.pendingOutbound.push({
      contextToken: "ctx-owner",
      id: "reply-1",
      text: "已收藏。",
      toUserId: "owner",
    });
    await saveChannelState(state, base);
    let checks = 0;

    expect(
      await channelStart("codex", {
        accountVerifier: async () => ({
          attentionId: "filter-demo",
          displayName: "Filter Demo",
          isFilter: true,
          isMember: true,
        }),
        baseDirectory: base,
        brainFactory: () => ({
          ...brainLifecycle(),
          hostId: "codex",
          invoke: async () => ({
            ok: true,
            reply: "not reached",
            resumeFailed: false,
            sessionId: "thread-1",
            timedOut: false,
          }),
        }),
        bridgeHealthyMarker: async () => undefined,
        bridgeUpdateChecker: async () => {
          checks += 1;
          return { status: "staged", version: "0.3.6" };
        },
        fetchImpl: async (url) => {
          const path = new URL(String(url)).pathname;
          return path.endsWith("/sendmessage")
            ? new Response(JSON.stringify({ errcode: 1, ret: 1 }))
            : new Response(JSON.stringify({ errcode: -14, ret: 0 }));
        },
        hostCliCheck: async () => true,
        origin: "https://attention.example",
        runtimeCredentialLoader: async () => false,
        service: true,
      }),
    ).toBe(0);
    expect(checks).toBe(0);
    expect((await loadChannelState(base)).pendingOutbound).toHaveLength(1);
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
        ...brainLifecycle(),
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

  it("never replays Channel history during account verification", async () => {
    const invocations: Array<{ prompt: string; sessionId: string | null }> = [];
    const result = await verifyAttentionAccount(
      {
        ...brainLifecycle(),
        hostId: "codex",
        invoke: async ({ prompt, sessionId }) => {
          invocations.push({ prompt, sessionId });
          return {
            ok: true,
            reply:
              'ATTENTION_ACCOUNT_OK {"display_name":"Ethan","attention_id":"ethancc","is_filter":true,"is_member":true}',
            resumeFailed: false,
            sessionId: "disposable-preflight-thread",
            timedOut: false,
          };
        },
      },
      "/tmp",
    );

    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.sessionId).toBeNull();
    expect(invocations[0]?.prompt).toContain("attention_get_my_account");
    expect(result?.attentionId).toBe("ethancc");
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
    state.brainSession = {
      hostId: "codex",
      sessionId: "019feb40-private-thread-id",
      updatedAt: "2026-08-10T10:00:00.000Z",
    };
    state.runtimeState = {
      activeTurnMessageRef:
        "msg-72cad190ed71ed0309138ac14e9982dbc21abd357ff0820d",
      lastErrorCode: "codex_runtime_crashed",
      lastHealthyAt: "2026-08-10T09:59:00.000Z",
      lastSuccessfulMessageAt: "2026-08-10T09:58:00.000Z",
      lastTransitionAt: "2026-08-10T10:00:00.000Z",
      nextRetryAt: "2026-08-10T10:00:04.000Z",
      phase: "restarting",
      retryAttempt: 2,
    };
    await saveChannelState(state, base);
    const lines: string[] = [];
    await channelStatus({
      baseDirectory: base,
      json: true,
      serviceInspector: async () => true,
      bridgeUpdateStateLoader: async () => ({
        current: {
          artifactPath: "/Users/example/.local/share/attention/versions/attention-0.3.5.mjs",
          permissionProfileSha256: "a".repeat(64),
          version: "0.3.5",
        },
        lastCheckAt: "2026-08-14T02:00:00.000Z",
        lastErrorCode: null,
        latestVersion: "0.3.6",
        pending: null,
        previous: null,
        schemaVersion: 1,
        status: "update_available",
      }),
      writeOutput: (text) => lines.push(text),
    });
    const report = JSON.parse(lines.join("")) as Record<string, unknown>;
    expect(report.loggedIn).toBe(true);
    expect(report.accountIdPrefix).toBe("accoun…");
    expect(report.pendingInbound).toBe(0);
    expect(report.pendingOutbound).toBe(0);
    expect(report.backgroundConfigured).toBe(true);
    expect(report.brainSession).toEqual({
      hostId: "codex",
      updatedAt: "2026-08-10T10:00:00.000Z",
    });
    expect(report.runtime).toMatchObject({
      lastErrorCode: "codex_runtime_crashed",
      phase: "restarting",
      retryAttempt: 2,
    });
    expect(report.update).toEqual({
      installedVersion: "0.3.5",
      lastCheckAt: "2026-08-14T02:00:00.000Z",
      lastErrorCode: null,
      latestVersion: "0.3.6",
      status: "update_available",
    });
    expect(lines.join("")).not.toContain("super-secret-token");
    expect(lines.join("")).not.toContain("019feb40-private-thread-id");
    expect(lines.join("")).not.toContain(
      "msg-72cad190ed71ed0309138ac14e9982dbc21abd357ff0820d",
    );
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
