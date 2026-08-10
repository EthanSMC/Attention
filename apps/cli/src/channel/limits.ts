/**
 * Operational limits for the local attention-channel bridge.
 *
 * Values are aligned with the server-side collection contract where relevant
 * (`attention_collect_content` accepts up to 32_768 input characters) and
 * with the restricted-profile template (no unbounded work per message).
 */

/** Long-poll window for `ilink/bot/getupdates` and QR status polling. */
export const ILINK_LONG_POLL_TIMEOUT_MS = 35_000;

/** Default timeout for ordinary iLink API calls. */
export const ILINK_API_TIMEOUT_MS = 120_000;

/** QR codes expire after roughly five minutes; refresh at most this many times. */
export const ILINK_MAXIMUM_QR_REFRESH = 3;

/** Maximum characters forwarded to the brain for a single message. */
export const BRAIN_MAXIMUM_INPUT_CHARS = 32_000;

/** Hard timeout for one brain invocation. */
export const BRAIN_TIMEOUT_MS = 300_000;

/** Capped resident Codex restart schedule after consecutive failures. */
export const CODEX_RESTART_BACKOFF_MS = [
  1_000,
  2_000,
  4_000,
  8_000,
  15_000,
] as const;

/** Rolling conversation history kept for replay fallback and status output. */
export const BRAIN_HISTORY_TURNS = 20;

/** A single WeChat reply is split above this length. */
export const MAXIMUM_REPLY_CHARS = 4_000;

/** Processed message identifiers kept for deduplication. */
export const PROCESSED_MESSAGE_RING_SIZE = 1_000;

/** Maximum durable inbound messages processed in one cycle; excess stays queued. */
export const MAXIMUM_PENDING_MESSAGES = 5;

/** Immediate non-terminal acknowledgement for link collection work only. */
export const PROCESSING_ACK_REPLY = "正在收藏…";

/** Reply sent for messages that carry no usable text. */
export const NON_TEXT_REPLY =
  "暂时只支持文字消息哦。请发送链接或分享文案，我来帮你收藏。";

/** Reply sent after the user clears the conversation with /reset. */
export const RESET_REPLY = "对话历史已重置。";

/** Reply requiring the explicit slash command before destructive reset. */
export const RESET_CONFIRMATION_REPLY =
  "如需清空本地对话历史，请发送 /reset 明确确认。";

/** Deterministic replies that remain available while Codex is offline. */
export const CONTROL_HELP_REPLY =
  "可用命令：状态、帮助、重试、重新连接；处理中断时可发送继续。清空对话请发送 /reset。";
export const CONTROL_RETRY_REPLY =
  "已请求重新连接 Codex；恢复后会从本地断点继续。";
export const CONTROL_CONTINUE_REPLY = "已请求从本地断点继续处理。";

/** Reply sent when the brain produces no usable answer. */
export const BRAIN_FAILURE_REPLY = "处理失败了，请稍后再试。";
