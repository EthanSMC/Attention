/**
 * Message handler - dispatches inbound messages to the appropriate workflow.
 */

import type { AttentionMcpClient } from "../mcp-client.js";
import type { InboundMessage } from "./messages.js";
import { isCollectionRequest, extractUrls, formatCollectionReply } from "./messages.js";

export interface MessageHandlerOptions {
  readonly mcp: AttentionMcpClient;
}

export interface MessageHandler {
  handle(message: InboundMessage): Promise<string>;
}

export function createMessageHandler(
  options: MessageHandlerOptions,
): MessageHandler {
  const { mcp } = options;

  return {
    async handle(message: InboundMessage): Promise<string> {
      if (isCollectionRequest(message.content)) {
        const urls = extractUrls(message.content);
        const results: string[] = [];

        for (const url of urls) {
          const result = await mcp.call('attention_collect_content', {
            target_url: url,
            idempotency_key: message.messageId + '-' + btoa(url).slice(0, 32),
            client_context: {
              skill_id: 'attention',
              skill_version: '1.8.0',
              workflow_run_id: message.messageId,
            },
          });

          if (result.ok && result.value) {
            const status = typeof result.value.status === 'string' ? result.value.status : 'accepted';
            const title = typeof result.value.title === 'string' ? result.value.title : undefined;
            results.push(formatCollectionReply(status, title));
          } else {
            results.push(formatCollectionReply('failed'));
          }
        }
        return results.join('\n');
      }
      return '收到消息，但未识别到可收藏的链接。';
    },
  };
}
