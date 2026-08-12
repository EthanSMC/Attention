/**
 * Message pipeline for the attention-channel bridge.
 *
 * One inbound iLink message goes through: deduplication, owner pinning,
 * text extraction, size capping, brain invocation (host-session resume with
 * transcript-replay fallback), and history bookkeeping. The caller owns the
 * serial queue and the actual iLink reply sending.
 */

import { createHash } from "node:crypto";

import type { BrainAdapter, BrainOutcome } from "./brain";
import {
  BRAIN_FAILURE_REPLY,
  BRAIN_MAXIMUM_INPUT_CHARS,
  CONTROL_CONTINUE_REPLY,
  CONTROL_HELP_REPLY,
  CONTROL_RETRY_REPLY,
  MAXIMUM_REPLY_CHARS,
  NON_TEXT_REPLY,
  RESET_CONFIRMATION_REPLY,
  RESET_REPLY,
} from "./limits";
import { type InboundMessage, extractText, messageIdentifier } from "./messages";
import {
  buildFirstTurnPrompt,
  buildFollowUpPrompt,
  buildReplayPrompt,
} from "./prompt";
import {
  appendHistory,
  type ChannelState,
  rememberProcessedMessage,
} from "./state";
import { safeCollectionReply } from "./collection-reply-control";

export interface PipelineInput {
  readonly brain: BrainAdapter;
  /** Working directory for brain subprocesses (the channel state dir). */
  readonly cwd: string;
  readonly message: InboundMessage;
  /** Ephemeral server pairing code; never persisted or replayed. */
  readonly pairingCode?: string | null;
  readonly state: ChannelState;
  /** Brain invocation seam so tests can run without a real host CLI. */
  readonly invokeBrain?: (input: {
    readonly prompt: string;
    readonly sessionId: string | null;
  }) => Promise<BrainOutcome>;
}

export interface PipelineOutput {
  /** True only when it is safe to remove this message from the durable inbox. */
  readonly completed: boolean;
  /** Reply texts to send back in order (already split to message size). */
  readonly replies: readonly string[];
  /** True when the message was new and fully handled. */
  readonly processed: boolean;
  /** Exact local command handled without invoking the brain, when present. */
  readonly controlCommand?: ControlCommand;
}

export type ControlCommand =
  | "status"
  | "help"
  | "retry"
  | "continue"
  | "pairing_verification"
  | "reset_confirmation"
  | "reset";

const TRUNCATION_NOTE = "\n…（内容过长已截断）";

const ALWAYS_LOCAL_COMMANDS: Readonly<Record<string, ControlCommand>> = {
  "/help": "help",
  "/reset": "reset",
  "/retry": "retry",
  "/status": "status",
  "帮助": "help",
  "连接状态": "status",
  "重新连接": "retry",
  "状态": "status",
  "重试": "retry",
  "重置会话": "reset_confirmation",
};

/** Derives a bounded idempotency reference from the complete message id. */
export function buildMessageRef(messageId: string): string {
  const digest = createHash("sha256").update(messageId).digest("hex");
  return `msg-${digest.slice(0, 48)}`;
}

/** Matches only a complete trimmed control message. */
export function matchControlCommand(
  text: string,
  context: { readonly degraded: boolean },
): ControlCommand | null {
  const commandText = text.trim();
  const alwaysLocal = ALWAYS_LOCAL_COMMANDS[commandText];
  if (alwaysLocal) return alwaysLocal;
  if (
    context.degraded &&
    (commandText === "继续" || commandText === "/continue")
  ) {
    return "continue";
  }
  return null;
}

export async function handleInboundMessage(
  input: PipelineInput,
): Promise<PipelineOutput> {
  const { state } = input;
  const messageId = messageIdentifier(input.message);

  if (state.processedMessageIds.includes(messageId)) {
    return { completed: true, processed: false, replies: [] };
  }

  // ClawBot sessions only deliver the QR scanner's own messages; the pin is
  // defense-in-depth against any future multi-peer delivery.
  if (state.ownerUserId === null) {
    state.ownerUserId = input.message.fromUserId;
  } else if (state.ownerUserId !== input.message.fromUserId) {
    return { completed: true, processed: false, replies: [] };
  }

  if (input.message.contextToken) {
    state.contextTokens[input.message.fromUserId] =
      input.message.contextToken;
  }

  const extracted = extractText(input.message.itemList);
  if (extracted.nonTextOnly) {
    state.lastActivityAt = new Date().toISOString();
    rememberProcessedMessage(state, messageId);
    return { completed: true, processed: true, replies: [NON_TEXT_REPLY] };
  }
  let text = extracted.text;
  if (!text) {
    rememberProcessedMessage(state, messageId);
    return { completed: true, processed: true, replies: [] };
  }
  if (text.length > BRAIN_MAXIMUM_INPUT_CHARS) {
    text =
      text.slice(0, BRAIN_MAXIMUM_INPUT_CHARS - TRUNCATION_NOTE.length) +
      TRUNCATION_NOTE;
  }

  const controlCommand =
    input.pairingCode && text.trim() === input.pairingCode
      ? "pairing_verification"
      : matchControlCommand(text, {
          degraded: canResumeInterruptedTurn(state),
        });
  if (controlCommand === "reset") {
    state.history = [];
    state.brainSession = null;
    state.runtimeState.activeTurnMessageRef = null;
    state.lastActivityAt = new Date().toISOString();
    rememberProcessedMessage(state, messageId);
    return {
      completed: true,
      controlCommand,
      processed: true,
      replies: [RESET_REPLY],
    };
  }
  if (controlCommand) {
    state.lastActivityAt = new Date().toISOString();
    rememberProcessedMessage(state, messageId);
    return {
      completed: true,
      controlCommand,
      processed: true,
      replies: [buildControlReply(controlCommand, state, input.brain.hostId)],
    };
  }

  const messageRef = buildMessageRef(messageId);
  state.runtimeState.activeTurnMessageRef = messageRef;
  const outcome = await invokeWithFallback(input, text, messageRef);

  state.lastActivityAt = new Date().toISOString();
  if (!outcome.ok || !outcome.reply.trim()) {
    return {
      completed: false,
      processed: true,
      replies: [
        outcome.timedOut ? "处理超时了，请稍后再试。" : BRAIN_FAILURE_REPLY,
      ],
    };
  }

  state.runtimeState.activeTurnMessageRef = null;
  state.runtimeState.lastSuccessfulMessageAt = state.lastActivityAt;
  const safeReply = outcome.collectionReplyControl
    ? safeCollectionReply(outcome.collectionReplyControl)
    : outcome.reply.trim();
  appendHistory(state, text, safeReply);
  rememberProcessedMessage(state, messageId);
  return {
    completed: true,
    processed: true,
    replies: splitReply(safeReply),
  };
}

function canResumeInterruptedTurn(state: ChannelState): boolean {
  if (state.runtimeState.activeTurnMessageRef === null) return false;
  return (
    state.runtimeState.phase === "restarting" ||
    state.runtimeState.phase === "recovering_thread" ||
    state.runtimeState.phase === "replaying_history" ||
    state.runtimeState.phase === "degraded_auth" ||
    state.runtimeState.phase === "degraded_runtime"
  );
}

function buildControlReply(
  command: Exclude<ControlCommand, "reset">,
  state: ChannelState,
  hostId: BrainAdapter["hostId"],
): string {
  switch (command) {
    case "help":
      return CONTROL_HELP_REPLY;
    case "pairing_verification":
      return "正在验证设备绑定…";
    case "retry":
      return CONTROL_RETRY_REPLY;
    case "continue":
      return CONTROL_CONTINUE_REPLY;
    case "reset_confirmation":
      return RESET_CONFIRMATION_REPLY;
    case "status": {
      const runtime = state.runtimeState;
      const wechat = state.token
        ? "本地存在微信登录态"
        : "本地未保存微信登录态";
      const lastSuccess = runtime.lastSuccessfulMessageAt ?? "无";
      const retry = runtime.nextRetryAt
        ? `下次自动重试：${runtime.nextRetryAt}。`
        : "";
      const runtimeName = hostId === "claude-code" ? "Claude Code" : "Codex";
      return [
        `${wechat}。`,
        `${runtimeName} Runtime：${runtime.phase}。`,
        `最近成功处理：${lastSuccess}。`,
        `${state.pendingInbound.length} 条消息等待处理，${state.pendingOutbound.length} 条待发送。`,
        retry,
      ].join("");
    }
  }
}

async function invokeWithFallback(
  input: PipelineInput,
  text: string,
  messageRef: string,
): Promise<BrainOutcome> {
  const { brain, state } = input;
  const invoke =
    input.invokeBrain ??
    ((brainInput) => brain.invoke({ ...brainInput, cwd: input.cwd }));
  const storedSession =
    state.brainSession?.hostId === brain.hostId
      ? state.brainSession.sessionId
      : null;

  if (storedSession) {
    const resumed = await invoke({
      prompt: buildFollowUpPrompt({ messageRef, userMessage: text }),
      sessionId: storedSession,
    });
    if (!resumed.resumeFailed) {
      recordSession(state, brain.hostId, resumed.sessionId ?? storedSession);
      return resumed;
    }
    // Resume failed: drop the stale session and replay the transcript.
    state.brainSession = null;
  }

  const prompt =
    state.history.length === 0
      ? buildFirstTurnPrompt({ messageRef, userMessage: text })
      : buildReplayPrompt({
          history: state.history,
          messageRef,
          userMessage: text,
        });
  const fresh = await invoke({ prompt, sessionId: null });
  if (fresh.sessionId) {
    recordSession(state, brain.hostId, fresh.sessionId);
  }
  return fresh;
}

function recordSession(
  state: ChannelState,
  hostId: "codex" | "claude-code",
  sessionId: string | null,
): void {
  if (!sessionId) return;
  state.brainSession = {
    hostId,
    sessionId,
    updatedAt: new Date().toISOString(),
  };
}

/** Splits long replies at sentence/line boundaries for WeChat delivery. */
export function splitReply(
  reply: string,
  maximumChars: number = MAXIMUM_REPLY_CHARS,
): readonly string[] {
  if (reply.length <= maximumChars) return [reply];
  const chunks: string[] = [];
  let remaining = reply;
  while (remaining.length > maximumChars) {
    const window = remaining.slice(0, maximumChars);
    let cut = Math.max(
      window.lastIndexOf("\n"),
      window.lastIndexOf("。"),
      window.lastIndexOf(". "),
    );
    if (cut < Math.floor(maximumChars / 2)) cut = maximumChars;
    else cut += 1;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks.filter((chunk) => chunk.length > 0);
}
