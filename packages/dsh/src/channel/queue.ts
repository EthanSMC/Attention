/**
 * Inbound/outbound message queue for the Attention Channel.
 */

import type { InboundMessage, OutboundMessage } from './messages.js';

export interface MessageQueue {
  enqueueInbound(message: InboundMessage): void;
  dequeueInbound(): InboundMessage | null;
  enqueueOutbound(message: OutboundMessage): void;
  dequeueOutbound(): OutboundMessage | null;
  readonly inboundCount: number;
  readonly outboundCount: number;
}

const MAX_PENDING_MESSAGES = 100;

export function createMessageQueue(): MessageQueue {
  const inbound: InboundMessage[] = [];
  const outbound: OutboundMessage[] = [];

  return {
    enqueueInbound(message) {
      if (inbound.length >= MAX_PENDING_MESSAGES) inbound.shift();
      inbound.push(message);
    },
    dequeueInbound() { return inbound.shift() ?? null; },
    enqueueOutbound(message) { outbound.push(message); },
    dequeueOutbound() { return outbound.shift() ?? null; },
    get inboundCount() { return inbound.length; },
    get outboundCount() { return outbound.length; },
  };
}
