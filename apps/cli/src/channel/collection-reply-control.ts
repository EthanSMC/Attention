export type EstablishedCollectionStatus =
  | "accepted"
  | "already_collected"
  | "merged_with_existing_content";

export type CollectionEnrichmentAction =
  | "generate_summary"
  | "reuse_summary"
  | "none";

/**
 * Content-free signal derived from Attention MCP results inside the host
 * protocol stream. It deliberately retains no URL, title, page text, summary,
 * or tags, so the bridge can choose a fixed acknowledgment without inspecting
 * or redacting model prose.
 */
export type CollectionReplyControl =
  | {
      readonly collectionStatus: EstablishedCollectionStatus;
      readonly enrichmentAction: CollectionEnrichmentAction;
      readonly enrichmentCompleted: boolean;
      readonly kind: "established";
    }
  | {
      readonly enrichmentAction: CollectionEnrichmentAction;
      readonly enrichmentCompleted: boolean;
      readonly kind: "recovery";
      readonly summaryStatus: "hidden" | "pending" | "ready" | "unavailable";
    }
  | {
      readonly kind: "fixed";
      readonly reply:
        | "未保存：链接无效。"
        | "未保存：链接未通过安全检查。"
        | "链接仍在解析，收藏尚未完成。"
        | "收藏结果无法确认，请稍后重试。"
        | "收藏状态无法确认，请稍后重试。";
    };

const UNCONFIRMED_COLLECTION_REPLY = {
  kind: "fixed",
  reply: "收藏结果无法确认，请稍后重试。",
} as const satisfies CollectionReplyControl;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object"
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function parseJsonObject(value: string): Readonly<Record<string, unknown>> | null {
  try {
    return record(JSON.parse(value));
  } catch {
    return null;
  }
}

/** Extracts only the structured result envelope; callers discard it at once. */
export function mcpResultPayload(value: unknown): Readonly<Record<string, unknown>> | null {
  const result = record(value);
  const structured = record(result?.structuredContent);
  if (structured) return structured;
  if (typeof value === "string") return parseJsonObject(value);
  const content = result?.content;
  if (typeof content === "string") return parseJsonObject(content);
  if (!Array.isArray(content)) return null;
  for (const entry of content) {
    if (typeof entry === "string") {
      const parsed = parseJsonObject(entry);
      if (parsed) return parsed;
      continue;
    }
    const block = record(entry);
    if (typeof block?.text === "string") {
      const parsed = parseJsonObject(block.text);
      if (parsed) return parsed;
    }
  }
  return null;
}

function establishedStatus(value: unknown): EstablishedCollectionStatus | null {
  return value === "accepted" ||
    value === "already_collected" ||
    value === "merged_with_existing_content"
    ? value
    : null;
}

function enrichmentAction(value: unknown): CollectionEnrichmentAction | null {
  return value === "generate_summary" ||
    value === "reuse_summary" ||
    value === "none"
    ? value
    : null;
}

function summaryStatus(
  value: unknown,
): "hidden" | "pending" | "ready" | "unavailable" | null {
  return value === "hidden" ||
    value === "pending" ||
    value === "ready" ||
    value === "unavailable"
    ? value
    : null;
}

function isAbsoluteHttpUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function applyAttentionToolResult(
  current: CollectionReplyControl | null,
  toolName: string,
  payload: Readonly<Record<string, unknown>> | null,
): CollectionReplyControl | null {
  const normalizedToolName = toolName.replace(/^mcp__attention__/u, "");
  if (
    normalizedToolName === "attention_collect_content" ||
    normalizedToolName === "attention_select_collection_candidate"
  ) {
    if (!payload) {
      return UNCONFIRMED_COLLECTION_REPLY;
    }
    if (payload.status === "invalid") {
      return { kind: "fixed", reply: "未保存：链接无效。" };
    }
    if (payload.status === "unsafe") {
      return { kind: "fixed", reply: "未保存：链接未通过安全检查。" };
    }
    if (payload.status === "resolution_pending") {
      return { kind: "fixed", reply: "链接仍在解析，收藏尚未完成。" };
    }
    if (payload.status === "ambiguous") return current;
    const status = establishedStatus(payload.status);
    const action = enrichmentAction(payload.enrichment_action);
    return status && action
      ? {
          collectionStatus: status,
          enrichmentAction: action,
          enrichmentCompleted: false,
          kind: "established",
        }
      : UNCONFIRMED_COLLECTION_REPLY;
  }
  if (normalizedToolName === "attention_get_collection_status") {
    if (!payload) {
      return {
        kind: "fixed",
        reply: "收藏状态无法确认，请稍后重试。",
      };
    }
    if (payload.content === null) return current;
    const content = record(payload.content);
    const action = enrichmentAction(content?.enrichment_action);
    const status = summaryStatus(content?.summary_status);
    const safePublicReadUrl =
      action !== "generate_summary" ||
      isAbsoluteHttpUrl(content?.public_read_url);
    if (!action || !status || !safePublicReadUrl) {
      return {
        kind: "fixed",
        reply: "收藏状态无法确认，请稍后重试。",
      };
    }
    return {
      enrichmentAction: action,
      enrichmentCompleted: false,
      kind: "recovery",
      summaryStatus: status,
    };
  }
  if (
    normalizedToolName === "attention_submit_content_enrichment" &&
    (current?.kind === "established" || current?.kind === "recovery") &&
    current.enrichmentAction === "generate_summary" &&
    (payload?.status === "enriched" || payload?.status === "already_enriched")
  ) {
    return { ...current, enrichmentCompleted: true };
  }
  return current;
}

export function safeCollectionReply(control: CollectionReplyControl): string {
  if (control.kind === "fixed") return control.reply;
  if (control.kind === "recovery") {
    if (control.enrichmentAction === "generate_summary") {
      return control.enrichmentCompleted ? "摘要已补全。" : "摘要仍待补全。";
    }
    if (control.enrichmentAction === "reuse_summary") {
      return "摘要已经就绪。";
    }
    return control.summaryStatus === "hidden"
      ? "摘要不可用。"
      : "摘要当前无法补全。";
  }
  const prefix =
    control.collectionStatus === "already_collected"
      ? "已在收藏中"
      : control.collectionStatus === "merged_with_existing_content"
        ? "已收藏，已合并到已有内容"
        : "已收藏";
  if (control.enrichmentAction === "reuse_summary") {
    return `${prefix}，已使用现有摘要。`;
  }
  if (control.enrichmentAction === "generate_summary") {
    return control.enrichmentCompleted
      ? `${prefix}，摘要已补全。`
      : `${prefix}，摘要待补全。`;
  }
  return `${prefix}。`;
}
