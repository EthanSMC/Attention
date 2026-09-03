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
import type { AttentionMcpFailure } from "./mcp-readiness";

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
  /** True when the message was new and accepted for handling. */
  readonly processed: boolean;
  /** Exact local command handled without invoking the brain, when present. */
  readonly controlCommand?: ControlCommand;
  /** Structured Attention MCP failure that kept this message pending. */
  readonly attentionMcpFailure?: AttentionMcpFailure;
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

const RETRY_COMMANDS: ReadonlySet<string> = new Set([
  "/retry",
  "再试一次",
  "帮我重连一下",
  "帮我重试一下",
  "重新连接",
  "重新连接一下",
  "重连",
  "重试",
  "重试一下",
]);

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
  const commandText = text
    .normalize("NFKC")
    .trim()
    .replace(/[。！？?!]+$/gu, "")
    .trim();
  if (RETRY_COMMANDS.has(commandText)) return "retry";
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
  if (controlCommand === "retry") {
    state.lastActivityAt = new Date().toISOString();
    return {
      completed: false,
      controlCommand,
      processed: true,
      replies: [],
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
  const previousActiveTurnMessageRef =
    state.runtimeState.activeTurnMessageRef;
  state.runtimeState.activeTurnMessageRef = messageRef;
  const outcome = await invokeWithFallback(input, text, messageRef);

  state.lastActivityAt = new Date().toISOString();
  if (outcome.attentionMcpFailure) {
    return {
      attentionMcpFailure: outcome.attentionMcpFailure,
      completed: false,
      processed: true,
      replies: [attentionMcpFailureReply(outcome.attentionMcpFailure)],
    };
  }
  if (
    !outcome.collectionReplyControl &&
    (!outcome.ok || !outcome.reply.trim())
  ) {
    return {
      completed: false,
      processed: true,
      replies: [
        outcome.timedOut ? "处理超时了，请稍后再试。" : BRAIN_FAILURE_REPLY,
      ],
    };
  }

  state.runtimeState.activeTurnMessageRef =
    previousActiveTurnMessageRef !== null &&
    previousActiveTurnMessageRef !== messageRef
      ? previousActiveTurnMessageRef
      : null;
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

function attentionMcpFailureReply(failure: AttentionMcpFailure): string {
  switch (failure.errorCode) {
    case "mcp_auth_required":
    case "mcp_token_refresh_failed":
      return "Attention MCP 需要重新授权；这条操作已保留。请在电脑完成授权后发送“重试”。";
    case "mcp_server_unreachable":
      return "Attention MCP 暂时不可达；这条操作已保留并会在恢复后重试。";
    case "mcp_account_probe_failed":
    case "mcp_protocol_failed":
      return "Attention MCP 工具异常；这条操作已保留，请稍后发送“重试”。";
  }
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
  command: Exclude<ControlCommand, "reset" | "retry">,
  state: ChannelState,
  hostId: BrainAdapter["hostId"],
): string {
  switch (command) {
    case "help":
      return CONTROL_HELP_REPLY;
    case "pairing_verification":
      return "正在验证设备绑定…";
    case "continue":
      return CONTROL_CONTINUE_REPLY;
    case "reset_confirmation":
      return RESET_CONFIRMATION_REPLY;
    case "status": {
      const runtime = state.runtimeState;
      const wechat = state.token ? "已登录" : "未登录";
      const lastSuccess = runtime.lastSuccessfulMessageAt ?? "无";
      const runtimeRetry = runtime.nextRetryAt
        ? `（下次自动重试：${runtime.nextRetryAt}）`
        : "";
      const mcpRetry = state.attentionMcp.nextRetryAt
        ? `，下次自动重试：${state.attentionMcp.nextRetryAt}`
        : "";
      const mcpAvailability =
        state.attentionMcp.status === "ready"
          ? ""
          : "（微信对话仍可用）";
      const reporterEnabled =
        state.runtimeReporter.installationId !== null ||
        state.runtimeReporter.bindingId !== null;
      const runtimeName = hostId === "claude-code" ? "Claude Code" : "Codex";
      return [
        `iLink：${wechat}`,
        `${runtimeName} Runtime：${runtime.phase}${runtimeRetry}`,
        `Attention MCP：${state.attentionMcp.status}${mcpAvailability}${mcpRetry}`,
        `Reporter：${reporterEnabled ? "已启用" : "未启用"}`,
        `最近成功处理：${lastSuccess}`,
        `队列：${state.pendingInbound.length} 条待处理，${state.pendingOutbound.length} 条待发送`,
      ].join("\n");
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
