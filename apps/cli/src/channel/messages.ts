/**
 * Inbound iLink message parsing for the attention-channel bridge.
 *
 * Item types follow the iLink reference PoC: 1 text, 2 image, 3 voice (with
 * a server-side transcript), 4 file, 5 video. Voice transcripts count as
 * text because users dictate share text by voice; other non-text items get a
 * canned reply instead of reaching the brain.
 */

import { createHash } from "node:crypto";

export interface ExtractedMessage {
  /** Usable text content (joined text/voice-transcript parts). */
  readonly text: string;
  /** True when the message contained only non-text items. */
  readonly nonTextOnly: boolean;
}

interface ItemShape {
  readonly ref_msg?: {
    readonly message_item?: ItemShape;
    readonly title?: unknown;
  };
  readonly type?: unknown;
  readonly text_item?: { readonly text?: unknown };
  readonly voice_item?: { readonly text?: unknown };
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function extractText(itemList: unknown): ExtractedMessage {
  if (!Array.isArray(itemList)) {
    return { nonTextOnly: false, text: "" };
  }
  const parts: string[] = [];
  let sawNonText = false;
  let sawText = false;
  const collect = (item: ItemShape, depth: number): void => {
    if (depth > 2) return;
    const referencedTitle = readString(item.ref_msg?.title);
    if (referencedTitle) {
      parts.push(referencedTitle);
      sawText = true;
    }
    if (item.ref_msg?.message_item) {
      collect(item.ref_msg.message_item, depth + 1);
    }
    const itemType = Number(item.type ?? 0) || 0;
    if (itemType === 1) {
      const text = readString(item.text_item?.text);
      if (text) {
        parts.push(text);
        sawText = true;
      }
    } else if (itemType === 3) {
      const voiceText = readString(item.voice_item?.text);
      if (voiceText) {
        parts.push(voiceText);
        sawText = true;
      } else {
        sawNonText = true;
      }
    } else if (itemType >= 2 && itemType <= 5) {
      sawNonText = true;
    }
  };
  for (const raw of itemList) {
    if (raw === null || typeof raw !== "object") continue;
    collect(raw as ItemShape, 0);
  }
  return {
    nonTextOnly: sawNonText && !sawText,
    text: parts.join("\n").trim(),
  };
}

export interface InboundMessage {
  readonly fromUserId: string;
  readonly contextToken: string;
  readonly itemList: unknown;
  readonly raw: Record<string, unknown>;
}

/**
 * Returns a stable identifier for an inbound message, used for
 * deduplication and as the bridge-provided reference for idempotency keys.
 *
 * iLink deliveries observed so far do not expose a guaranteed message id, so
 * the identifier falls back to a content fingerprint. Implementations must
 * therefore stay tolerant of unseen shapes.
 */
export function messageIdentifier(message: InboundMessage): string {
  const explicit = [
    "client_id",
    "msg_id",
    "message_id",
    "svr_id",
  ]
    .map((key) => readString(message.raw[key]))
    .find((value) => value.length > 0);
  if (explicit) return explicit;

  const fingerprintSource = [
    message.fromUserId,
    message.contextToken,
    JSON.stringify(message.itemList ?? null),
  ].join("|");
  return `fp-${createHash("sha256")
    .update(fingerprintSource, "utf8")
    .digest("hex")
    .slice(0, 32)}`;
}

/** Parses one entry of the iLink `msgs[]` array. */
export function parseInboundMessage(raw: unknown): InboundMessage | null {
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const fromUserId = readString(record.from_user_id);
  if (!fromUserId) return null;
  return {
    contextToken: readString(record.context_token),
    fromUserId,
    itemList: record.item_list,
    raw: record,
  };
}
