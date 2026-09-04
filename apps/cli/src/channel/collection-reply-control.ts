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
      readonly collectionId: string;
      readonly collectionStatus: EstablishedCollectionStatus;
      readonly enrichmentAction: CollectionEnrichmentAction;
      readonly enrichmentCompleted: boolean;
      readonly kind: "established";
    }
  | {
      readonly collectionId: string;
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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const UUID_IN_TEXT_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu;
const SENSITIVE_RESULT_KEYS = new Set([
  "collection_id",
  "content_id",
  "display_title",
  "original_url",
  "public_read_url",
  "resolved_url",
  "summary",
  "tags",
  "title",
]);
const MAXIMUM_SENSITIVE_FRAGMENTS = 64;
const MAXIMUM_SENSITIVE_FRAGMENT_CHARS = 512;

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

function collectionId(value: unknown): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value)
    ? value.toLowerCase()
    : null;
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
    const id = collectionId(payload.collection_id);
    return status && action && id
      ? {
          collectionId: id,
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
    const collection = record(payload.collection);
    const id = collectionId(collection?.collection_id);
    const action = enrichmentAction(content?.enrichment_action);
    const status = summaryStatus(content?.summary_status);
    const safePublicReadUrl =
      action !== "generate_summary" ||
      isAbsoluteHttpUrl(content?.public_read_url);
    if (!action || !status || !safePublicReadUrl || !id) {
      return {
        kind: "fixed",
        reply: "收藏状态无法确认，请稍后重试。",
      };
    }
    return {
      collectionId: id,
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

export type CollectionControlResult =
  | "completed"
  | "ready"
  | "retryable_incomplete"
  | "terminal"
  | "unconfirmed";

export function collectionControlResult(
  control: CollectionReplyControl,
): CollectionControlResult {
  if (control.kind === "fixed") return "unconfirmed";
  if (
    control.enrichmentAction === "generate_summary" &&
    control.enrichmentCompleted
  ) {
    return "completed";
  }
  if (control.enrichmentAction === "generate_summary") {
    return "retryable_incomplete";
  }
  if (
    control.enrichmentAction === "reuse_summary" ||
    (control.kind === "recovery" && control.summaryStatus === "ready")
  ) {
    return "ready";
  }
  return "terminal";
}

export type CollectionReplyRejectionReason =
  | "reply_contains_code_block"
  | "reply_contains_content_payload"
  | "reply_contains_email"
  | "reply_contains_sensitive_fragment"
  | "reply_contains_tool_shape"
  | "reply_contains_url"
  | "reply_contains_uuid"
  | "reply_empty"
  | "reply_missing_incomplete_truth"
  | "reply_missing_pause_state"
  | "reply_missing_retry_plan"
  | "reply_missing_terminal_state"
  | "reply_retry_queue_full"
  | "reply_too_long"
  | "reply_unconfirmed_control";

export interface SafeCollectionReplyResult {
  readonly accepted: boolean;
  readonly reason: CollectionReplyRejectionReason | null;
  readonly text: string;
}

export interface CollectionReplySafetyContext {
  readonly phase:
    | "initial_incomplete"
    | "ordinary"
    | "paused"
    | "queue_full"
    | "terminal";
  readonly sensitiveFragments: readonly string[];
}

function fallbackCollectionReply(
  control: CollectionReplyControl,
  phase: CollectionReplySafetyContext["phase"],
): string {
  if (control.kind === "fixed") return control.reply;
  if (phase === "initial_incomplete") {
    return control.kind === "established"
      ? "已收藏，但这次没有补全摘要；约 2 分钟后会自动重试。"
      : "这次没有补全摘要；约 2 分钟后会自动重试。";
  }
  if (phase === "paused") {
    return "这轮自动重试仍未补全摘要，现已暂停；你可以随时再让我重试。";
  }
  if (phase === "queue_full") {
    return control.kind === "established"
      ? "已收藏，但本地重试队列已满，暂时无法安排自动重试。"
      : "本地重试队列已满，暂时无法安排自动重试。";
  }
  if (phase === "terminal") {
    return "这项收藏当前已不再符合摘要补全条件，自动重试已停止。";
  }
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

function normalizedComparisonText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();
}

function rejectionReason(
  candidate: string,
  context: CollectionReplySafetyContext,
): CollectionReplyRejectionReason | null {
  if (context.phase === "queue_full") return "reply_retry_queue_full";
  if (!candidate) return "reply_empty";
  if (candidate.length > MAXIMUM_REPLY_CHARS) return "reply_too_long";
  if (/https?:\/\//iu.test(candidate)) return "reply_contains_url";
  if (/[\w.+-]+@[\w.-]+\.[a-z]{2,}/iu.test(candidate)) {
    return "reply_contains_email";
  }
  if (UUID_IN_TEXT_PATTERN.test(candidate)) return "reply_contains_uuid";
  if (/```/u.test(candidate)) return "reply_contains_code_block";
  if (
    /mcp__|attention_[a-z0-9_]+|(?:^|\n)\s*[\[{]|["']?(?:tool|tool_name)["']?\s*[:=]/iu.test(
      candidate,
    )
  ) {
    return "reply_contains_tool_shape";
  }
  if (/(?:标题|正文|摘要内容|标签)(?:如下|[:：])/u.test(candidate)) {
    return "reply_contains_content_payload";
  }

  const normalizedCandidate = normalizedComparisonText(candidate);
  for (const fragment of context.sensitiveFragments.slice(
    0,
    MAXIMUM_SENSITIVE_FRAGMENTS,
  )) {
    const bounded = fragment.slice(0, MAXIMUM_SENSITIVE_FRAGMENT_CHARS);
    const normalizedFragment = normalizedComparisonText(bounded);
    if (
      normalizedFragment.length >= 4 &&
      normalizedCandidate.includes(normalizedFragment)
    ) {
      return "reply_contains_sensitive_fragment";
    }
  }

  if (context.phase === "initial_incomplete") {
    if (!/(?:没|没有|未|待|无法|不能).{0,8}(?:摘要|补全)|摘要.{0,8}(?:没|未|待|无法|不能)/u.test(candidate)) {
      return "reply_missing_incomplete_truth";
    }
    if (!/(?:自动|稍后|约|大约).{0,12}重试|(?:2|两)\s*分钟/u.test(candidate)) {
      return "reply_missing_retry_plan";
    }
  }
  if (context.phase === "paused") {
    if (!/暂停/u.test(candidate)) return "reply_missing_pause_state";
    if (!/重试/u.test(candidate)) return "reply_missing_retry_plan";
  }
  if (
    context.phase === "terminal" &&
    !/(?:停止|终止|不再|不可用|无法继续)/u.test(candidate)
  ) {
    return "reply_missing_terminal_state";
  }
  return null;
}

export function safeCollectionReply(
  control: CollectionReplyControl,
  candidateReply: string,
  context: CollectionReplySafetyContext,
): SafeCollectionReplyResult {
  if (control.kind === "fixed") {
    return {
      accepted: false,
      reason: "reply_unconfirmed_control",
      text: control.reply,
    };
  }
  const candidate = candidateReply.trim();
  const reason = rejectionReason(candidate, context);
  return reason
    ? {
        accepted: false,
        reason,
        text: fallbackCollectionReply(control, context.phase),
      }
    : { accepted: true, reason: null, text: candidate };
}

export function attentionResultSensitiveFragments(
  payload: Readonly<Record<string, unknown>> | null,
): string[] {
  if (!payload) return [];
  const fragments: string[] = [];
  const seen = new Set<string>();
  const append = (value: string): void => {
    const bounded = value.trim().slice(0, MAXIMUM_SENSITIVE_FRAGMENT_CHARS);
    if (!bounded || seen.has(bounded)) return;
    seen.add(bounded);
    fragments.push(bounded);
  };
  const visit = (value: unknown, depth: number): void => {
    if (
      fragments.length >= MAXIMUM_SENSITIVE_FRAGMENTS ||
      depth > 4 ||
      value === null ||
      typeof value !== "object"
    ) {
      return;
    }
    for (const [key, nested] of Object.entries(value)) {
      if (SENSITIVE_RESULT_KEYS.has(key)) {
        if (typeof nested === "string") append(nested);
        if (Array.isArray(nested)) {
          for (const item of nested) {
            if (typeof item === "string") append(item);
          }
        }
      }
      if (nested !== null && typeof nested === "object") {
        visit(nested, depth + 1);
      }
      if (fragments.length >= MAXIMUM_SENSITIVE_FRAGMENTS) return;
    }
  };
  visit(payload, 0);
  return fragments;
}
import { MAXIMUM_REPLY_CHARS } from "./limits";
