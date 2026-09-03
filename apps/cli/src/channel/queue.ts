import { createHash } from "node:crypto";

import type { InboundMessage } from "./messages";
import { messageIdentifier } from "./messages";
import { rememberProcessedMessage, type ChannelState } from "./state";

export function enqueueInbound(
  state: ChannelState,
  messages: readonly InboundMessage[],
): number {
  const known = new Set([
    ...state.processedMessageIds,
    ...state.pendingInbound.map((item) => item.id),
  ]);
  let added = 0;
  for (const message of messages) {
    const id = messageIdentifier(message);
    if (known.has(id)) continue;
    state.pendingInbound.push({
      acknowledged: false,
      attempts: 0,
      blockedBy: null,
      id,
      message,
    });
    known.add(id);
    added += 1;
  }
  return added;
}

export function completeInbound(state: ChannelState, id: string): void {
  const index = state.pendingInbound.findIndex((item) => item.id === id);
  if (index >= 0) state.pendingInbound.splice(index, 1);
  if (!state.processedMessageIds.includes(id)) {
    rememberProcessedMessage(state, id);
  }
}

export function enqueueOutbound(
  state: ChannelState,
  message: ChannelState["pendingOutbound"][number],
): void {
  if (state.pendingOutbound.some((item) => item.id === message.id)) return;
  state.pendingOutbound.push(message);
}

export function markOutboundSent(state: ChannelState, id: string): void {
  const index = state.pendingOutbound.findIndex((item) => item.id === id);
  if (index >= 0) state.pendingOutbound.splice(index, 1);
}

export function outboundIdentifier(input: {
  readonly inboundId: string;
  readonly kind: "ack" | "result" | "retry";
  readonly index?: number;
}): string {
  return `out-${createHash("sha256")
    .update(
      `${input.inboundId}:${input.kind}:${String(input.index ?? 0)}`,
      "utf8",
    )
    .digest("hex")
    .slice(0, 32)}`;
}
