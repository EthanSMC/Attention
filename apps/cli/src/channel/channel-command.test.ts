import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ATTENTION_BRIDGE_PERMISSION_PROFILE_SHA256 } from "../bridge-update-contract";
import { ATTENTION_CLI_VERSION } from "../version";
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
  runtimeReporterDegradedMessage,
  verifyAttentionAccount,
} from "./channel-command";
import { defaultChannelState, loadChannelState, saveChannelState } from "./state";
import { acquireChannelLock } from "./lock";
import {
  bootstrapManagedBridge,
  loadManagedBridgeUpdateState,
  saveManagedBridgeUpdateState,
} from "./managed-bridge";
import { buildMessageRef, handleInboundMessage } from "./pipeline";

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

function verifiedAccountProbe(
  account: {
    readonly attentionId: string | null;
    readonly displayName: string;
    readonly isFilter: boolean;
    readonly isMember: boolean;
  } = {
    attentionId: "filter-demo",
    displayName: "Filter Demo",
    isFilter: true,
    isMember: true,
  },
) {
  return { account, ok: true as const };
}

function failedAccountProbe() {
  return {
    errorCode: "mcp_auth_required" as const,
    ok: false as const,
    retryable: false,
  };
}

describe("channel subcommands", () => {
  const tempDirs: string[] = [];

  const makeTempBase = async (): Promise<string> => {
    const directory = await mkdtemp(join(tmpdir(), "attention-channel-cli-"));
    tempDirs.push(directory);
    return directory;
  };

  it.each([
    [
      "runtime_channel_session_superseded",
      "重新扫码",
    ],
    [
      "runtime_channel_session_proof_required",
      "更新 Attention CLI",
    ],
  ])("explains the %s Reporter failure", (errorCode, expectedCopy) => {
    expect(runtimeReporterDegradedMessage(errorCode)).toContain(expectedCopy);
  });

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

  it("continues polling an existing iLink session when Attention account verification fails", async () => {
    const base = await makeTempBase();
    const state = defaultChannelState();
    state.token = "local-ilink-token";
    state.accountId = "local-account";
    await saveChannelState(state, base);
    const lines: string[] = [];
    const sentTexts: string[] = [];
    let brainInvocations = 0;
    let updates = 0;
    let updatePollAttempted = false;
    const exitCode = await channelStart("codex", {
      accountVerifier: async () => failedAccountProbe(),
      baseDirectory: base,
      brainFactory: () => ({
        ...brainLifecycle(),
        hostId: "codex",
        invoke: async () => {
          brainInvocations += 1;
          return {
          ok: true,
          reply: "我还在，可以继续聊。",
          resumeFailed: false,
          sessionId: "thread-1",
          timedOut: false,
          };
        },
      }),
      bridgeUpdateChecker: async () => ({
        status: "current",
        version: "0.3.8",
      }),
      fetchImpl: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/getupdates")) {
          updatePollAttempted = true;
          updates += 1;
          if (updates === 1) {
            return new Response(JSON.stringify({
              errcode: 0,
              get_updates_buf: "cursor-1",
              msgs: [{
                client_id: "message-chat",
                context_token: "ctx-owner",
                from_user_id: "owner",
                item_list: [{ text_item: { text: "你还在吗" }, type: 1 }],
              }],
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
      writeOutput: (text) => lines.push(text),
    });

    expect(exitCode).toBe(0);
    expect(updatePollAttempted).toBe(true);
    expect(brainInvocations).toBe(1);
    expect(sentTexts).toContain("我还在，可以继续聊。");
    expect(lines.join("")).toContain("需要重新授权");
    expect(lines.join("")).toContain("普通对话仍可用");
  });

  it("records a bounded recovery attempt for a transient startup probe failure", async () => {
    const base = await makeTempBase();
    const state = defaultChannelState();
    state.token = "local-ilink-token";
    state.accountId = "local-account";
    await saveChannelState(state, base);

    expect(
      await channelStart("codex", {
        accountVerifier: async () => ({
          errorCode: "mcp_server_unreachable",
          ok: false,
          retryable: true,
        }),
        baseDirectory: base,
        brainFactory: () => ({
          ...brainLifecycle(),
          hostId: "codex",
          invoke: async () => ({
            ok: true,
            reply: "普通对话仍可用",
            resumeFailed: false,
            sessionId: "thread-1",
            timedOut: false,
          }),
        }),
        bridgeUpdateChecker: async () => ({
          status: "current",
          version: "0.3.8",
        }),
        fetchImpl: async () =>
          new Response(JSON.stringify({ errcode: -14, ret: 0 })),
        hostCliCheck: async () => true,
        origin: "https://attention.example",
        runtimeCredentialLoader: async () => false,
        service: true,
        writeOutput: () => undefined,
      }),
    ).toBe(0);

    expect((await loadChannelState(base)).attentionMcp).toMatchObject({
      lastErrorCode: "mcp_server_unreachable",
      retryAttempt: 1,
      status: "unreachable",
    });
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

  it("submits the phone verification code before completing iLink login", async () => {
    const base = await makeTempBase();
    const lines: string[] = [];
    const statusUrls: string[] = [];
    const verificationInputs = ["not-a-number", "123"];
    let statusPoll = 0;

    expect(
      await channelStart("codex", {
        background: true,
        backgroundInstaller: async () => undefined,
        baseDirectory: base,
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.includes("get_bot_qrcode")) {
            return new Response(JSON.stringify({
              qrcode: "qr-verify",
              qrcode_img_content: "https://weixin.qq.com/x/qr-verify",
              ret: 0,
            }));
          }
          statusUrls.push(url);
          statusPoll += 1;
          return new Response(JSON.stringify(
            statusPoll === 1
              ? { ret: 0, status: "need_verifycode" }
              : {
                  bot_token: "verified-token",
                  ilink_bot_id: "verified-account",
                  ret: 0,
                  status: "confirmed",
                },
          ));
        },
        hostCliCheck: async () => true,
        origin: "https://attention.example",
        readInput: async () => {
          const input = verificationInputs.shift();
          if (input === undefined) {
            throw new Error("purely numeric input should have been submitted");
          }
          return input;
        },
        writeOutput: (text) => lines.push(text),
      }),
    ).toBe(0);

    expect(lines.join("")).toContain("输入手机微信显示的数字");
    expect(lines.join("")).toContain("手机验证码只能包含数字");
    expect(statusUrls[1]).toContain("verify_code=123");
    expect(statusUrls[1]).not.toContain("not-a-number");
    expect((await loadChannelState(base)).token).toBe("verified-token");
  });

  it("reports a scanned QR before confirmation", async () => {
    const base = await makeTempBase();
    const lines: string[] = [];
    let statusPoll = 0;

    expect(
      await channelStart("codex", {
        background: true,
        backgroundInstaller: async () => undefined,
        baseDirectory: base,
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.includes("get_bot_qrcode")) {
            return new Response(JSON.stringify({
              qrcode: "qr-scanned",
              qrcode_img_content: "https://weixin.qq.com/x/qr-scanned",
              ret: 0,
            }));
          }
          statusPoll += 1;
          return new Response(JSON.stringify(
            statusPoll === 1
              ? { ret: 0, status: "scaned" }
              : {
                  bot_token: "scanned-token",
                  ilink_bot_id: "scanned-account",
                  ret: 0,
                  status: "confirmed",
                },
          ));
        },
        hostCliCheck: async () => true,
        origin: "https://attention.example",
        writeOutput: (text) => lines.push(text),
      }),
    ).toBe(0);

    expect(lines.join("")).toContain("微信已扫码，等待手机确认");
  });

  it("refreshes the QR after phone verification is blocked", async () => {
    const base = await makeTempBase();
    const lines: string[] = [];
    let qrFetches = 0;
    let firstQrPolls = 0;

    expect(
      await channelStart("codex", {
        background: true,
        backgroundInstaller: async () => undefined,
        baseDirectory: base,
        fetchImpl: async (input) => {
          const url = new URL(String(input));
          if (url.pathname.endsWith("/get_bot_qrcode")) {
            qrFetches += 1;
            return new Response(JSON.stringify({
              qrcode: `qr-blocked-${qrFetches}`,
              qrcode_img_content: `https://weixin.qq.com/x/qr-blocked-${qrFetches}`,
              ret: 0,
            }));
          }
          const qrcode = url.searchParams.get("qrcode");
          if (qrcode === "qr-blocked-1") {
            firstQrPolls += 1;
            return new Response(JSON.stringify(
              firstQrPolls === 1
                ? { ret: 0, status: "need_verifycode" }
                : firstQrPolls === 2
                  ? { ret: 0, status: "verify_code_blocked" }
                  : {
                      bot_token: "stale-token",
                      ilink_bot_id: "stale-account",
                      ret: 0,
                      status: "confirmed",
                    },
            ));
          }
          return new Response(JSON.stringify({
            bot_token: "refreshed-token",
            ilink_bot_id: "refreshed-account",
            ret: 0,
            status: "confirmed",
          }));
        },
        hostCliCheck: async () => true,
        origin: "https://attention.example",
        readInput: async () => "000000",
        writeOutput: (text) => lines.push(text),
      }),
    ).toBe(0);

    expect(qrFetches).toBe(2);
    expect(lines.join("")).toContain("手机验证码多次错误或已被阻断");
    expect((await loadChannelState(base)).token).toBe("refreshed-token");
  });

  it("continues QR polling on the validated redirect host", async () => {
    const base = await makeTempBase();
    const statusHosts: string[] = [];

    expect(
      await channelStart("codex", {
        background: true,
        backgroundInstaller: async () => undefined,
        baseDirectory: base,
        fetchImpl: async (input) => {
          const url = new URL(String(input));
          if (url.pathname.endsWith("/get_bot_qrcode")) {
            return new Response(JSON.stringify({
              qrcode: "qr-redirect",
              qrcode_img_content: "https://weixin.qq.com/x/qr-redirect",
              ret: 0,
            }));
          }
          statusHosts.push(url.hostname);
          return new Response(JSON.stringify(
            statusHosts.length === 1
              ? {
                  redirect_host: "edge.weixin.qq.com",
                  ret: 0,
                  status: "scaned_but_redirect",
                }
              : {
                  bot_token: "redirect-token",
                  ilink_bot_id: "redirect-account",
                  ret: 0,
                  status: "confirmed",
                },
          ));
        },
        hostCliCheck: async () => true,
        origin: "https://attention.example",
        writeOutput: () => undefined,
      }),
    ).toBe(0);

    expect(statusHosts).toEqual([
      "ilinkai.weixin.qq.com",
      "edge.weixin.qq.com",
    ]);
  });

  it("starts a fresh login on the fixed endpoint instead of a stale redirect", async () => {
    const base = await makeTempBase();
    const state = defaultChannelState();
    state.baseUrl = "https://edge.weixin.qq.com";
    await saveChannelState(state, base);
    const requestHosts: string[] = [];

    expect(
      await channelStart("codex", {
        background: true,
        backgroundInstaller: async () => undefined,
        baseDirectory: base,
        fetchImpl: async (input) => {
          const url = new URL(String(input));
          requestHosts.push(url.hostname);
          return new Response(JSON.stringify(
            url.pathname.endsWith("/get_bot_qrcode")
              ? {
                  qrcode: "qr-fixed-start",
                  qrcode_img_content: "https://weixin.qq.com/x/qr-fixed-start",
                  ret: 0,
                }
              : {
                  bot_token: "fixed-token",
                  ilink_bot_id: "fixed-account",
                  ret: 0,
                  status: "confirmed",
                },
          ));
        },
        hostCliCheck: async () => true,
        origin: "https://attention.example",
        writeOutput: () => undefined,
      }),
    ).toBe(0);

    expect(requestHosts).toEqual([
      "ilinkai.weixin.qq.com",
      "ilinkai.weixin.qq.com",
    ]);
  });

  it("announces QR freshness before rendering it for an Agent-driven setup", async () => {
    const base = await makeTempBase();
    const lines: string[] = [];

    expect(
      await channelStart("codex", {
        background: true,
        backgroundInstaller: async () => undefined,
        baseDirectory: base,
        fetchImpl: async (input) => {
          const url = String(input);
          return new Response(JSON.stringify(
            url.includes("get_bot_qrcode")
              ? {
                  qrcode: "qr-fresh",
                  qrcode_img_content: "https://weixin.qq.com/x/qr-fresh",
                  ret: 0,
                }
              : {
                  bot_token: "fresh-token",
                  ilink_bot_id: "fresh-account",
                  ret: 0,
                  status: "confirmed",
                },
          ));
        },
        hostCliCheck: async () => true,
        origin: "https://attention.example",
        writeOutput: (text) => lines.push(text),
      }),
    ).toBe(0);

    const output = lines.join("");
    expect(output).toContain("二维码已生成，请立即展开当前终端输出扫码");
    expect(output.indexOf("二维码已生成")).toBeLessThan(
      output.indexOf("https://weixin.qq.com/x/qr-fresh"),
    );
  });

  it("stops on an unsupported QR status instead of waiting until expiry", async () => {
    const base = await makeTempBase();
    const lines: string[] = [];
    let statusPoll = 0;

    expect(
      await channelStart("codex", {
        background: true,
        backgroundInstaller: async () => {
          throw new Error("an unsupported login state must not install the service");
        },
        baseDirectory: base,
        fetchImpl: async (input) => {
          const url = String(input);
          if (!url.includes("get_bot_qrcode")) statusPoll += 1;
          return new Response(JSON.stringify(
            url.includes("get_bot_qrcode")
              ? {
                  qrcode: "qr-unknown",
                  qrcode_img_content: "https://weixin.qq.com/x/qr-unknown",
                  ret: 0,
                }
              : {
                  ret: 0,
                  status: statusPoll % 2 === 1 ? "future_state" : "expired",
                },
          ));
        },
        hostCliCheck: async () => true,
        origin: "https://attention.example",
        sleep: async () => undefined,
        writeOutput: (text) => lines.push(text),
      }),
    ).toBe(1);

    expect(lines.join("")).toContain("future_state");
    expect(lines.join("")).toContain("协议状态暂不受支持");
  });

  it("stops on an unsafe QR redirect instead of retrying it as a network error", async () => {
    const base = await makeTempBase();
    const lines: string[] = [];

    await expect(channelStart("codex", {
      background: true,
      backgroundInstaller: async () => {
        throw new Error("an unsafe redirect must not install the service");
      },
      baseDirectory: base,
      fetchImpl: async (input) => {
        const url = String(input);
        return new Response(JSON.stringify(
          url.includes("get_bot_qrcode")
            ? {
                qrcode: "qr-unsafe-redirect",
                qrcode_img_content: "https://weixin.qq.com/x/qr-unsafe-redirect",
                ret: 0,
              }
            : {
                redirect_host: "credential-stealer.example",
                ret: 0,
                status: "scaned_but_redirect",
              },
        ));
      },
      hostCliCheck: async () => true,
      origin: "https://attention.example",
      sleep: async () => {
        throw new Error("a protocol error must not enter the retry delay");
      },
      writeOutput: (text) => lines.push(text),
    })).resolves.toBe(1);

    expect(lines.join("")).toContain("iLink 登录响应不完整或不安全");
    expect(lines.join("")).toContain("official WeChat");
  });

  it("does not treat an already-bound response as a usable local credential", async () => {
    const base = await makeTempBase();
    const lines: string[] = [];
    let statusPoll = 0;

    expect(
      await channelStart("codex", {
        background: true,
        backgroundInstaller: async () => {
          throw new Error("missing local credentials must not install the service");
        },
        baseDirectory: base,
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.includes("get_bot_qrcode")) {
            return new Response(JSON.stringify({
              qrcode: "qr-bound",
              qrcode_img_content: "https://weixin.qq.com/x/qr-bound",
              ret: 0,
            }));
          }
          statusPoll += 1;
          return new Response(JSON.stringify({
            ret: 0,
            status: statusPoll % 2 === 1 ? "binded_redirect" : "expired",
          }));
        },
        hostCliCheck: async () => true,
        origin: "https://attention.example",
        sleep: async () => undefined,
        writeOutput: (text) => lines.push(text),
      }),
    ).toBe(1);

    expect(lines.join("")).toContain("微信报告该 Bot 已绑定");
    expect(lines.join("")).toContain("本地没有可复用的 iLink 凭据");
    expect(lines.join("")).toContain("本地 logout 无法解除");
  });

  it("distinguishes an unacknowledged mobile scan from a local protocol failure", async () => {
    const base = await makeTempBase();
    const lines: string[] = [];

    expect(
      await channelStart("codex", {
        background: true,
        backgroundInstaller: async () => undefined,
        baseDirectory: base,
        fetchImpl: async (input) => {
          const url = String(input);
          return new Response(JSON.stringify(
            url.includes("get_bot_qrcode")
              ? {
                  qrcode: "qr-upstream",
                  qrcode_img_content: "https://weixin.qq.com/x/qr-upstream",
                  ret: 0,
                }
              : { ret: 0, status: "expired" },
          ));
        },
        hostCliCheck: async () => true,
        origin: "https://attention.example",
        writeOutput: (text) => lines.push(text),
      }),
    ).toBe(1);

    expect(lines.join("")).toContain("微信/iLink 上游授权异常");
    expect(lines.join("")).toContain("手机立即显示网络错误");
  });

  it("re-probes MCP after restart even when a recent verification is cached", async () => {
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
          return {
            account: {
              attentionId: "ethancc",
              displayName: "Ethan",
              isFilter: true,
              isMember: true,
            },
            ok: true,
          };
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

    expect(verificationAttempts).toBe(1);
    expect(lines.join("")).toContain("Attention 已连接");
    expect((await loadChannelState(base)).attentionMcp.status).toBe("ready");
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
        accountVerifier: async () => verifiedAccountProbe(),
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
        accountVerifier: async () => verifiedAccountProbe(),
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
              attentionMcpProbe: verifiedAccountProbe(),
              ok: true,
              reply: "账号工具已调用",
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
        accountVerifier: async () =>
          verifiedAccountProbe({
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
    let reporterSessionFingerprint: string | null = null;

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
        accountVerifier: async () => verifiedAccountProbe(),
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
          reporterSessionFingerprint =
            options.identity.channelSessionFingerprint;
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
    expect(reporterSessionFingerprint).toBe(
      "4364d9fabd3ec3b0301b43a45cb9b2d8cd73c4b492fe67778d1b66ba75621864",
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
        accountVerifier: async () => verifiedAccountProbe(),
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
        accountVerifier: async () => verifiedAccountProbe(),
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
        accountVerifier: async () => verifiedAccountProbe(),
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

  it("keeps local retry available when Attention OAuth needs repair", async () => {
    const base = await makeTempBase();
    const state = defaultChannelState();
    state.token = "local-ilink-token";
    state.accountId = "local-account";
    await saveChannelState(state, base);
    const lines: string[] = [];
    const sentTexts: string[] = [];
    let brainStarts = 0;
    let accountVerifications = 0;
    let updates = 0;
    expect(
      await channelStart("codex", {
        accountVerifier: async () => {
          accountVerifications += 1;
          return accountVerifications === 1
            ? failedAccountProbe()
            : verifiedAccountProbe();
        },
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
          start: async () => {
            brainStarts += 1;
          },
        }),
        bridgeUpdateChecker: async () => ({
          status: "current",
          version: "0.3.8",
        }),
        fetchImpl: async (url, init) => {
          const path = new URL(String(url)).pathname;
          if (path.endsWith("/getupdates")) {
            updates += 1;
            if (updates === 1) {
              return new Response(JSON.stringify({
                errcode: 0,
                get_updates_buf: "cursor-1",
                msgs: [{
                  client_id: "message-retry",
                  context_token: "ctx-owner",
                  from_user_id: "owner",
                  item_list: [{ text_item: { text: "帮我重连一下？" }, type: 1 }],
                }],
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
        writeOutput: (text) => lines.push(text),
      }),
    ).toBe(0);
    expect(brainStarts).toBe(2);
    expect(accountVerifications).toBe(2);
    expect(sentTexts).toContain(
      "正在重新连接 Attention MCP，微信登录不会中断。",
    );
    expect(sentTexts).toContain("Attention MCP 已恢复，并已验证当前账号。");
    expect(sentTexts.indexOf("正在重新连接 Attention MCP，微信登录不会中断。"))
      .toBeLessThan(
        sentTexts.indexOf("Attention MCP 已恢复，并已验证当前账号。"),
      );
    expect(lines.join("")).toContain("OAuth");
    expect(lines.join("")).toContain("微信桥继续运行");
    expect(lines.join("")).not.toContain("后台服务已停止");
    const persisted = await loadChannelState(base);
    expect(persisted.attentionMcp.status).toBe("ready");
    expect(persisted.pendingInbound).toEqual([]);
  });

  it("reports authorization still required without claiming recovery", async () => {
    const base = await makeTempBase();
    const state = defaultChannelState();
    state.token = "local-ilink-token";
    state.accountId = "local-account";
    await saveChannelState(state, base);
    const sentTexts: string[] = [];
    let updates = 0;

    expect(
      await channelStart("codex", {
        accountVerifier: async () => failedAccountProbe(),
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
          if (path.endsWith("/getupdates")) {
            updates += 1;
            if (updates === 1) {
              return new Response(JSON.stringify({
                errcode: 0,
                get_updates_buf: "cursor-1",
                msgs: [{
                  client_id: "message-retry-auth",
                  context_token: "ctx-owner",
                  from_user_id: "owner",
                  item_list: [{ text_item: { text: "重试一下" }, type: 1 }],
                }],
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

    expect(sentTexts).toContain(
      "正在重新连接 Attention MCP，微信登录不会中断。",
    );
    expect(sentTexts.some((text) => text.includes(
      "attention configure codex --apply --login",
    ))).toBe(true);
    expect(sentTexts.some((text) => text.includes("已恢复"))).toBe(false);
    expect((await loadChannelState(base)).attentionMcp.status).toBe(
      "auth_required",
    );
  });

  it("keeps an MCP operation pending while allowing later ordinary chat", async () => {
    const base = await makeTempBase();
    const state = defaultChannelState();
    state.token = "local-ilink-token";
    state.accountId = "local-account";
    await saveChannelState(state, base);
    const sentTexts: string[] = [];
    let invocation = 0;
    let updates = 0;

    expect(
      await channelStart("codex", {
        accountVerifier: async () => verifiedAccountProbe(),
        baseDirectory: base,
        brainFactory: () => ({
          ...brainLifecycle(),
          hostId: "codex",
          invoke: async () => {
            invocation += 1;
            if (invocation === 1) {
              return {
                attentionMcpFailure: failedAccountProbe(),
                ok: true,
                reply: "模型误称已收藏",
                resumeFailed: false,
                sessionId: "thread-1",
                timedOut: false,
              };
            }
            return {
              ok: true,
              reply: "我还在，可以继续聊。",
              resumeFailed: false,
              sessionId: "thread-1",
              timedOut: false,
            };
          },
        }),
        fetchImpl: async (url, init) => {
          const path = new URL(String(url)).pathname;
          if (path.endsWith("/getupdates")) {
            updates += 1;
            if (updates === 1) {
              return new Response(JSON.stringify({
                errcode: 0,
                get_updates_buf: "cursor-1",
                msgs: [
                  {
                    client_id: "message-mcp",
                    context_token: "ctx-owner",
                    from_user_id: "owner",
                    item_list: [{ text_item: { text: "收藏 https://example.com" }, type: 1 }],
                  },
                  {
                    client_id: "message-chat",
                    context_token: "ctx-owner",
                    from_user_id: "owner",
                    item_list: [{ text_item: { text: "你还在吗" }, type: 1 }],
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

    expect(invocation).toBe(2);
    expect(sentTexts).toContain(
      "Attention MCP 需要重新授权；这条操作已保留。请在电脑完成授权后发送“重试”。",
    );
    expect(sentTexts).toContain("我还在，可以继续聊。");
    expect(sentTexts).not.toContain("模型误称已收藏");
    const persisted = await loadChannelState(base);
    expect(persisted.pendingInbound.map((item) => item.id)).toEqual([
      "message-mcp",
    ]);
    expect(persisted.pendingInbound[0]?.blockedBy).toBe("attention_mcp");
    expect(persisted.runtimeState.activeTurnMessageRef).toBe(
      buildMessageRef("message-mcp"),
    );
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
        accountVerifier: async () => verifiedAccountProbe(),
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
          return { status: "staged", version: "0.3.7" };
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

  it("checks the release manifest on startup even after a recent persisted check", async () => {
    const base = await makeTempBase();
    const state = defaultChannelState();
    state.token = "local-ilink-token";
    state.accountId = "local-account";
    await saveChannelState(state, base);
    const currentArtifactPath = join(base, "attention-current.mjs");
    await writeFile(currentArtifactPath, "#!/usr/bin/env node\n", "utf8");
    await bootstrapManagedBridge({
      currentArtifactPath,
      homeDirectory: base,
      permissionProfileSha256: ATTENTION_BRIDGE_PERMISSION_PROFILE_SHA256,
      version: ATTENTION_CLI_VERSION,
    });
    const updateState = await loadManagedBridgeUpdateState(base);
    updateState.lastCheckAt = "2026-09-04T04:59:30.000Z";
    await saveManagedBridgeUpdateState(updateState, base);
    const events: string[] = [];
    const manifest = {
      artifact_path: `/cli/attention-${ATTENTION_CLI_VERSION}.mjs`,
      minimum_supported_version: "0.3.5",
      node: ">=22.16.0",
      permission_profile_sha256:
        ATTENTION_BRIDGE_PERMISSION_PROFILE_SHA256,
      schema_version: 2,
      sha256: "a".repeat(64),
      version: ATTENTION_CLI_VERSION,
    };

    expect(
      await channelStart("codex", {
        accountVerifier: async () => verifiedAccountProbe(),
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
        bridgeUpdateClock: () => new Date("2026-09-04T05:00:00.000Z"),
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.endsWith("/cli/manifest.json")) {
            events.push("manifest");
            const response = new Response(JSON.stringify(manifest), {
              headers: { "content-type": "application/json" },
              status: 200,
            });
            Object.defineProperty(response, "url", { value: url });
            return response;
          }
          if (url.endsWith("/getupdates")) {
            events.push("getupdates");
            return new Response(JSON.stringify({ errcode: -14, ret: 0 }));
          }
          throw new Error(`Unexpected request: ${url}`);
        },
        hostCliCheck: async () => true,
        origin: "https://attention.example",
        runtimeCredentialLoader: async () => false,
        service: true,
      }),
    ).toBe(0);
    expect(events).toEqual(["manifest", "getupdates"]);
  });

  it("checks again exactly one hour after the startup attempt", async () => {
    const base = await makeTempBase();
    const state = defaultChannelState();
    state.token = "local-ilink-token";
    state.accountId = "local-account";
    await saveChannelState(state, base);
    let now = 0;
    let checks = 0;
    let polls = 0;

    expect(
      await channelStart("codex", {
        accountVerifier: async () => verifiedAccountProbe(),
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
          return checks === 1
            ? { status: "current", version: ATTENTION_CLI_VERSION }
            : { status: "staged", version: "0.3.14" };
        },
        bridgeUpdateClock: () => new Date(now),
        fetchImpl: async (input) => {
          const path = new URL(String(input)).pathname;
          if (!path.endsWith("/getupdates")) {
            throw new Error(`Unexpected iLink path: ${path}`);
          }
          polls += 1;
          if (polls === 1) now = 60 * 60 * 1_000 - 1;
          else if (polls === 2) now = 60 * 60 * 1_000;
          else return new Response(JSON.stringify({ errcode: -14, ret: 0 }));
          return new Response(
            JSON.stringify({ errcode: 0, get_updates_buf: "", msgs: [], ret: 0 }),
          );
        },
        hostCliCheck: async () => true,
        origin: "https://attention.example",
        runtimeCredentialLoader: async () => false,
        service: true,
      }),
    ).toBe(75);
    expect(checks).toBe(2);
    expect(polls).toBe(2);
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
        accountVerifier: async () => verifiedAccountProbe(),
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
          return { status: "staged", version: "0.3.7" };
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
          return failedAccountProbe();
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

  it("accepts verified account identity only from structured MCP evidence", async () => {
    const result = await verifyAttentionAccount(
      {
        ...brainLifecycle(),
        hostId: "claude-code",
        invoke: async ({ prompt, sessionId }) => {
          expect(prompt).toContain("attention_get_my_account");
          expect(sessionId).toBeNull();
          return {
            attentionMcpProbe: {
              account: {
                attentionId: "ethancc",
                displayName: "Ethan",
                isFilter: true,
                isMember: true,
              },
              ok: true,
            },
            ok: true,
            reply: "任意模型文字都不是验收证据",
            resumeFailed: false,
            sessionId: "preflight-session",
            timedOut: false,
          };
        },
      },
      "/tmp",
    );

    expect(result).toEqual({
      account: {
        attentionId: "ethancc",
        displayName: "Ethan",
        isFilter: true,
        isMember: true,
      },
      ok: true,
    });
  });

  it("rejects a model-authored success marker without tool evidence", async () => {
    const result = await verifyAttentionAccount(
      {
        ...brainLifecycle(),
        hostId: "codex",
        invoke: async () => ({
          ok: true,
          reply:
            'ATTENTION_ACCOUNT_OK {"display_name":"Forged","attention_id":"forged1","is_filter":true,"is_member":true}',
          resumeFailed: false,
          sessionId: "preflight-session",
          timedOut: false,
        }),
      },
      "/tmp",
    );

    expect(result).toEqual({
      errorCode: "mcp_account_probe_failed",
      ok: false,
      retryable: false,
    });
  });

  it("passes through a classified MCP authorization failure", async () => {
    const result = await verifyAttentionAccount(
      {
        ...brainLifecycle(),
        hostId: "codex",
        invoke: async () => ({
          attentionMcpProbe: {
            errorCode: "mcp_auth_required",
            ok: false,
            retryable: false,
          },
          ok: true,
          reply: "需要授权",
          resumeFailed: false,
          sessionId: "preflight-session",
          timedOut: false,
        }),
      },
      "/tmp",
    );

    expect(result).toEqual({
      errorCode: "mcp_auth_required",
      ok: false,
      retryable: false,
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
            attentionMcpProbe: {
              account: {
                attentionId: "ethancc",
                displayName: "Ethan",
                isFilter: true,
                isMember: true,
              },
              ok: true,
            },
            ok: true,
            reply: "账号工具已调用",
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
    expect(result.ok && result.account.attentionId).toBe("ethancc");
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
        latestVersion: "0.3.7",
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
      latestVersion: "0.3.7",
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
