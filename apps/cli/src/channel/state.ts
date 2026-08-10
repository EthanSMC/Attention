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

import { ILINK_BASE_URL, validateIlinkBaseUrl } from "./ilink-protocol";
import { BRAIN_HISTORY_TURNS, PROCESSED_MESSAGE_RING_SIZE } from "./limits";
import type { InboundMessage } from "./messages";

export interface HistoryEntry {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface BrainSession {
  readonly hostId: "codex" | "claude-code";
  readonly sessionId: string;
  readonly updatedAt: string;
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

export interface PendingInboundMessage {
  acknowledged: boolean;
  attempts: number;
  readonly id: string;
  readonly message: InboundMessage;
}

export interface PendingOutboundMessage {
  readonly contextToken: string;
  readonly id: string;
  readonly text: string;
  readonly toUserId: string;
}

export interface ChannelState {
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
    accountId: "",
    baseUrl: ILINK_BASE_URL,
    brainSession: null,
    contextTokens: {},
    history: [],
    lastActivityAt: null,
    ownerUserId: null,
    pendingInbound: [],
    pendingOutbound: [],
    processedMessageIds: [],
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
    accountId: typeof record.accountId === "string" ? record.accountId : "",
    baseUrl: normalizeBaseUrl(record.baseUrl),
    brainSession:
      record.brainSession !== null &&
      typeof record.brainSession === "object" &&
      typeof (record.brainSession as BrainSession).sessionId === "string" &&
      ((record.brainSession as BrainSession).hostId === "codex" ||
        (record.brainSession as BrainSession).hostId === "claude-code")
        ? (record.brainSession as BrainSession)
        : null,
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
    runtimeState: normalizeRuntimeCheckpoint(record.runtimeState),
    syncBuf: typeof record.syncBuf === "string" ? record.syncBuf : "",
    token: typeof record.token === "string" && record.token
      ? record.token
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
