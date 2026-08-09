/**
 * `attention channel` subcommands: the one-command path from WeChat into the
 * user's own local Agent.
 *
 * - `start <codex|claude-code>`: preflight, QR login when needed, then the
 *   long-poll loop that feeds messages to the restricted brain and replies.
 * - `status`: local, observable facts only (never secrets).
 * - `logout`: delete local iLink state.
 *
 * The bridge never uploads iLink credentials; it also does not register with
 * the Local Channel Runtime in this release (clean seam for a later
 * Reporter).
 */

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { runCommand } from "../command-runner";
import { resolveAttentionPublicUrl } from "../origin";
import { createBrainAdapter, type BrainAdapter } from "./brain";
import { ILinkClient } from "./ilink-client";
import { ILinkSessionExpiredError, ILINK_BASE_URL } from "./ilink-protocol";
import { acquireChannelLock } from "./lock";
import {
  ILINK_LONG_POLL_TIMEOUT_MS,
  ILINK_MAXIMUM_QR_REFRESH,
  MAXIMUM_PENDING_MESSAGES,
  PROCESSING_ACK_REPLY,
} from "./limits";
import { handleInboundMessage } from "./pipeline";
import {
  completeInbound,
  enqueueInbound,
  enqueueOutbound,
  markOutboundSent,
  outboundIdentifier,
} from "./queue";
import { displayQrCode } from "./qr-display";
import {
  buildChannelServicePlan,
  buildChannelServiceRemovalPlan,
  installChannelService,
  isChannelServiceConfigured,
  uninstallChannelService,
} from "./service";
import {
  channelStateDirectory,
  clearChannelState,
  loadChannelState,
  saveChannelState,
  type ChannelState,
} from "./state";

export const CHANNEL_BRIDGE_HOSTS = ["codex", "claude-code"] as const;
export type ChannelBridgeHost = (typeof CHANNEL_BRIDGE_HOSTS)[number];

export interface ChannelCommandOptions {
  readonly accountVerifier?: (
    brain: BrainAdapter,
    cwd: string,
  ) => Promise<VerifiedAttentionAccount | null>;
  readonly baseDirectory?: string;
  readonly background?: boolean;
  readonly backgroundInstaller?: (input: {
    readonly hostId: ChannelBridgeHost;
    readonly origin: string;
  }) => Promise<void>;
  readonly brainFactory?: (
    hostId: ChannelBridgeHost,
    options: { readonly mcpUrl: string },
  ) => BrainAdapter;
  readonly fetchImpl?: typeof fetch;
  readonly hostCliCheck?: (hostId: ChannelBridgeHost) => Promise<boolean>;
  readonly origin?: string;
  readonly service?: boolean;
  readonly serviceInspector?: () => Promise<boolean>;
  readonly serviceUninstaller?: () => Promise<void>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly writeOutput?: (text: string) => void;
}

export interface VerifiedAttentionAccount {
  readonly attentionId: string | null;
  readonly displayName: string;
  readonly isFilter: boolean;
  readonly isMember: boolean;
}

interface Runtime {
  readonly client: ILinkClient;
  readonly log: (message: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly state: ChannelState;
  readonly write: (text: string) => void;
}

const HOST_EXECUTABLES: Record<ChannelBridgeHost, string> = {
  "claude-code": "claude",
  codex: "codex",
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 19);
}

export async function channelStart(
  hostId: string,
  options: ChannelCommandOptions = {},
): Promise<number> {
  const write = options.writeOutput ?? ((text) => process.stdout.write(text));
  const sleep = options.sleep ?? defaultSleep;

  if (options.background && options.service) {
    write("--background 与内部 --service 不能同时使用。\n");
    return 2;
  }

  if (!isBridgeHost(hostId)) {
    write(
      `attention channel start 只支持 ${CHANNEL_BRIDGE_HOSTS.join(" / ")}。` +
        `${hostId} 通过宿主自己的微信渠道接入，请参考 attention configure ${hostId} 的输出与 /doc/${hostId}。\n`,
    );
    return 2;
  }

  if (!options.origin) {
    write("缺少 Attention 地址。请传入 --origin 或设置 ATTENTION_ORIGIN。\n");
    return 2;
  }

  const hostCliAvailable = options.hostCliCheck
    ? await options.hostCliCheck(hostId)
    : (await checkHostCli(hostId)).ok;
  if (!hostCliAvailable) {
    write(
      `未找到 ${HOST_EXECUTABLES[hostId]} CLI。请先安装宿主 CLI，然后运行:\n` +
        `  attention configure ${hostId} --apply --login\n`,
    );
    if (options.service) {
      write(
        "后台服务已停止；安装宿主 CLI 后，请在终端重新运行 channel start --background。\n",
      );
      return 0;
    }
    return 1;
  }

  const lock = await acquireChannelLock(options.baseDirectory);
  if (!lock) {
    write(
      `Attention 微信桥已经运行（状态目录 ${channelStateDirectory(
        options.baseDirectory,
      )}）。请先停止现有进程后再试。\n`,
    );
    return 1;
  }

  try {
    const mcpUrl = resolveAttentionPublicUrl(options.origin, "/mcp");
    const brain = (options.brainFactory ?? createBrainAdapter)(hostId, {
      mcpUrl,
    });
    const cwd = channelStateDirectory(options.baseDirectory);
    await mkdir(cwd, { mode: 0o700, recursive: true });
    const account = await (options.accountVerifier ?? verifyAttentionAccount)(
      brain,
      cwd,
    );
    if (!account) {
      write(
        "Attention 账号验收失败：Agent 未能真实调用 attention_get_my_account。\n" +
          `请先运行 attention configure ${hostId} --apply --login，完成 OAuth 后重试。\n`,
      );
      if (options.service) {
        write(
          "后台服务已停止；修复 OAuth 后，请在终端重新运行 channel start --background。\n",
        );
        return 0;
      }
      return 1;
    }
    write(
      `Attention 已连接：${account.displayName}` +
        `${account.attentionId ? ` (@${account.attentionId})` : ""}` +
        `，Filter=${account.isFilter ? "是" : "否"}，Member=${account.isMember ? "是" : "否"}。\n`,
    );

    const state = await loadChannelState(options.baseDirectory);
    const client = new ILinkClient({
      baseUrl: state.baseUrl || ILINK_BASE_URL,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      timeoutMs: ILINK_LONG_POLL_TIMEOUT_MS,
    });
    client.token = state.token;
    client.accountId = state.accountId;
    const runtime: Runtime = {
      client,
      log: (message) => write(`[${timestamp()}] ${message}\n`),
      sleep,
      state,
      write,
    };

    const persist = () =>
      saveChannelState(runtime.state, options.baseDirectory);

    runtime.log(
      `attention-channel 桥启动（host=${hostId}，状态目录 ${channelStateDirectory(
        options.baseDirectory,
      )}）`,
    );

    const shutdown = () => {
      runtime.log("正在退出，保存本地状态…");
      void persist()
        .then(() => lock.release())
        .finally(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    try {
      for (;;) {
      if (!client.token) {
        if (options.service) {
          runtime.log(
            "本地 iLink 登录态不存在或已过期；后台服务不会弹出二维码。请在终端重新运行 channel start --background 完成扫码。",
          );
          return 0;
        }
        const loggedIn = await doLogin(runtime);
        if (!loggedIn) {
          await sleep(5_000);
          continue;
        }
        await persist();
      }

      if (options.background) {
        const installer = options.backgroundInstaller ?? defaultBackgroundInstaller;
        await installer({ hostId, origin: options.origin });
        runtime.log(
          "后台桥已启用。可用 attention channel status 查看本地队列；用 attention channel logout 停止并删除登录态。",
        );
        return 0;
      }

      await flushPendingOutbound(runtime, persist);
      if (!client.token) continue;
      await processPendingInbound(runtime, brain, cwd, persist);
      if (!client.token) continue;

      let updates;
      try {
        updates = await client.getUpdates(runtime.state.syncBuf);
      } catch (error) {
        if (error instanceof ILinkSessionExpiredError) {
          runtime.log("登录会话超时，清除本地登录态。");
          runtime.state.token = null;
          runtime.state.syncBuf = "";
          runtime.state.contextTokens = {};
          runtime.state.brainSession = null;
          client.token = null;
          await persist();
          if (options.service) {
            runtime.log(
              "后台服务不会弹出二维码；请在终端重新运行 channel start --background。",
            );
            return 0;
          }
          runtime.log("等待重新扫码…");
          continue;
        }
        if (isTimeoutError(error)) continue;
        runtime.log(`getupdates 异常: ${describeError(error)}`);
        await sleep(5_000);
        continue;
      }

      const added = enqueueInbound(runtime.state, updates.messages);
      if (updates.syncBuf && updates.syncBuf !== runtime.state.syncBuf) {
        runtime.state.syncBuf = updates.syncBuf;
      }
      if (added > 0 || updates.syncBuf) {
        await persist();
      }
      if (added > 0) {
        runtime.log(
          `已持久化 ${added} 条新消息，待处理 ${runtime.state.pendingInbound.length} 条`,
        );
      }
      await processPendingInbound(runtime, brain, cwd, persist);
      await flushPendingOutbound(runtime, persist);
      }
    } finally {
      process.removeListener("SIGINT", shutdown);
      process.removeListener("SIGTERM", shutdown);
    }
  } finally {
    await lock.release();
  }
}

async function processPendingInbound(
  runtime: Runtime,
  brain: BrainAdapter,
  cwd: string,
  persist: () => Promise<void>,
): Promise<void> {
  const batch = runtime.state.pendingInbound.slice(0, MAXIMUM_PENDING_MESSAGES);
  for (const pending of batch) {
    const message = pending.message;
    if (message.contextToken) {
      runtime.state.contextTokens[message.fromUserId] = message.contextToken;
    }
    if (!pending.acknowledged) {
      enqueueOutbound(runtime.state, {
        contextToken: message.contextToken,
        id: outboundIdentifier({ inboundId: pending.id, kind: "ack" }),
        text: PROCESSING_ACK_REPLY,
        toUserId: message.fromUserId,
      });
      pending.acknowledged = true;
      await persist();
      await flushPendingOutbound(runtime, persist);
      if (!runtime.client.token) return;
    }

    const outcome = await handleInboundMessage({
      brain,
      cwd,
      message,
      state: runtime.state,
    });
    if (!outcome.completed) {
      pending.attempts += 1;
      if (pending.attempts === 1) {
        outcome.replies.forEach((reply, index) => {
          enqueueOutbound(runtime.state, {
            contextToken:
              runtime.state.contextTokens[message.fromUserId] ??
              message.contextToken,
            id: outboundIdentifier({
              inboundId: pending.id,
              kind: "retry",
              index,
            }),
            text: reply,
            toUserId: message.fromUserId,
          });
        });
      }
      await persist();
      await flushPendingOutbound(runtime, persist);
      continue;
    }

    outcome.replies.forEach((reply, index) => {
      enqueueOutbound(runtime.state, {
        contextToken:
          runtime.state.contextTokens[message.fromUserId] ??
          message.contextToken,
        id: outboundIdentifier({
          inboundId: pending.id,
          kind: "result",
          index,
        }),
        text: reply,
        toUserId: message.fromUserId,
      });
    });
    completeInbound(runtime.state, pending.id);
    await persist();
    await flushPendingOutbound(runtime, persist);
    if (!runtime.client.token) return;
  }
}

async function flushPendingOutbound(
  runtime: Runtime,
  persist: () => Promise<void>,
): Promise<void> {
  while (runtime.state.pendingOutbound.length > 0 && runtime.client.token) {
    const pending = runtime.state.pendingOutbound[0];
    if (!pending) return;
    const sent = await safeSend(runtime, pending);
    runtime.log(`${sent ? "回复成功" : "回复保留待重试"}（id=${pending.id}）`);
    if (!sent) return;
    markOutboundSent(runtime.state, pending.id);
    await persist();
  }
}

const ACCOUNT_VERIFICATION_PREFIX = "ATTENTION_ACCOUNT_OK ";

export async function verifyAttentionAccount(
  brain: BrainAdapter,
  cwd: string,
): Promise<VerifiedAttentionAccount | null> {
  const outcome = await brain.invoke({
    cwd,
    prompt: [
      "这是 Attention 微信桥接启动前的账号验收。",
      "必须现在真实调用 attention_get_my_account；不要依据配置、历史或猜测回答。",
      "工具成功后，只输出一行：",
      'ATTENTION_ACCOUNT_OK {"display_name":"<返回值>","attention_id":"<返回值或null>","is_filter":<true|false>,"is_member":<true|false>}',
      "工具失败、未授权或不可用时，不要输出 ATTENTION_ACCOUNT_OK。",
    ].join("\n"),
    sessionId: null,
  });
  if (!outcome.ok) return null;
  const marker = outcome.reply
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith(ACCOUNT_VERIFICATION_PREFIX));
  if (!marker) return null;
  try {
    const parsed = JSON.parse(
      marker.slice(ACCOUNT_VERIFICATION_PREFIX.length),
    ) as Record<string, unknown>;
    if (
      typeof parsed.display_name !== "string" ||
      parsed.display_name.trim().length === 0 ||
      !(
        parsed.attention_id === null ||
        typeof parsed.attention_id === "string"
      ) ||
      typeof parsed.is_filter !== "boolean" ||
      typeof parsed.is_member !== "boolean"
    ) {
      return null;
    }
    return {
      attentionId: parsed.attention_id,
      displayName: parsed.display_name.trim(),
      isFilter: parsed.is_filter,
      isMember: parsed.is_member,
    };
  } catch {
    return null;
  }
}

export async function channelStatus(
  options: ChannelCommandOptions & { readonly json?: boolean } = {},
): Promise<number> {
  const write = options.writeOutput ?? ((text) => process.stdout.write(text));
  const state = await loadChannelState(options.baseDirectory);
  const backgroundConfigured = await (
    options.serviceInspector ?? defaultServiceInspector
  )();
  const report = {
    accountIdPrefix: state.accountId ? `${state.accountId.slice(0, 6)}…` : null,
    brainSession: state.brainSession
      ? {
          hostId: state.brainSession.hostId,
          sessionId: state.brainSession.sessionId,
          updatedAt: state.brainSession.updatedAt,
        }
      : null,
    backgroundConfigured,
    lastActivityAt: state.lastActivityAt,
    loggedIn: state.token !== null,
    ownerUserIdPrefix: state.ownerUserId
      ? `${state.ownerUserId.slice(0, 6)}…`
      : null,
    pendingInbound: state.pendingInbound.length,
    pendingOutbound: state.pendingOutbound.length,
    stateDirectory: channelStateDirectory(options.baseDirectory),
  };
  if (options.json) {
    write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  write(`已登录: ${report.loggedIn ? "是" : "否"}\n`);
  write(`后台桥已配置: ${report.backgroundConfigured ? "是" : "否"}\n`);
  if (report.accountIdPrefix) write(`账号前缀: ${report.accountIdPrefix}\n`);
  if (report.ownerUserIdPrefix) {
    write(`会话所有者前缀: ${report.ownerUserIdPrefix}\n`);
  }
  write(
    `宿主会话: ${
      report.brainSession
        ? `${report.brainSession.hostId} ${report.brainSession.sessionId}`
        : "无"
    }\n`,
  );
  write(`最近活动: ${report.lastActivityAt ?? "无"}\n`);
  write(`待处理消息: ${report.pendingInbound}\n`);
  write(`待发送回执: ${report.pendingOutbound}\n`);
  write(`状态目录: ${report.stateDirectory}\n`);
  return 0;
}

export async function channelLogout(
  options: ChannelCommandOptions = {},
): Promise<number> {
  const write = options.writeOutput ?? ((text) => process.stdout.write(text));
  let serviceError: unknown;
  try {
    await (options.serviceUninstaller ?? defaultServiceUninstaller)();
  } catch (error) {
    serviceError = error;
  } finally {
    await clearChannelState(options.baseDirectory);
  }
  if (serviceError) {
    write(
      `已删除本地 iLink 登录态，但撤销后台服务失败：${describeError(serviceError)}\n`,
    );
    return 1;
  }
  write("已停止后台桥，已删除本地 iLink 登录态（宿主 MCP 配置未受影响）。\n");
  return 0;
}

async function defaultBackgroundInstaller(input: {
  readonly hostId: ChannelBridgeHost;
  readonly origin: string;
}): Promise<void> {
  const cliScript = process.argv[1];
  if (!cliScript) {
    throw new Error("Cannot resolve the Attention CLI entrypoint.");
  }
  await installChannelService(
    buildChannelServicePlan({
      cliScript: resolve(cliScript),
      ...(process.env.PATH ? { environmentPath: process.env.PATH } : {}),
      homeDirectory: homedir(),
      hostId: input.hostId,
      nodeExecutable: process.execPath,
      origin: input.origin,
      platform: process.platform,
      ...(process.getuid ? { uid: process.getuid() } : {}),
    }),
  );
}

async function defaultServiceUninstaller(): Promise<void> {
  await uninstallChannelService(
    buildChannelServiceRemovalPlan({
      homeDirectory: homedir(),
      platform: process.platform,
      ...(process.getuid ? { uid: process.getuid() } : {}),
    }),
  );
}

async function defaultServiceInspector(): Promise<boolean> {
  return await isChannelServiceConfigured({
    homeDirectory: homedir(),
    platform: process.platform,
    ...(process.getuid ? { uid: process.getuid() } : {}),
  });
}

export function isBridgeHost(hostId: string): hostId is ChannelBridgeHost {
  return (CHANNEL_BRIDGE_HOSTS as readonly string[]).includes(hostId);
}

async function checkHostCli(
  hostId: ChannelBridgeHost,
): Promise<{ ok: boolean }> {
  const executable = HOST_EXECUTABLES[hostId];
  const result = await runCommand(
    { args: ["--version"], executable },
    { timeoutMs: 10_000 },
  );
  if (result.exitCode === 0) return { ok: true };
  // Some hosts print version output on stderr or exit non-zero but present;
  // treat any captured output as "installed".
  return { ok: result.stdout.length > 0 || result.stderr.length > 0 };
}

async function doLogin(runtime: Runtime): Promise<boolean> {
  const { client, log, sleep, state } = runtime;
  let expiredCount = 0;
  for (;;) {
    let qr;
    try {
      qr = await client.requestQrCode();
    } catch (error) {
      log(`获取二维码失败: ${describeError(error)}`);
      await sleep(5_000);
      continue;
    }
    await displayQrCode(qr.qrPayload, { writeOutput: runtime.write });
    log("请使用手机微信扫码登录（二维码有效期约 5 分钟）…");

    for (;;) {
      let status;
      try {
        status = await client.pollQrStatus(qr.qrcodeId);
      } catch (error) {
        if (isTimeoutError(error)) continue;
        log(`轮询二维码状态失败: ${describeError(error)}`);
        await sleep(2_000);
        continue;
      }
      if (status.status === "confirmed") {
        client.token = status.botToken ?? null;
        client.accountId = status.ilinkBotId ?? "";
        if (status.baseUrl) {
          client.baseUrl = status.baseUrl.replace(/\/+$/u, "");
        }
        state.token = client.token;
        state.accountId = client.accountId;
        state.baseUrl = client.baseUrl;
        log(
          `登录成功（account=${maskAccountId(state.accountId)}, base=${client.baseUrl}）`,
        );
        return true;
      }
      if (status.status === "expired") {
        expiredCount += 1;
        log(`二维码过期（${expiredCount}/${ILINK_MAXIMUM_QR_REFRESH}），刷新中…`);
        if (expiredCount > ILINK_MAXIMUM_QR_REFRESH) {
          log("二维码连续过期，稍后重试。");
          return false;
        }
        break;
      }
      // wait / scanned: keep polling.
    }
  }
}

async function safeSend(
  runtime: Runtime,
  message: ChannelState["pendingOutbound"][number],
): Promise<boolean> {
  try {
    return await runtime.client.sendMessage({
      clientId: message.id,
      contextToken: message.contextToken,
      text: message.text,
      toUserId: message.toUserId,
    });
  } catch (error) {
    if (error instanceof ILinkSessionExpiredError) {
      runtime.state.token = null;
      runtime.client.token = null;
    }
    runtime.log(`发送异常: ${describeError(error)}`);
    return false;
  }
}

function maskAccountId(accountId: string): string {
  return accountId ? `${accountId.slice(0, 6)}…` : "(empty)";
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Defense in depth: never surface credential-shaped material from errors.
  return message.replaceAll(/Bearer\s+[A-Za-z0-9._~-]+/giu, "Bearer [redacted]");
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" ||
      /abort|timeout|ETIMEDOUT|ECONNABORTED/iu.test(error.message))
  );
}
