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
import { createInterface } from "node:readline/promises";

import {
  ATTENTION_SKILL_PACKAGE_VERSION,
  ATTENTION_SKILL_TOOL_CONTRACT_VERSION,
  type ChannelBindingChallenge,
} from "@attention/contracts";

import { runCommand } from "../command-runner";
import { ATTENTION_BRIDGE_PERMISSION_PROFILE_SHA256 } from "../bridge-update-contract";
import { resolveAttentionPublicUrl } from "../origin";
import {
  loadRuntimeCredential,
  runtimeAccessToken,
} from "../runtime-oauth";
import { ATTENTION_CLI_VERSION } from "../version";
import { createBrainAdapter, type BrainAdapter } from "./brain";
import {
  type BridgeUpdateCheckResult,
  checkAndStageBridgeUpdate,
} from "./bridge-updater";
import { prepareChannelCodexHome } from "./codex-home";
import {
  ILinkClient,
  ILinkQrProtocolError,
  ILinkUnknownQrStatusError,
} from "./ilink-client";
import { ILinkSessionExpiredError, ILINK_BASE_URL } from "./ilink-protocol";
import { acquireChannelLock } from "./lock";
import {
  enqueueSummaryNotifications,
  pollSummaryNotifications,
  type SummaryNotificationPollOptions,
} from "./notifications";
import {
  BRIDGE_UPDATE_RESTART_EXIT_CODE,
  loadManagedBridgeUpdateState,
  markManagedBridgeHealthy,
  type ManagedBridgeUpdateState,
} from "./managed-bridge";
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
  channelSessionFingerprint,
  opaqueRuntimeFingerprint,
} from "./runtime-identity";
import {
  buildChannelServiceRemovalPlan,
  installManagedChannelService,
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
const ACCOUNT_VERIFICATION_CACHE_MS = 24 * 60 * 60 * 1_000;
const SUMMARY_NOTIFICATION_POLL_INTERVAL_MS = 30_000;

export function runtimeReporterDegradedMessage(
  lastErrorCode: string | null,
): string {
  switch (lastErrorCode) {
    case "runtime_channel_session_superseded":
      return "当前微信登录会话已被新的扫码登录替换；请在本机重新扫码后再启动 Bridge。";
    case "runtime_channel_session_proof_required":
      return "当前客户端无法证明微信登录会话；请更新 Attention CLI 后重新启动 Bridge。";
    default:
      return "Runtime 状态上报暂时中断；本地微信桥不受影响。";
  }
}

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
      readonly runtimeDirectory?: string;
    },
  ) => BrainAdapter;
  readonly bridgeHealthyMarker?: () => Promise<void>;
  readonly bridgeUpdateChecker?: () => Promise<BridgeUpdateCheckResult>;
  readonly bridgeUpdateClock?: () => Date;
  readonly bridgeUpdateStateLoader?: () => Promise<ManagedBridgeUpdateState>;
  readonly codexHomePreparer?: (input: {
    readonly baseDirectory?: string;
  }) => Promise<string>;
  readonly fetchImpl?: typeof fetch;
  readonly hostCliCheck?: (hostId: ChannelBridgeHost) => Promise<boolean>;
  readonly origin?: string;
  readonly readInput?: () => Promise<string>;
  readonly runtimeCredentialLoader?: () => Promise<
    boolean | { readonly clientId: string }
  >;
  readonly runtimeReporterFactory?: (
    options: RuntimeReporterOptions,
  ) => RuntimeReporter;
  readonly runtimeTokenProvider?: RuntimeAccessTokenProvider;
  readonly summaryNotificationPoller?: typeof pollSummaryNotifications;
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
  readonly readInput: () => Promise<string>;
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
const BRIDGE_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const BRIDGE_UPDATE_MAXIMUM_JITTER_MS = 60 * 60 * 1_000;

function deterministicBridgeUpdateJitter(seed: string): number {
  const prefix = createHash("sha256").update(seed, "utf8").digest().readUInt32BE(0);
  return prefix % BRIDGE_UPDATE_MAXIMUM_JITTER_MS;
}

export interface RuntimeRegistrationIdentity {
  readonly deviceName: string;
  readonly installationId: string;
}

export function runtimeRegistrationDeviceName(
  source = hostname(),
): string {
  const normalized = source
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim()
    .replace(/\s+/gu, " ")
    .slice(0, 80);
  return normalized || "Attention device";
}

export async function loadRuntimeRegistrationIdentity(
  baseDirectory?: string,
): Promise<RuntimeRegistrationIdentity> {
  const state = await loadChannelState(baseDirectory);
  const installationId = state.runtimeReporter.installationId ?? randomUUID();
  if (state.runtimeReporter.installationId !== installationId) {
    state.runtimeReporter.installationId = installationId;
    await saveChannelState(state, baseDirectory);
  }
  return {
    deviceName: runtimeRegistrationDeviceName(),
    installationId,
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readTerminalLine(): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await terminal.question("");
  } finally {
    terminal.close();
  }
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

  if (options.background) {
    const state = await loadChannelState(options.baseDirectory);
    const stateDirectory = channelStateDirectory(options.baseDirectory);
    await mkdir(stateDirectory, { mode: 0o700, recursive: true });
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
      readInput: options.readInput ?? readTerminalLine,
      sleep,
      state,
      write,
    };
    if (!client.token) {
      const loggedIn = await doLogin(runtime);
      if (!loggedIn) return 1;
      await saveChannelState(state, options.baseDirectory);
    }
    const installer =
      options.backgroundInstaller ?? defaultBackgroundInstaller;
    await installer({ hostId, origin: options.origin });
    write(
      "后台桥已启用。后台服务会完成 Attention 账号验收并开始接收消息；" +
        "可用 attention channel status 查看本地队列。\n",
    );
    return 0;
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
      runtimeDirectory: cwd,
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
    const accountVerifiedAt = state.accountVerification
      ? Date.parse(state.accountVerification.verifiedAt)
      : Number.NaN;
    const now = Date.now();
    const cachedAccountVerification =
      options.service === true &&
      state.accountVerification?.hostId === hostId &&
      state.accountVerification.mcpUrl === mcpUrl &&
      accountVerifiedAt <= now + 60_000 &&
      accountVerifiedAt >= now - ACCOUNT_VERIFICATION_CACHE_MS;
    const account = cachedAccountVerification
      ? null
      : await (options.accountVerifier ?? verifyAttentionAccount)(
          activeBrain,
          cwd,
        );
    if (!cachedAccountVerification && !account) {
      state.accountVerification = null;
      await saveChannelState(state, options.baseDirectory);
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
    if (account) {
      state.accountVerification = {
        hostId,
        mcpUrl,
        verifiedAt: new Date().toISOString(),
      };
      await saveChannelState(state, options.baseDirectory);
      write(
        `Attention 已连接：${account.displayName}` +
          `${account.attentionId ? ` (@${account.attentionId})` : ""}` +
          `，Filter=${account.isFilter ? "是" : "否"}，Member=${account.isMember ? "是" : "否"}。\n`,
      );
    } else {
      write("Attention 账号最近已验收；后台服务直接恢复微信桥。\n");
    }

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
      readInput: options.readInput ?? readTerminalLine,
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
            runtimeClientFingerprint = opaqueRuntimeFingerprint(
              "runtime_oauth_client",
              loaded.clientId,
            );
          }
        } else {
          const loaded = await loadRuntimeCredential();
          credentialAvailable = loaded !== null;
          if (loaded) {
            runtimeClientFingerprint = opaqueRuntimeFingerprint(
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
      // DCR issues a new client_id on normal reauthorization. Its fingerprint
      // can restart the Reporter onto fresh credentials, but it is not a
      // reliable account-switch signal and must not rotate device identity.
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
            channelAccountFingerprint: opaqueRuntimeFingerprint(
              "wechat_ilink",
              runtime.state.accountId,
            ),
            channelSessionFingerprint: channelSessionFingerprint(client.token),
            deviceName: runtimeRegistrationDeviceName(),
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
              runtime.log(runtimeReporterDegradedMessage(
                reporterRuntime?.reporter.snapshot().lastErrorCode ?? null,
              ));
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

    const managedBridgeHome = options.baseDirectory ?? homedir();
    const bridgeUpdateClock = options.bridgeUpdateClock ?? (() => new Date());
    const bridgeUpdateJitterMs = deterministicBridgeUpdateJitter(
      runtime.state.runtimeReporter.installationId ?? hostname(),
    );
    let nextBridgeUpdateCheckAt = 0;
    if (options.service) {
      await (
        options.bridgeHealthyMarker ??
        (async () =>
          await markManagedBridgeHealthy(
            ATTENTION_CLI_VERSION,
            managedBridgeHome,
          ))
      )();
      if (!options.bridgeUpdateChecker) {
        try {
          const updateState = await loadManagedBridgeUpdateState(managedBridgeHome);
          const lastCheckAt = updateState.lastCheckAt
            ? Date.parse(updateState.lastCheckAt)
            : Number.NaN;
          nextBridgeUpdateCheckAt = Number.isFinite(lastCheckAt)
            ? lastCheckAt + BRIDGE_UPDATE_INTERVAL_MS + bridgeUpdateJitterMs
            : 0;
        } catch {
          // A service installed before managed updates has no update state.
          // It keeps running and can be upgraded once through the normal setup.
          nextBridgeUpdateCheckAt = Number.POSITIVE_INFINITY;
        }
      }
    }

    const maybeStageBridgeUpdate = async (): Promise<boolean> => {
      if (
        !options.service ||
        runtime.state.pendingInbound.length > 0 ||
        runtime.state.pendingOutbound.length > 0 ||
        bridgeUpdateClock().getTime() < nextBridgeUpdateCheckAt
      ) {
        return false;
      }
      const checkedAt = bridgeUpdateClock().getTime();
      let result: BridgeUpdateCheckResult;
      try {
        result = await (
          options.bridgeUpdateChecker ??
          (async () =>
            await checkAndStageBridgeUpdate({
              currentPermissionProfileSha256:
                ATTENTION_BRIDGE_PERMISSION_PROFILE_SHA256,
              currentVersion: ATTENTION_CLI_VERSION,
              homeDirectory: managedBridgeHome,
              nodeExecutable: process.execPath,
              origin: options.origin as string,
            }))
        )();
      } catch {
        runtime.log("Bridge 自动更新检查暂时不可用；当前版本继续运行。");
        nextBridgeUpdateCheckAt =
          checkedAt + BRIDGE_UPDATE_INTERVAL_MS + bridgeUpdateJitterMs;
        return false;
      }
      nextBridgeUpdateCheckAt =
        checkedAt + BRIDGE_UPDATE_INTERVAL_MS + bridgeUpdateJitterMs;
      if (result.status === "staged") {
        runtime.log(`Bridge ${result.version} 已校验，将在空闲状态重启。`);
        return true;
      }
      if (result.status === "consent_required") {
        runtime.log(
          `Bridge ${result.version} 需要新增权限或跨主版本；请手动确认升级。`,
        );
      } else if (result.status === "error") {
        runtime.log(
          `Bridge 自动更新失败（${result.errorCode}）；当前版本继续运行。`,
        );
      }
      return false;
    };

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
      let nextSummaryNotificationPollAt = 0;
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

        if (
          reporterSlot.current &&
          Date.now() >= nextSummaryNotificationPollAt
        ) {
          await pollAndQueueSummaryNotifications(runtime, options, persist);
          nextSummaryNotificationPollAt =
            Date.now() + SUMMARY_NOTIFICATION_POLL_INTERVAL_MS;
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
        if (await maybeStageBridgeUpdate()) {
          return BRIDGE_UPDATE_RESTART_EXIT_CODE;
        }

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
          pairedPeerFingerprint: opaqueRuntimeFingerprint(
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

async function pollAndQueueSummaryNotifications(
  runtime: Runtime,
  options: ChannelCommandOptions,
  persist: () => Promise<void>,
): Promise<void> {
  const bindingId = runtime.state.runtimeReporter.bindingId;
  const installationId = runtime.state.runtimeReporter.installationId;
  if (!bindingId || !installationId) return;

  const pollOptions: SummaryNotificationPollOptions = {
    accessTokenProvider:
      options.runtimeTokenProvider ?? defaultRuntimeTokenProvider,
    bindingId,
    cursor: runtime.state.summaryNotificationCursor,
    installationId,
    runtimeBaseUrl: resolveAttentionPublicUrl(
      options.origin ?? "",
      "/api/runtime",
    ),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  };
  const response = await (
    options.summaryNotificationPoller ?? pollSummaryNotifications
  )(pollOptions);
  if (!response) return;
  if (enqueueSummaryNotifications(runtime.state, response)) {
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
  let managedUpdate: ManagedBridgeUpdateState | null = null;
  try {
    managedUpdate = await (
      options.bridgeUpdateStateLoader ??
      (async () =>
        await loadManagedBridgeUpdateState(options.baseDirectory ?? homedir()))
    )();
  } catch {
    // Pre-managed installations remain valid; status must be local and robust.
  }
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
    update: managedUpdate
      ? {
          installedVersion: managedUpdate.current.version,
          lastCheckAt: managedUpdate.lastCheckAt,
          lastErrorCode: managedUpdate.lastErrorCode,
          latestVersion: managedUpdate.latestVersion,
          status: managedUpdate.status,
        }
      : {
          installedVersion: ATTENTION_CLI_VERSION,
          lastCheckAt: null,
          lastErrorCode: null,
          latestVersion: null,
          status: "unmanaged",
        },
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
  write(
    `Bridge 更新: ${report.update.installedVersion}` +
      `${report.update.latestVersion ? ` → ${report.update.latestVersion}` : ""}` +
      `（${report.update.status}）\n`,
  );
  if (report.update.lastCheckAt) {
    write(`最近更新检查: ${report.update.lastCheckAt}\n`);
  }
  if (report.update.lastErrorCode) {
    write(`最近更新错误: ${report.update.lastErrorCode}\n`);
  }
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
  await installManagedChannelService({
      currentCliScript: resolve(cliScript),
      ...(process.env.PATH ? { environmentPath: process.env.PATH } : {}),
      homeDirectory: homedir(),
      hostId: input.hostId,
      nodeExecutable: process.execPath,
      origin: input.origin,
      permissionProfileSha256: ATTENTION_BRIDGE_PERMISSION_PROFILE_SHA256,
      platform: process.platform,
      ...(process.getuid ? { uid: process.getuid() } : {}),
      version: ATTENTION_CLI_VERSION,
    });
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
  const { client, log, readInput, sleep, state } = runtime;
  client.baseUrl = ILINK_BASE_URL;
  state.baseUrl = ILINK_BASE_URL;
  let refreshCount = 0;
  let observedUserProgress = false;
  for (;;) {
    let qr;
    try {
      qr = await client.requestQrCode();
    } catch (error) {
      log(`获取二维码失败: ${describeError(error)}`);
      await sleep(5_000);
      continue;
    }
    log(
      "iLink 二维码已生成，请立即展开当前终端输出扫码；不要等待配置命令结束。",
    );
    await displayQrCode(qr.qrPayload, { writeOutput: runtime.write });
    log("请使用手机微信扫码登录（二维码有效期约 5 分钟）…");

    let pendingVerifyCode: string | undefined;
    let scannedReported = false;
    for (;;) {
      let status;
      try {
        status = await client.pollQrStatus(qr.qrcodeId, {
          ...(pendingVerifyCode ? { verifyCode: pendingVerifyCode } : {}),
        });
      } catch (error) {
        if (isTimeoutError(error)) continue;
        if (error instanceof ILinkUnknownQrStatusError) {
          log(
            `iLink 协议状态暂不受支持（${error.status}）；请升级 Attention CLI 后重试。`,
          );
          return false;
        }
        if (error instanceof ILinkQrProtocolError) {
          log(`iLink 登录响应不完整或不安全: ${describeError(error)}`);
          return false;
        }
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
      if (status.status === "scanned") {
        observedUserProgress = true;
        pendingVerifyCode = undefined;
        if (!scannedReported) {
          log("微信已扫码，等待手机确认…");
          scannedReported = true;
        }
        continue;
      }
      if (status.status === "need_verifycode") {
        observedUserProgress = true;
        let prompt = pendingVerifyCode
          ? "手机数字不匹配，请重新输入手机微信显示的数字："
          : "输入手机微信显示的数字，以继续连接：";
        for (;;) {
          runtime.write(prompt);
          let code: string;
          try {
            code = (await readInput()).trim();
          } catch (error) {
            log(`无法读取手机验证码: ${describeError(error)}`);
            log("请在可交互终端重新运行 channel start --background。");
            return false;
          }
          if (/^\d+$/u.test(code)) {
            pendingVerifyCode = code;
            break;
          }
          log("手机验证码只能包含数字，请重新输入。");
          prompt = "请重新输入手机微信显示的数字：";
        }
        continue;
      }
      if (status.status === "scaned_but_redirect") {
        observedUserProgress = true;
        client.baseUrl = status.baseUrl;
        state.baseUrl = status.baseUrl;
        log(`iLink 已切换到官方微信验证节点 ${status.baseUrl}。`);
        continue;
      }
      if (status.status === "binded_redirect") {
        log(
          "微信报告该 Bot 已绑定，但 Attention 本地没有可复用的 iLink 凭据。本地 logout 无法解除微信/iLink 服务端绑定；请恢复原凭据，或等待上游提供解绑/重绑能力。",
        );
        return false;
      }
      if (status.status === "verify_code_blocked") {
        observedUserProgress = true;
        if (refreshCount >= ILINK_MAXIMUM_QR_REFRESH) {
          log("手机验证码多次错误或已被阻断，连接流程已停止；请稍后重试。");
          return false;
        }
        refreshCount += 1;
        log(
          `手机验证码多次错误或已被阻断，刷新二维码（${refreshCount}/${ILINK_MAXIMUM_QR_REFRESH}）…`,
        );
        break;
      }
      if (status.status === "expired") {
        if (refreshCount >= ILINK_MAXIMUM_QR_REFRESH) {
          if (observedUserProgress) {
            log("二维码已扫码但手机授权未完成；请确认验证码或授权页面后重试。");
          } else {
            log(
              "二维码未被 iLink 确认扫码。若手机立即显示网络错误，这属于微信/iLink 上游授权异常；Attention 不会伪装成协议成功，请稍后重试并确认微信版本与账号资格。",
            );
          }
          return false;
        }
        refreshCount += 1;
        log(
          `二维码过期（刷新 ${refreshCount}/${ILINK_MAXIMUM_QR_REFRESH}），刷新中…`,
        );
        break;
      }
      // wait: keep polling.
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
