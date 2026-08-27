/**
 * Message parsing and formatting for the Attention Channel.
 */

export interface InboundMessage {
  readonly messageId: string;
  readonly fromUser: string;
  readonly content: string;
  readonly timestamp: number;
}

export interface OutboundMessage {
  readonly replyTo: string;
  readonly content: string;
}

/** Extract URLs from message text. */
export function extractUrls(text: string): readonly string[] {
  const urlPattern = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/giu;
  const matches = text.match(urlPattern);
  return matches ? [...new Set(matches)] : [];
}

/** Check if a message is likely a collection request (contains links). */
export function isCollectionRequest(text: string): boolean {
  return extractUrls(text).length > 0;
}

/** Format a reply for a collection result. */
export function formatCollectionReply(
  status: string,
  title?: string,
): string {
  const replies: Record<string, string> = {
    accepted: title
      ? '已收藏：' + title
      : '已收藏，内容整理会在后台继续。',
    already_collected: '这个链接已经在你的收藏中。',
    ambiguous: '识别到多个候选链接，请前往 Attention 网页选择。',
    invalid: '没有识别到可收藏的内容链接。',
    unsafe: '链接未通过安全检查，未执行收藏。',
    failed: '收藏失败，请稍后重试。',
  };
  return replies[status] ?? 'Attention 已完成处理。';
}
