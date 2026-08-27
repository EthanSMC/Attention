/**
 * Channel Pipeline - routes WeChat messages through the Attention workflow.
 */

import type { ILinkClient, ILinkEvent } from "../ilink/client.js";
import type { ILinkInboundMessage } from "../ilink/protocol.js";
import { AttentionMcpClient } from "../mcp-client.js";
import { createMessageQueue, type MessageQueue } from "./queue.js";
import { createMessageHandler } from "./handler.js";
import { type InboundMessage, isCollectionRequest, extractUrls, formatCollectionReply } from "./messages.js";

export interface ChannelPipelineOptions {
  readonly ilink: ILinkClient;
  readonly mcp: AttentionMcpClient;
}

export interface ChannelPipeline {
  start(): Promise<void>;
  stop(): void;
  readonly queue: MessageQueue;
}

export function createChannelPipeline(
  options: ChannelPipelineOptions,
): ChannelPipeline {
  const { ilink, mcp } = options;
  const queue = createMessageQueue();
  const handler = createMessageHandler({ mcp });
  let running = false;

  function toInbound(msg: ILinkInboundMessage): InboundMessage {
    return {
      messageId: msg.messageId,
      fromUser: msg.fromUser,
      content: msg.content,
      timestamp: msg.timestamp,
    };
  }

  async function handleMessage(msg: InboundMessage): Promise<void> {
    queue.enqueueInbound(msg);
    if (isCollectionRequest(msg.content)) {
      const reply = await handler.handle(msg);
      await ilink.sendReply({ replyTo: msg.fromUser, content: reply });
    }
  }

  return {
    async start() {
      if (running) return;
      running = true;
      ilink.on((event: ILinkEvent) => {
        if (event.type === 'message' && event.message) {
          handleMessage(toInbound(event.message)).catch(() => {});
        }
      });
      const restored = await ilink.restore();
      if (restored) await ilink.startPolling();
    },
    stop() { running = false; ilink.stopPolling(); },
    queue,
  };
}
