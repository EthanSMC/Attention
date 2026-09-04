/**
 * Local persistence for the attention-channel bridge.
 *
 * Everything in this file stays on the user's device: the iLink bot token,
 * sync cursor, context tokens, and host session reference never leave the
 * machine. The state directory is 0700 and the state file is 0600, written
 * atomically (temp file + rename) so an interrupted bridge cannot corrupt
 * the login session.
 */

import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { ChannelSummaryNotificationCursorSchema } from "@attention/contracts";

import { ILINK_BASE_URL, validateIlinkBaseUrl } from "./ilink-protocol";
import { BRAIN_HISTORY_TURNS, PROCESSED_MESSAGE_RING_SIZE } from "./limits";
import {
  defaultAttentionMcpCheckpoint,
  type AttentionMcpCheckpoint,
  type AttentionMcpErrorCode,
  type AttentionMcpStatus,
} from "./mcp-readiness";
import type { InboundMessage } from "./messages";

export interface HistoryEntry {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface BrainSession {
  readonly bridgeVersion?: string;
  readonly hostId: "codex" | "claude-code";
  readonly permissionProfileSha256?: string;
  readonly sessionId: string;
  readonly updatedAt: string;
}

export interface AccountVerificationCheckpoint {
  readonly hostId: "codex" | "claude-code";
  readonly mcpUrl: string;
  readonly verifiedAt: string;
}

/** Stable phases persisted independently of the resident brain implementation. */
export type RuntimePhase =
  | "starting"
  | "healthy"
  | "restarting"
  | "recovering_thread"
  | "replaying_history"
  | "degraded_auth"
  | "degraded_runtime"
  | "stopped";

export interface RuntimeCheckpoint {
  activeTurnMessageRef: string | null;
  lastErrorCode: string | null;
  lastHealthyAt: string | null;
  lastSuccessfulMessageAt: string | null;
  lastTransitionAt: string | null;
  nextRetryAt: string | null;
  phase: RuntimePhase;
  retryAttempt: number;
}

/** Opaque control-plane identifiers; contains no provider or OAuth secret. */
export interface RuntimeReporterLocalState {
  bindingId: string | null;
  installationId: string | null;
  runtimeClientFingerprint: string | null;
}

export interface PendingInboundMessage {
  acknowledged: boolean;
  attempts: number;
  blockedBy: "attention_mcp" | "runtime" | null;
  readonly id: string;
  readonly message: InboundMessage;
}

export interface PendingOutboundMessage {
  readonly contextToken: string;
  readonly id: string;
  readonly text: string;
  readonly toUserId: string;
}

export interface SummaryRetryJob {
  automaticAttempts: 0 | 1 | 2 | 3;
  readonly collectionId: string;
  readonly cycleStartedAt: string;
  lastFailureClass: "enrichment_incomplete" | null;
  nextAttemptAt: string | null;
  status: "scheduled" | "running" | "paused";
}

export interface ChannelState {
  accountVerification: AccountVerificationCheckpoint | null;
  attentionMcp: AttentionMcpCheckpoint;
  token: string | null;
  accountId: string;
  baseUrl: string;
  syncBuf: string;
  contextTokens: Record<string, string>;
  processedMessageIds: string[];
  ownerUserId: string | null;
  brainSession: BrainSession | null;
  history: HistoryEntry[];
  lastActivityAt: string | null;
  pendingInbound: PendingInboundMessage[];
  pendingOutbound: PendingOutboundMessage[];
  summaryRetries: SummaryRetryJob[];
  summaryNotificationCursor: string | null;
  runtimeReporter: RuntimeReporterLocalState;
  runtimeState: RuntimeCheckpoint;
}

export function defaultRuntimeCheckpoint(): RuntimeCheckpoint {
  return {
    activeTurnMessageRef: null,
    lastErrorCode: null,
    lastHealthyAt: null,
    lastSuccessfulMessageAt: null,
    lastTransitionAt: null,
    nextRetryAt: null,
    phase: "stopped",
    retryAttempt: 0,
  };
}

export function defaultChannelState(): ChannelState {
  return {
    accountVerification: null,
    accountId: "",
    attentionMcp: defaultAttentionMcpCheckpoint(),
    baseUrl: ILINK_BASE_URL,
    brainSession: null,
    contextTokens: {},
    history: [],
    lastActivityAt: null,
    ownerUserId: null,
    pendingInbound: [],
    pendingOutbound: [],
    processedMessageIds: [],
    summaryRetries: [],
    summaryNotificationCursor: null,
    runtimeReporter: {
      bindingId: null,
      installationId: null,
      runtimeClientFingerprint: null,
    },
    runtimeState: defaultRuntimeCheckpoint(),
    syncBuf: "",
    token: null,
  };
}

export function channelStateDirectory(baseDirectory?: string): string {
  return join(baseDirectory ?? homedir(), ".attention", "channel");
}

export function channelStatePath(baseDirectory?: string): string {
  return join(channelStateDirectory(baseDirectory), "state.json");
}

function normalizeState(raw: unknown): ChannelState {
  const base = defaultChannelState();
  if (raw === null || typeof raw !== "object") return base;
  const record = raw as Record<string, unknown>;
  return {
    accountVerification: normalizeAccountVerification(
      record.accountVerification,
    ),
    accountId: typeof record.accountId === "string" ? record.accountId : "",
    attentionMcp: normalizeAttentionMcpCheckpoint(record.attentionMcp),
    baseUrl: normalizeBaseUrl(record.baseUrl),
    brainSession: normalizeBrainSession(record.brainSession),
    contextTokens:
      record.contextTokens !== null && typeof record.contextTokens === "object"
        ? Object.fromEntries(
            Object.entries(record.contextTokens as Record<string, unknown>)
              .filter(([, value]) => typeof value === "string")
              .map(([key, value]) => [key, value as string]),
          )
        : {},
    history: Array.isArray(record.history)
      ? (record.history as unknown[])
          .filter(
            (entry): entry is HistoryEntry =>
              entry !== null &&
              typeof entry === "object" &&
              ((entry as HistoryEntry).role === "user" ||
                (entry as HistoryEntry).role === "assistant") &&
              typeof (entry as HistoryEntry).content === "string",
          )
          .slice(-BRAIN_HISTORY_TURNS * 2)
      : [],
    lastActivityAt:
      typeof record.lastActivityAt === "string" ? record.lastActivityAt : null,
    ownerUserId:
      typeof record.ownerUserId === "string" ? record.ownerUserId : null,
    processedMessageIds: Array.isArray(record.processedMessageIds)
      ? (record.processedMessageIds as unknown[])
          .filter((id): id is string => typeof id === "string")
          .slice(-PROCESSED_MESSAGE_RING_SIZE)
      : [],
    pendingInbound: Array.isArray(record.pendingInbound)
      ? (record.pendingInbound as unknown[]).flatMap((item) => {
          if (item === null || typeof item !== "object") return [];
          const candidate = item as Partial<PendingInboundMessage>;
          if (
            typeof candidate.id !== "string" ||
            candidate.message === null ||
            typeof candidate.message !== "object" ||
            typeof candidate.message.fromUserId !== "string" ||
            typeof candidate.message.contextToken !== "string" ||
            candidate.message.raw === null ||
            typeof candidate.message.raw !== "object"
          ) {
            return [];
          }
          return [
            {
              acknowledged: candidate.acknowledged === true,
              attempts:
                typeof candidate.attempts === "number" &&
                Number.isSafeInteger(candidate.attempts) &&
                candidate.attempts >= 0
                  ? candidate.attempts
                  : 0,
              blockedBy:
                candidate.blockedBy === "attention_mcp" ||
                candidate.blockedBy === "runtime"
                  ? candidate.blockedBy
                  : null,
              id: candidate.id,
              message: candidate.message,
            },
          ];
        })
      : [],
    pendingOutbound: Array.isArray(record.pendingOutbound)
      ? (record.pendingOutbound as unknown[]).filter(
          (item): item is PendingOutboundMessage =>
            item !== null &&
            typeof item === "object" &&
            typeof (item as PendingOutboundMessage).id === "string" &&
            typeof (item as PendingOutboundMessage).contextToken === "string" &&
            typeof (item as PendingOutboundMessage).text === "string" &&
            typeof (item as PendingOutboundMessage).toUserId === "string",
        )
      : [],
    summaryRetries: normalizeSummaryRetries(record.summaryRetries),
    summaryNotificationCursor:
      ChannelSummaryNotificationCursorSchema.safeParse(
        record.summaryNotificationCursor,
      ).data ?? null,
    runtimeReporter: normalizeRuntimeReporterState(record.runtimeReporter),
    runtimeState: normalizeRuntimeCheckpoint(record.runtimeState),
    syncBuf: typeof record.syncBuf === "string" ? record.syncBuf : "",
    token: typeof record.token === "string" && record.token
      ? record.token
      : null,
  };
}

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function normalizeBrainSession(raw: unknown): BrainSession | null {
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const updatedAt = nullableIsoTimestamp(record.updatedAt);
  if (
    (record.hostId !== "codex" && record.hostId !== "claude-code") ||
    typeof record.sessionId !== "string" ||
    !record.sessionId ||
    !updatedAt
  ) {
    return null;
  }

  const hasBridgeVersion = record.bridgeVersion !== undefined;
  const hasPermissionProfile = record.permissionProfileSha256 !== undefined;
  if (!hasBridgeVersion && !hasPermissionProfile) {
    return {
      hostId: record.hostId,
      sessionId: record.sessionId,
      updatedAt,
    };
  }
  if (
    typeof record.bridgeVersion !== "string" ||
    !SEMVER_PATTERN.test(record.bridgeVersion) ||
    typeof record.permissionProfileSha256 !== "string" ||
    !SHA256_PATTERN.test(record.permissionProfileSha256)
  ) {
    return {
      hostId: record.hostId,
      sessionId: record.sessionId,
      updatedAt,
    };
  }
  return {
    bridgeVersion: record.bridgeVersion,
    hostId: record.hostId,
    permissionProfileSha256: record.permissionProfileSha256,
    sessionId: record.sessionId,
    updatedAt,
  };
}

function normalizeAccountVerification(
  raw: unknown,
): AccountVerificationCheckpoint | null {
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (
    (record.hostId !== "codex" && record.hostId !== "claude-code") ||
    typeof record.mcpUrl !== "string"
  ) {
    return null;
  }
  const verifiedAt = nullableIsoTimestamp(record.verifiedAt);
  if (!verifiedAt) return null;
  let mcpUrl: URL;
  try {
    mcpUrl = new URL(record.mcpUrl);
  } catch {
    return null;
  }
  const loopback =
    mcpUrl.hostname === "127.0.0.1" ||
    mcpUrl.hostname === "localhost" ||
    mcpUrl.hostname === "[::1]";
  if (
    (mcpUrl.protocol !== "https:" &&
      !(mcpUrl.protocol === "http:" && loopback)) ||
    mcpUrl.username ||
    mcpUrl.password ||
    mcpUrl.hash ||
    mcpUrl.search ||
    mcpUrl.pathname !== "/mcp"
  ) {
    return null;
  }
  return {
    hostId: record.hostId,
    mcpUrl: mcpUrl.toString(),
    verifiedAt,
  };
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function normalizeRuntimeReporterState(
  raw: unknown,
): RuntimeReporterLocalState {
  if (raw === null || typeof raw !== "object") {
    return {
      bindingId: null,
      installationId: null,
      runtimeClientFingerprint: null,
    };
  }
  const record = raw as Record<string, unknown>;
  return {
    bindingId:
      typeof record.bindingId === "string" &&
      UUID_PATTERN.test(record.bindingId)
        ? record.bindingId
        : null,
    installationId:
      typeof record.installationId === "string" &&
      UUID_PATTERN.test(record.installationId)
        ? record.installationId
        : null,
    runtimeClientFingerprint:
      typeof record.runtimeClientFingerprint === "string" &&
      /^[a-f0-9]{64}$/u.test(record.runtimeClientFingerprint)
        ? record.runtimeClientFingerprint
        : null,
  };
}

const RUNTIME_PHASES: ReadonlySet<RuntimePhase> = new Set([
  "starting",
  "healthy",
  "restarting",
  "recovering_thread",
  "replaying_history",
  "degraded_auth",
  "degraded_runtime",
  "stopped",
]);

const ATTENTION_MCP_STATUSES: ReadonlySet<AttentionMcpStatus> = new Set([
  "unknown",
  "checking",
  "ready",
  "reconnecting",
  "auth_required",
  "unreachable",
  "tool_error",
]);

const ATTENTION_MCP_ERROR_CODES: ReadonlySet<AttentionMcpErrorCode> = new Set([
  "mcp_auth_required",
  "mcp_token_refresh_failed",
  "mcp_server_unreachable",
  "mcp_protocol_failed",
  "mcp_account_probe_failed",
]);

function normalizeAttentionMcpCheckpoint(
  raw: unknown,
): AttentionMcpCheckpoint {
  const fallback = defaultAttentionMcpCheckpoint();
  if (raw === null || typeof raw !== "object") return fallback;
  const record = raw as Record<string, unknown>;
  if (
    typeof record.status !== "string" ||
    !ATTENTION_MCP_STATUSES.has(record.status as AttentionMcpStatus)
  ) {
    return fallback;
  }
  return {
    lastCheckedAt: nullableIsoTimestamp(record.lastCheckedAt),
    lastErrorCode:
      typeof record.lastErrorCode === "string" &&
      ATTENTION_MCP_ERROR_CODES.has(
        record.lastErrorCode as AttentionMcpErrorCode,
      )
        ? (record.lastErrorCode as AttentionMcpErrorCode)
        : null,
    lastReadyAt: nullableIsoTimestamp(record.lastReadyAt),
    nextRetryAt: nullableIsoTimestamp(record.nextRetryAt),
    retryAttempt:
      typeof record.retryAttempt === "number" &&
      Number.isSafeInteger(record.retryAttempt) &&
      record.retryAttempt >= 0
        ? record.retryAttempt
        : 0,
    status: record.status as AttentionMcpStatus,
  };
}

function normalizeRuntimeCheckpoint(raw: unknown): RuntimeCheckpoint {
  const fallback = defaultRuntimeCheckpoint();
  if (raw === null || typeof raw !== "object") return fallback;
  const record = raw as Record<string, unknown>;
  if (
    typeof record.phase !== "string" ||
    !RUNTIME_PHASES.has(record.phase as RuntimePhase)
  ) {
    return fallback;
  }
  return {
    activeTurnMessageRef: normalizeMessageRef(record.activeTurnMessageRef),
    lastErrorCode: normalizeErrorCode(record.lastErrorCode),
    lastHealthyAt: nullableIsoTimestamp(record.lastHealthyAt),
    lastSuccessfulMessageAt: nullableIsoTimestamp(
      record.lastSuccessfulMessageAt,
    ),
    lastTransitionAt: nullableIsoTimestamp(record.lastTransitionAt),
    nextRetryAt: nullableIsoTimestamp(record.nextRetryAt),
    phase: record.phase as RuntimePhase,
    retryAttempt:
      typeof record.retryAttempt === "number" &&
      Number.isSafeInteger(record.retryAttempt) &&
      record.retryAttempt >= 0
        ? record.retryAttempt
        : 0,
  };
}

function normalizeMessageRef(value: unknown): string | null {
  return typeof value === "string" && /^msg-[a-f0-9]{48}$/u.test(value)
    ? value
    : null;
}

function normalizeErrorCode(value: unknown): string | null {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,99}$/u.test(value)
    ? value
    : null;
}

const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

function nullableIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? value : null;
}

const SUMMARY_RETRY_KEYS = new Set([
  "automaticAttempts",
  "collectionId",
  "cycleStartedAt",
  "lastFailureClass",
  "nextAttemptAt",
  "status",
]);

function normalizeSummaryRetries(value: unknown): SummaryRetryJob[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const normalized: SummaryRetryJob[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (
      Object.keys(record).length !== SUMMARY_RETRY_KEYS.size ||
      Object.keys(record).some((key) => !SUMMARY_RETRY_KEYS.has(key))
    ) {
      continue;
    }
    const collectionId =
      typeof record.collectionId === "string" &&
      UUID_PATTERN.test(record.collectionId)
        ? record.collectionId.toLowerCase()
        : null;
    const cycleStartedAt = nullableIsoTimestamp(record.cycleStartedAt);
    const nextAttemptAt = nullableIsoTimestamp(record.nextAttemptAt);
    const automaticAttempts = record.automaticAttempts;
    const persistedStatus = record.status;
    if (
      !collectionId ||
      !cycleStartedAt ||
      seen.has(collectionId) ||
      typeof automaticAttempts !== "number" ||
      !Number.isInteger(automaticAttempts) ||
      automaticAttempts < 0 ||
      automaticAttempts > 3 ||
      (record.lastFailureClass !== null &&
        record.lastFailureClass !== "enrichment_incomplete") ||
      (persistedStatus !== "scheduled" &&
        persistedStatus !== "running" &&
        persistedStatus !== "paused") ||
      (persistedStatus === "paused"
        ? nextAttemptAt !== null || automaticAttempts !== 3
        : nextAttemptAt === null || automaticAttempts >= 3)
    ) {
      continue;
    }
    seen.add(collectionId);
    normalized.push({
      automaticAttempts: automaticAttempts as 0 | 1 | 2 | 3,
      collectionId,
      cycleStartedAt,
      lastFailureClass: record.lastFailureClass,
      nextAttemptAt,
      status: persistedStatus === "running" ? "scheduled" : persistedStatus,
    });
    if (normalized.length >= 32) break;
  }
  return normalized;
}

function normalizeBaseUrl(value: unknown): string {
  if (typeof value !== "string" || !value) return ILINK_BASE_URL;
  try {
    return validateIlinkBaseUrl(value);
  } catch {
    return ILINK_BASE_URL;
  }
}

export async function loadChannelState(
  baseDirectory?: string,
): Promise<ChannelState> {
  const path = channelStatePath(baseDirectory);
  try {
    const raw = await readFile(path, "utf8");
    return normalizeState(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultChannelState();
    }
    throw error;
  }
}

export async function saveChannelState(
  state: ChannelState,
  baseDirectory?: string,
): Promise<void> {
  const path = channelStatePath(baseDirectory);
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  await chmod(dirname(path), 0o700);
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  await writeFile(
    temporaryPath,
    JSON.stringify(
      {
        ...state,
        attentionMcp: normalizeAttentionMcpCheckpoint(state.attentionMcp),
        runtimeState: normalizeRuntimeCheckpoint(state.runtimeState),
      },
      null,
      2,
    ),
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
  await rename(temporaryPath, path);
  // rename preserves the temp file mode; chmod keeps intent explicit.
  await chmod(path, 0o600);
}

/**
 * Removes only the iLink login/session material. The file itself is deleted
 * rather than rewritten so no credential bytes linger on disk.
 */
export async function clearChannelState(baseDirectory?: string): Promise<void> {
  try {
    await rm(channelStatePath(baseDirectory), { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Records a processed message id in the bounded deduplication ring. */
export function rememberProcessedMessage(
  state: ChannelState,
  messageId: string,
): void {
  state.processedMessageIds.push(messageId);
  if (state.processedMessageIds.length > PROCESSED_MESSAGE_RING_SIZE) {
    state.processedMessageIds.splice(
      0,
      state.processedMessageIds.length - PROCESSED_MESSAGE_RING_SIZE,
    );
  }
}

/** Appends one user/assistant exchange to the rolling history. */
export function appendHistory(
  state: ChannelState,
  userContent: string,
  assistantContent: string,
): void {
  state.history.push(
    { content: userContent, role: "user" },
    { content: assistantContent, role: "assistant" },
  );
  const maximumEntries = BRAIN_HISTORY_TURNS * 2;
  if (state.history.length > maximumEntries) {
    state.history.splice(0, state.history.length - maximumEntries);
  }
}
