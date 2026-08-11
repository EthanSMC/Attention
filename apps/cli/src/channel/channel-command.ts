/**
 * `attention channel` subcommands: the one-command path from WeChat into the
 * user's own local Agent.
 *
 * - `start <codex|claude-code>`: preflight, QR login when needed, then the
 *   long-poll loop that feeds messages to the restricted brain and replies.
 * - `status`: local, observable facts only (never secrets).
 * - `logout`: delete local iLink state.
 *
 * The bridge never uploads iLink credentials. Its optional Runtime Reporter
 * publishes only privacy-safe health/checkpoint metadata.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { resolve } from "node:path";

import {
  ATTENTION_SKILL_PACKAGE_VERSION,
  ATTENTION_SKILL_TOOL_CONTRACT_VERSION,
  type ChannelBindingChallenge,
} from "@attention/contracts";

import { runCommand } from "../command-runner";
import { resolveAttentionPublicUrl } from "../origin";
import {
  loadRuntimeCredential,
  runtimeAccessToken,
} from "../runtime-oauth";
import { ATTENTION_CLI_VERSION } from "../version";
import { createBrainAdapter, type BrainAdapter } from "./brain";
import { prepareChannelCodexHome } from "./codex-home";
import { ILinkClient } from "./ilink-client";
import { ILinkSessionExpiredError, ILINK_BASE_URL } from "./ilink-protocol";
import { acquireChannelLock } from "./lock";
import {
  CODEX_RESTART_BACKOFF_MS,
  ILINK_LONG_POLL_TIMEOUT_MS,
  ILINK_MAXIMUM_QR_REFRESH,
  MAXIMUM_PENDING_MESSAGES,
  PROCESSING_ACK_REPLY,
} from "./limits";
import { handleInboundMessage, matchControlCommand } from "./pipeline";
import {
  extractText,
  type InboundMessage,
  shouldSendProcessingAcknowledgement,
} from "./messages";
import {
  completeInbound,
  enqueueInbound,
  enqueueOutbound,
  markOutboundSent,
  outboundIdentifier,
} from "./queue";
import { displayQrCode } from "./qr-display";
import {
  createRuntimeReporter,
  type RuntimeAccessTokenProvider,
  type RuntimeReporter,
  type RuntimeReporterOptions,
  type RuntimeReporterSnapshot,
} from "./runtime-reporter";
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
    options: {
      readonly codexHomeDirectory?: string;
      readonly mcpUrl: string;
    },
  ) => BrainAdapter;
  readonly codexHomePreparer?: (input: {
    readonly baseDirectory?: string;
  }) => Promise<string>;
  readonly fetchImpl?: typeof fetch;
  readonly hostCliCheck?: (hostId: ChannelBridgeHost) => Promise<boolean>;
  readonly origin?: string;
  readonly runtimeCredentialLoader?: () => Promise<
    boolean | { readonly clientId: string }
  >;
  readonly runtimeReporterFactory?: (
    options: RuntimeReporterOptions,
  ) => RuntimeReporter;
  readonly runtimeTokenProvider?: RuntimeAccessTokenProvider;
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

interface PairingContext {
  challenge: ChannelBindingChallenge | null;
  promptSent: boolean;
  verificationTarget: {
    readonly contextToken: string;
    readonly inboundId: string;
    readonly toUserId: string;
  } | null;
}

interface ReporterRuntime {
  readonly pairing: PairingContext;
  readonly reporter: RuntimeReporter;
  readonly runtimeClientFingerprint: string | null;
  terminal: boolean;
}

interface ReporterRetirement {
  readonly reporter: RuntimeReporter;
  statePersisted: boolean;
  stopped: boolean;
}

const HOST_EXECUTABLES: Record<ChannelBridgeHost, string> = {
  "claude-code": "claude",
  codex: "codex",
};
const RUNTIME_REPORTER_CREDENTIAL_RETRY_MS = 60_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 19);
}

function setRuntimeStarting(state: ChannelState): void {
  const now = new Date().toISOString();
  state.runtimeState = {
    ...state.runtimeState,
    lastErrorCode: null,
    lastTransitionAt: now,
    nextRetryAt: null,
    phase: "starting",
    retryAttempt: 0,
  };
}

function syncRuntimeCheckpoint(
  state: ChannelState,
  brain: BrainAdapter,
): boolean {
  const snapshot = brain.runtimeSnapshot();
  const changed =
    state.runtimeState.phase !== snapshot.phase ||
    state.runtimeState.lastErrorCode !== snapshot.lastErrorCode ||
    state.runtimeState.retryAttempt !== snapshot.retryAttempt;
  if (changed) {
    state.runtimeState.lastTransitionAt = new Date().toISOString();
  }
  state.runtimeState.phase = snapshot.phase;
  state.runtimeState.lastErrorCode = snapshot.lastErrorCode;
  state.runtimeState.retryAttempt = snapshot.retryAttempt;
  if (snapshot.phase === "healthy") {
    state.runtimeState.lastHealthyAt = new Date().toISOString();
  }
  return changed;
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

  let brain: BrainAdapter | null = null;
  let persistedState: ChannelState | null = null;
  const reporterSlot: { current: ReporterRuntime | null } = { current: null };
  let flushPendingPersistence = async (): Promise<void> => undefined;
  let settleReporterRetirement = async (): Promise<boolean> => true;
  try {
    const state = await loadChannelState(options.baseDirectory);
    persistedState = state;
    const cwd = channelStateDirectory(options.baseDirectory);
    await mkdir(cwd, { mode: 0o700, recursive: true });
    const mcpUrl = resolveAttentionPublicUrl(options.origin, "/mcp");
    const shouldPrepareCodexHome =
      hostId === "codex" &&
      (options.brainFactory === undefined ||
        options.codexHomePreparer !== undefined);
    const codexHomeDirectory = shouldPrepareCodexHome
      ? await (options.codexHomePreparer ?? prepareChannelCodexHome)({
          ...(options.baseDirectory
            ? { baseDirectory: options.baseDirectory }
            : {}),
        })
      : undefined;
    const activeBrain = (options.brainFactory ?? createBrainAdapter)(hostId, {
      ...(codexHomeDirectory ? { codexHomeDirectory } : {}),
      mcpUrl,
    });
    brain = activeBrain;
    setRuntimeStarting(state);
    await saveChannelState(state, options.baseDirectory);
    try {
      await activeBrain.start();
    } catch (error) {
      syncRuntimeCheckpoint(state, activeBrain);
      await saveChannelState(state, options.baseDirectory);
      write(`本地 Agent Runtime 启动失败：${describeError(error)}\n`);
      if (options.service) {
        write("后台服务已停止；修复本地 Agent 后，请重新启动 Channel。\n");
        return 0;
      }
      return 1;
    }
    syncRuntimeCheckpoint(state, activeBrain);
    await saveChannelState(state, options.baseDirectory);
    const account = await (options.accountVerifier ?? verifyAttentionAccount)(
      activeBrain,
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

    let persistTail: Promise<void> = Promise.resolve();
    const persist = (): Promise<void> => {
      const pending = persistTail.then(() =>
        saveChannelState(runtime.state, options.baseDirectory),
      );
      persistTail = pending.catch(() => undefined);
      return pending;
    };
    flushPendingPersistence = async () => await persistTail;

    let reporterCredentialWarningLogged = false;
    let reporterNextAttemptAt = 0;
    let reporterIdentityDirty = false;
    let reporterRetirement: ReporterRetirement | null = null;
    let reporterRetirementTask: Promise<boolean> | null = null;
    settleReporterRetirement = async (): Promise<boolean> => {
      if (!reporterRetirement) return true;
      if (!reporterRetirementTask) {
        const retirement = reporterRetirement;
        reporterRetirementTask = (async () => {
          if (!retirement.statePersisted) {
            try {
              await persist();
              retirement.statePersisted = true;
              reporterIdentityDirty = false;
            } catch {
              runtime.log(
                "Runtime 安装身份已轮换，但本地状态暂未写入；创建新 Reporter 前会继续重试。",
              );
              return false;
            }
          }
          if (!retirement.stopped) {
            try {
              await retirement.reporter.stop({ discardPending: true });
              retirement.stopped = true;
            } catch {
              runtime.log(
                "旧 Runtime Reporter 暂未完全停止；创建新 Reporter 前会继续重试。",
              );
              return false;
            }
          }
          return true;
        })();
      }
      const task = reporterRetirementTask;
      const settled = await task;
      if (reporterRetirementTask === task) {
        reporterRetirementTask = null;
      }
      if (
        settled &&
        reporterRetirement?.statePersisted &&
        reporterRetirement.stopped
      ) {
        reporterRetirement = null;
      }
      return settled;
    };
    const ensureReporter = async (): Promise<void> => {
      if (
        options.background ||
        !client.token ||
        Date.now() < reporterNextAttemptAt
      ) {
        return;
      }
      if (!(await settleReporterRetirement())) return;
      if (reporterIdentityDirty) {
        try {
          await persist();
          reporterIdentityDirty = false;
        } catch {
          runtime.log(
            "Runtime 安装身份尚未持久化；本轮不会创建新的 Reporter。",
          );
          return;
        }
      }
      let credentialAvailable: boolean;
      let runtimeClientFingerprint: string | null = null;
      try {
        if (options.runtimeCredentialLoader) {
          const loaded = await options.runtimeCredentialLoader();
          credentialAvailable = loaded !== false;
          if (typeof loaded === "object") {
            runtimeClientFingerprint = opaqueFingerprint(
              "runtime_oauth_client",
              loaded.clientId,
            );
          }
        } else {
          const loaded = await loadRuntimeCredential();
          credentialAvailable = loaded !== null;
          if (loaded) {
            runtimeClientFingerprint = opaqueFingerprint(
              "runtime_oauth_client",
              loaded.client_id,
            );
          }
        }
      } catch {
        reporterNextAttemptAt = Date.now() +
          RUNTIME_REPORTER_CREDENTIAL_RETRY_MS;
        if (!reporterCredentialWarningLogged) {
          runtime.log(
            "Runtime 状态上报凭据不可用；本地微信桥继续运行，但 Web 不会更新设备状态。",
          );
          reporterCredentialWarningLogged = true;
        }
        return;
      }
      if (!credentialAvailable) {
        reporterNextAttemptAt = Date.now() +
          RUNTIME_REPORTER_CREDENTIAL_RETRY_MS;
        if (!reporterCredentialWarningLogged) {
          runtime.log(
            "未配置独立 Runtime OAuth；本地微信桥继续运行，Web 设备状态暂不可见。",
          );
          reporterCredentialWarningLogged = true;
        }
        return;
      }
      reporterCredentialWarningLogged = false;
      reporterNextAttemptAt = 0;
      if (reporterSlot.current) {
        if (
          !runtimeClientFingerprint ||
          reporterSlot.current.runtimeClientFingerprint ===
            runtimeClientFingerprint
        ) {
          return;
        }
        const staleReporter = reporterSlot.current.reporter;
        reporterSlot.current = null;
        await staleReporter.stop({ discardPending: true });
      }
      let reporterIdentityChanged = false;
      const previousRuntimeClientFingerprint =
        runtime.state.runtimeReporter.runtimeClientFingerprint;
      if (
        runtimeClientFingerprint &&
        previousRuntimeClientFingerprint &&
        runtimeClientFingerprint !== previousRuntimeClientFingerprint
      ) {
        runtime.state.runtimeReporter.bindingId = null;
        runtime.state.runtimeReporter.installationId = null;
        reporterIdentityChanged = true;
      }
      if (
        runtimeClientFingerprint &&
        runtimeClientFingerprint !== previousRuntimeClientFingerprint
      ) {
        runtime.state.runtimeReporter.runtimeClientFingerprint =
          runtimeClientFingerprint;
        reporterIdentityChanged = true;
      }
      if (
        !runtime.state.runtimeReporter.installationId &&
        runtime.state.runtimeReporter.bindingId
      ) {
        runtime.state.runtimeReporter.bindingId = null;
      }
      if (!runtime.state.runtimeReporter.installationId) {
        runtime.state.runtimeReporter.installationId = randomUUID();
        reporterIdentityChanged = true;
      }
      if (reporterIdentityChanged) {
        await persist();
      }
      const installationId =
        runtime.state.runtimeReporter.installationId;
      const pairing: PairingContext = {
        challenge: null,
        promptSent: false,
        verificationTarget: null,
      };
      let reporterRuntime: ReporterRuntime | null = null;
      const isCurrentReporter = (): boolean =>
        reporterRuntime !== null &&
        !reporterRuntime.terminal &&
        reporterSlot.current === reporterRuntime;
      const reporter = (options.runtimeReporterFactory ?? createRuntimeReporter)(
        {
          accessTokenProvider:
            options.runtimeTokenProvider ?? defaultRuntimeTokenProvider,
          identity: {
            adapterVersion: ATTENTION_CLI_VERSION,
            agentIntegrationId: hostId,
            bindingId: runtime.state.runtimeReporter.bindingId,
            channelAccountFingerprint: opaqueFingerprint(
              "wechat_ilink",
              runtime.state.accountId,
            ),
            deviceName: hostname().slice(0, 100) || "Attention device",
            installationId,
            provider: "wechat_ilink",
            restrictedProfile: true,
            skillVersion: ATTENTION_SKILL_PACKAGE_VERSION,
            toolContractVersion: ATTENTION_SKILL_TOOL_CONTRACT_VERSION,
          },
          onBindingChallenge: (challenge) => {
            if (!isCurrentReporter()) return;
            pairing.challenge = challenge;
            pairing.promptSent = false;
            runtime.log(
              `收到设备绑定挑战。请在微信 ClawBot 对话中回复配对码 ${challenge.pairing_code}。`,
            );
          },
          onBindingInvalidated: () => {
            if (!isCurrentReporter()) return;
            runtime.state.runtimeReporter.bindingId = null;
            pairing.challenge = null;
            pairing.promptSent = false;
            void persist().catch(() => {
              runtime.log(
                "失效的设备绑定已从内存移除，但本地状态暂未写入；重启前请勿重复配对。",
              );
            });
          },
          onBindingVerified: (bindingId) => {
            if (!isCurrentReporter()) return;
            runtime.state.runtimeReporter.bindingId = bindingId;
            pairing.challenge = null;
            pairing.promptSent = false;
            const target = pairing.verificationTarget;
            pairing.verificationTarget = null;
            if (target) {
              enqueueOutbound(runtime.state, {
                contextToken: target.contextToken,
                id: outboundIdentifier({
                  inboundId: target.inboundId,
                  index: 1,
                  kind: "result",
                }),
                text: "Attention 设备绑定成功。",
                toUserId: target.toUserId,
              });
            }
            void persist()
              .then(() => flushPendingOutbound(runtime, persist))
              .catch(() => {
                runtime.log(
                  "设备绑定已完成，但本地成功回执暂未写入；Bridge 会在下次循环重试。",
                );
              });
          },
          onInstallationInvalidated: () => {
            if (!isCurrentReporter() || !reporterRuntime) return;
            const retiringRuntime = reporterRuntime;
            retiringRuntime.terminal = true;
            reporterSlot.current = null;
            pairing.challenge = null;
            pairing.promptSent = false;
            pairing.verificationTarget = null;
            runtime.state.runtimeReporter.bindingId = null;
            runtime.state.runtimeReporter.installationId = randomUUID();
            reporterIdentityDirty = true;
            reporterRetirement = {
              reporter: retiringRuntime.reporter,
              statePersisted: false,
              stopped: false,
            };
            reporterRetirementTask = null;
            void settleReporterRetirement();
          },
          onPairingVerificationFailed: () => {
            if (!isCurrentReporter()) return;
            const target = pairing.verificationTarget;
            pairing.verificationTarget = null;
            if (target) {
              enqueueOutbound(runtime.state, {
                contextToken: target.contextToken,
                id: outboundIdentifier({
                  inboundId: target.inboundId,
                  index: 1,
                  kind: "result",
                }),
                text: "设备绑定暂未完成，请稍后重新发送新的配对码。",
                toUserId: target.toUserId,
              });
            }
            void persist()
              .then(() => flushPendingOutbound(runtime, persist))
              .catch(() => {
                runtime.log(
                  "设备绑定失败回执暂未写入；Bridge 会在下次循环重试。",
                );
              });
          },
          onStatusChange: (status) => {
            if (reporterRuntime?.terminal) return;
            if (status === "degraded") {
              runtime.log(
                "Runtime 状态上报暂时中断；本地微信桥不受影响。",
              );
            }
          },
          runtimeBaseUrl: resolveAttentionPublicUrl(
            options.origin ?? "",
            "/api/runtime",
          ),
          snapshot: buildReporterSnapshot(runtime, activeBrain),
        },
      );
      reporterRuntime = {
        pairing,
        reporter,
        runtimeClientFingerprint,
        terminal: false,
      };
      reporterSlot.current = reporterRuntime;
      reporter.start();
    };

    runtime.log(
      `attention-channel 桥启动（host=${hostId}，状态目录 ${channelStateDirectory(
        options.baseDirectory,
      )}）`,
    );

    let shutdownStarted = false;
    const shutdown = () => {
      if (shutdownStarted) return;
      shutdownStarted = true;
      runtime.log("正在退出，保存本地状态…");
      void settleReporterRetirement()
        .then(() => reporterSlot.current?.reporter.stop() ?? Promise.resolve())
        .then(() => activeBrain.shutdown())
        .catch(() => undefined)
        .then(() => {
          syncRuntimeCheckpoint(runtime.state, activeBrain);
          return persist();
        })
        .then(() => lock.release())
        .finally(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    try {
      for (;;) {
        if (syncRuntimeCheckpoint(runtime.state, activeBrain)) {
          await persist();
        }

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

        await ensureReporter();
        reporterSlot.current?.reporter.transition(
          buildReporterSnapshot(runtime, activeBrain),
        );

        if (options.background) {
          const installer =
            options.backgroundInstaller ?? defaultBackgroundInstaller;
          await installer({ hostId, origin: options.origin });
          runtime.log(
            "后台桥已启用。可用 attention channel status 查看本地队列；用 attention channel logout 停止并删除登录态。",
          );
          return 0;
        }

        await flushPendingOutbound(runtime, persist);
        if (!client.token) continue;
        await processPendingInbound(
          runtime,
          activeBrain,
          cwd,
          persist,
          reporterSlot.current,
        );
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
            client.token = null;
            await persist();
            reporterSlot.current?.reporter.transition(
              buildReporterSnapshot(runtime, activeBrain),
            );
            if (options.service) {
              runtime.log(
                "后台服务不会弹出二维码；请在终端重新运行 channel start --background。",
              );
              return 0;
            }
            runtime.log("等待重新扫码…");
            continue;
          }
          if (isTimeoutError(error)) {
            if (syncRuntimeCheckpoint(runtime.state, activeBrain)) {
              await persist();
            }
            continue;
          }
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
        await processPendingInbound(
          runtime,
          activeBrain,
          cwd,
          persist,
          reporterSlot.current,
        );
        await flushPendingOutbound(runtime, persist);
      }
    } finally {
      process.removeListener("SIGINT", shutdown);
      process.removeListener("SIGTERM", shutdown);
    }
  } finally {
    await settleReporterRetirement();
    if (reporterSlot.current) {
      await reporterSlot.current.reporter.stop();
    }
    await flushPendingPersistence();
    if (brain) {
      try {
        await brain.shutdown();
      } catch {
        // The durable local checkpoint remains authoritative on shutdown.
      }
      if (persistedState) {
        syncRuntimeCheckpoint(persistedState, brain);
        await saveChannelState(persistedState, options.baseDirectory);
      }
    }
    await lock.release();
  }
}

async function processPendingInbound(
  runtime: Runtime,
  brain: BrainAdapter,
  cwd: string,
  persist: () => Promise<void>,
  reporterRuntime: ReporterRuntime | null = null,
): Promise<void> {
  const batch = runtime.state.pendingInbound.slice(0, MAXIMUM_PENDING_MESSAGES);
  let businessQueueBlocked = Boolean(
    batch[0] && inboundRetryIsCoolingDown(batch[0], runtime.state),
  );
  for (const pending of batch) {
    const pairingCode = reporterRuntime?.pairing.challenge?.pairing_code ?? null;
    const bypassingBlockedBusiness = businessQueueBlocked;
    if (
      businessQueueBlocked &&
      !isLocalControlMessage(pending.message, runtime.state, pairingCode)
    ) {
      // Business work remains strictly FIFO behind the failed head. Exact
      // local controls may bypass so status/recovery stays available.
      continue;
    }
    const message = pending.message;
    if (message.contextToken) {
      runtime.state.contextTokens[message.fromUserId] = message.contextToken;
    }
    const pairing = reporterRuntime?.pairing;
    if (
      pairing?.challenge &&
      Date.parse(pairing.challenge.expires_at) <= Date.now()
    ) {
      pairing.challenge = null;
      pairing.promptSent = false;
      pairing.verificationTarget = null;
      reporterRuntime?.reporter.renewPairing();
    }
    if (!pending.acknowledged) {
      if (shouldSendProcessingAcknowledgement(message)) {
        enqueueOutbound(runtime.state, {
          contextToken: message.contextToken,
          id: outboundIdentifier({ inboundId: pending.id, kind: "ack" }),
          text: PROCESSING_ACK_REPLY,
          toUserId: message.fromUserId,
        });
      }
      pending.acknowledged = true;
      await persist();
      if (runtime.state.pendingOutbound.length > 0) {
        await flushPendingOutbound(runtime, persist);
        if (!runtime.client.token) return;
      }
    }

    const outcome = await handleInboundMessage({
      brain,
      cwd,
      message,
      pairingCode,
      state: runtime.state,
    });
    if (
      pairing?.challenge &&
      !pairing.promptSent &&
      runtime.state.ownerUserId === message.fromUserId
    ) {
      const sent = await safeSend(runtime, {
        contextToken: message.contextToken,
        id: `pairing-challenge:${pairing.challenge.challenge_id}`,
        text:
          `Attention 设备绑定码：${pairing.challenge.pairing_code}\n` +
          "请原样回复这组验证码完成绑定。",
        toUserId: message.fromUserId,
      });
      if (sent) pairing.promptSent = true;
    }
    syncRuntimeCheckpoint(runtime.state, brain);
    let outcomeReplies = [...outcome.replies];
    if (outcome.controlCommand) {
      if (
        outcome.controlCommand === "pairing_verification" &&
        reporterRuntime?.pairing.challenge
      ) {
        const challenge = reporterRuntime.pairing.challenge;
        reporterRuntime.pairing.verificationTarget = {
          contextToken:
            runtime.state.contextTokens[message.fromUserId] ??
            message.contextToken,
          inboundId: pending.id,
          toUserId: message.fromUserId,
        };
        reporterRuntime.reporter.verifyPairing({
          bindingId: challenge.binding_id,
          challengeId: challenge.challenge_id,
          pairedPeerFingerprint: opaqueFingerprint(
            "wechat_ilink_peer",
            message.fromUserId,
          ),
          pairingCode: challenge.pairing_code,
        });
      }
      const controlFailure = await applyRuntimeControl(
        outcome.controlCommand,
        brain,
        runtime.state,
      );
      syncRuntimeCheckpoint(runtime.state, brain);
      if (controlFailure) outcomeReplies = [controlFailure];
    }
    if (!outcome.completed) {
      businessQueueBlocked = true;
      pending.attempts += 1;
      scheduleInboundRetry(runtime.state, pending.attempts);
      if (pending.attempts === 1) {
        outcomeReplies.forEach((reply, index) => {
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
      reporterRuntime?.reporter.transition(
        buildReporterSnapshot(runtime, brain),
      );
      await flushPendingOutbound(runtime, persist);
      continue;
    }

    if (!bypassingBlockedBusiness) {
      runtime.state.runtimeState.nextRetryAt = null;
      runtime.state.runtimeState.retryAttempt = 0;
    }
    outcomeReplies.forEach((reply, index) => {
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
    if (runtime.state.runtimeReporter.bindingId) {
      reporterRuntime?.reporter.activity();
    }
    reporterRuntime?.reporter.transition(
      buildReporterSnapshot(runtime, brain),
    );
    await flushPendingOutbound(runtime, persist);
    if (!runtime.client.token) return;
  }
}

function inboundRetryIsCoolingDown(
  pending: ChannelState["pendingInbound"][number],
  state: ChannelState,
): boolean {
  return (
    pending.attempts > 0 &&
    state.runtimeState.nextRetryAt !== null &&
    Date.parse(state.runtimeState.nextRetryAt) > Date.now()
  );
}

function isLocalControlMessage(
  message: InboundMessage,
  state: ChannelState,
  pairingCode: string | null,
): boolean {
  const text = extractText(message.itemList).text.trim();
  if (!text) return false;
  if (pairingCode && text === pairingCode) return true;
  return (
    matchControlCommand(text, {
      degraded:
        state.runtimeState.phase !== "healthy" ||
        state.runtimeState.activeTurnMessageRef !== null,
    }) !== null
  );
}

async function applyRuntimeControl(
  command: NonNullable<
    Awaited<ReturnType<typeof handleInboundMessage>>["controlCommand"]
  >,
  brain: BrainAdapter,
  state: ChannelState,
): Promise<string | null> {
  if (command !== "retry" && command !== "continue" && command !== "reset") {
    return null;
  }
  try {
    if (command === "retry" || command === "reset") {
      await brain.shutdown();
      state.runtimeState.phase = "restarting";
      state.runtimeState.lastTransitionAt = new Date().toISOString();
    }
    await brain.start();
    state.runtimeState.nextRetryAt = null;
    state.runtimeState.retryAttempt = 0;
    return null;
  } catch {
    state.runtimeState.phase = "degraded_runtime";
    state.runtimeState.lastErrorCode = "brain_restart_failed";
    state.runtimeState.lastTransitionAt = new Date().toISOString();
    return "本地 Agent 仍未恢复。请稍后发送“重试”，或在电脑上查看 attention channel status。";
  }
}

function scheduleInboundRetry(state: ChannelState, attempts: number): void {
  const delay =
    CODEX_RESTART_BACKOFF_MS[
      Math.min(attempts - 1, CODEX_RESTART_BACKOFF_MS.length - 1)
    ] ?? CODEX_RESTART_BACKOFF_MS.at(-1) ?? 15_000;
  state.runtimeState.retryAttempt = Math.max(
    state.runtimeState.retryAttempt,
    attempts,
  );
  state.runtimeState.nextRetryAt = new Date(Date.now() + delay).toISOString();
  if (state.runtimeState.phase === "healthy") {
    state.runtimeState.phase = "degraded_runtime";
    state.runtimeState.lastErrorCode = "brain_turn_failed";
    state.runtimeState.lastTransitionAt = new Date().toISOString();
  }
}

const defaultRuntimeTokenProvider: RuntimeAccessTokenProvider = {
  async accessToken(request): Promise<string | null> {
    try {
      return await runtimeAccessToken({ forceRefresh: request.forceRefresh });
    } catch {
      return null;
    }
  },
};

function opaqueFingerprint(namespace: string, value: string): string {
  return createHash("sha256")
    .update(`attention:${namespace}:`, "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function buildReporterSnapshot(
  runtime: Runtime,
  brain: BrainAdapter,
): RuntimeReporterSnapshot {
  syncRuntimeCheckpoint(runtime.state, brain);
  return {
    bridgeStatus:
      runtime.state.runtimeState.phase === "healthy"
        ? "online"
        : "degraded",
    checkpoint: runtime.state.runtimeState,
    ilinkStatus: runtime.client.token ? "connected" : "signed_out",
    pendingInbound: runtime.state.pendingInbound.length,
    pendingOutbound: runtime.state.pendingOutbound.length,
  };
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
  const verificationPrompt = [
    "这是 Attention 微信桥接启动前的账号验收。",
    "必须现在真实调用 attention_get_my_account；不要依据配置、历史或猜测回答。",
    "工具成功后，只输出一行：",
    'ATTENTION_ACCOUNT_OK {"display_name":"<返回值>","attention_id":"<返回值或null>","is_filter":<true|false>,"is_member":<true|false>}',
    "工具失败、未授权或不可用时，不要输出 ATTENTION_ACCOUNT_OK。",
  ].join("\n");
  const outcome = await brain.invoke({
    cwd,
    prompt: verificationPrompt,
    // Account verification is a disposable preflight. It must never attach to
    // or create the designated Channel conversation.
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
    runtime: {
      lastErrorCode: state.runtimeState.lastErrorCode,
      lastHealthyAt: state.runtimeState.lastHealthyAt,
      lastSuccessfulMessageAt: state.runtimeState.lastSuccessfulMessageAt,
      lastTransitionAt: state.runtimeState.lastTransitionAt,
      nextRetryAt: state.runtimeState.nextRetryAt,
      phase: state.runtimeState.phase,
      retryAttempt: state.runtimeState.retryAttempt,
    },
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
        ? `${report.brainSession.hostId}（最近更新 ${report.brainSession.updatedAt}）`
        : "无"
    }\n`,
  );
  write(`Runtime: ${report.runtime.phase}\n`);
  write(`最近健康: ${report.runtime.lastHealthyAt ?? "无"}\n`);
  write(`最近成功处理: ${report.runtime.lastSuccessfulMessageAt ?? "无"}\n`);
  if (report.runtime.lastErrorCode) {
    write(`最近错误: ${report.runtime.lastErrorCode}\n`);
  }
  if (report.runtime.nextRetryAt) {
    write(`下次重试: ${report.runtime.nextRetryAt}\n`);
  }
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
