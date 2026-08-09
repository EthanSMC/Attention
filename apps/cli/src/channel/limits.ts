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

/** Rolling conversation history kept for replay fallback and status output. */
export const BRAIN_HISTORY_TURNS = 20;

/** A single WeChat reply is split above this length. */
export const MAXIMUM_REPLY_CHARS = 4_000;

/** Processed message identifiers kept for deduplication. */
export const PROCESSED_MESSAGE_RING_SIZE = 1_000;

/** Maximum durable inbound messages processed in one cycle; excess stays queued. */
export const MAXIMUM_PENDING_MESSAGES = 5;

/** Immediate non-terminal acknowledgement before the Agent starts work. */
export const PROCESSING_ACK_REPLY = "收到，正在处理…";

/** Reply sent for messages that carry no usable text. */
export const NON_TEXT_REPLY =
  "暂时只支持文字消息哦。请发送链接或分享文案，我来帮你收藏。";

/** Reply sent after the user clears the conversation with /reset. */
export const RESET_REPLY = "对话历史已重置。";

/** Reply sent when the brain produces no usable answer. */
export const BRAIN_FAILURE_REPLY = "处理失败了，请稍后再试。";
