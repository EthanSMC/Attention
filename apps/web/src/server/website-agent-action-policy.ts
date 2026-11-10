import "server-only";

import { createHash } from "node:crypto";
import { listModerationCourtCases, sql, type AttentionDatabase } from "@attention/db";
import { z } from "zod";

import { ATTENTION_TOOL_CONTRACT_VERSION, attentionToolRegistry, type AttentionToolContext, type AttentionToolName } from "./attention-tool-registry";
import { loadCollectionEffectPlan } from "./collection-effect-plan";
import { collectionReviewDetails, parseWebsiteCollectionPrepared, prepareWebsiteCollection, type WebsiteCollectionPrepared } from "./website-agent-collection-review";
import { normalizeContentEnrichmentInput } from "./content-enrichment-model";
import { parsePreparedEnrichment, prepareWebsiteEnrichment, revalidatePreparedEnrichmentInTransaction,
  websiteEnrichmentReviewDetails, type WebsiteEnrichmentPrepared } from "./website-agent-enrichment-review";
import { WebsiteSourceEvidenceError, type WebsiteEnrichmentRunIdentity, type WebsiteSourceEvidenceRun } from "./website-agent-source-evidence";
import type { AttentionTransaction } from "@attention/db";
import { getCollectionStatus } from "./collection-status-service";
import { loadPublicContents } from "./content-queries";
import { isValidTimeZone, loadDigestSettings, parseWindowStart } from "./digest-settings";

export const WEBSITE_AGENT_REVIEWED_TOOL_NAMES = ["attention_update_collection", "attention_update_digest_settings",
  "attention_report_content", "attention_cast_moderation_vote", "attention_submit_content_enrichment", "attention_collect_content", "attention_select_collection_candidate"] as const;
export type WebsiteAgentReviewedToolName = (typeof WEBSITE_AGENT_REVIEWED_TOOL_NAMES)[number];

/** Every canonical tool has an explicit transport policy. A new tool must be classified here. */
export const websiteAgentToolPolicy = {
  attention_get_my_account: "read", attention_get_membership_status: "read", attention_list_collections: "read",
  attention_get_collection_status: "read", attention_list_public_content: "read", attention_search_content: "read",
  attention_get_digest_settings: "read", attention_list_moderation_cases: "read",
  attention_read_collection_source: "source_read_consent",
  attention_collect_content: "private_original_collect_or_review_required",
  attention_select_collection_candidate: "candidate_review_required",
  attention_submit_content_enrichment: "reviewed_action",
  attention_update_collection: "reviewed_action", attention_update_digest_settings: "reviewed_action",
  attention_report_content: "reviewed_action", attention_cast_moderation_vote: "reviewed_action",
} as const satisfies Record<AttentionToolName, string>;

export type WebsiteAgentActionPolicyErrorCode = "action_not_supported" | "action_invalid_proposal" |
  "action_target_unavailable" | "action_target_changed" | "action_contract_changed" | "action_delivery_recipient_required" | "permission_revoked";
export class WebsiteAgentActionPolicyError extends Error {
  constructor(readonly code: WebsiteAgentActionPolicyErrorCode) { super(code); this.name = "WebsiteAgentActionPolicyError"; }
}

const scopes: Record<WebsiteAgentReviewedToolName, readonly string[]> = {
  attention_submit_content_enrichment: ["collection:write"],
  attention_collect_content: ["collection:write"], attention_select_collection_candidate: ["collection:write"],
  attention_update_collection: ["collection:write"], attention_update_digest_settings: ["digest:write"],
  attention_report_content: ["moderation:write"], attention_cast_moderation_vote: ["moderation:court:vote"],
};
const reviewSchema = z.object({ title: z.string().min(1).max(200),
  details: z.array(z.object({ label: z.string().min(1).max(100), value: z.string().max(4_096) }).strict()).min(1).max(16),
  consequences: z.array(z.string().min(1).max(1_000)).min(1).max(6),
}).strict();
export type WebsiteAgentActionReview = z.infer<typeof reviewSchema>;
const proposalSchema = z.object({ version: z.literal(1), toolName: z.enum(WEBSITE_AGENT_REVIEWED_TOOL_NAMES),
  contractVersion: z.string().min(1).max(32), arguments: z.record(z.string(), z.unknown()),
  argumentsHash: z.string().regex(/^[0-9a-f]{64}$/u), targetFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  prepared: z.unknown().optional(),
  requiredScopes: z.array(z.string().min(1).max(64)).min(1).max(4), review: reviewSchema,
}).strict();
export type WebsiteAgentActionProposal = Omit<z.infer<typeof proposalSchema>, "prepared"> & { prepared?: WebsiteCollectionPrepared | WebsiteEnrichmentPrepared };

export function stableWebsiteActionJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableWebsiteActionJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${stableWebsiteActionJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function websiteActionFingerprint(namespace: string, value: unknown): string {
  return createHash("sha256").update(`attention:website-action:${namespace}:v1\0`).update(stableWebsiteActionJson(value)).digest("hex");
}
function reviewedName(value: string): WebsiteAgentReviewedToolName {
  if (!WEBSITE_AGENT_REVIEWED_TOOL_NAMES.includes(value as WebsiteAgentReviewedToolName)) throw new WebsiteAgentActionPolicyError("action_not_supported");
  return value as WebsiteAgentReviewedToolName;
}
export function websiteAgentActionInputSchema(toolName: WebsiteAgentReviewedToolName): z.ZodObject {
  if (toolName === "attention_select_collection_candidate") return z.object({ attempt_id: z.string().uuid(), candidate_id: z.string().uuid(), visibility: z.enum(["public", "private"]) }).strict();
  const definition = attentionToolRegistry.find(tool => tool.name === toolName)!;
  // A model-provided flag or client metadata is never evidence of human approval.
  return definition.inputSchema.omit(toolName === "attention_report_content" || toolName === "attention_cast_moderation_vote"
    ? { client_context: true, explicit_confirmation: true } : { client_context: true });
}
function normalizeArguments(toolName: WebsiteAgentReviewedToolName, rawInput: unknown): Record<string, unknown> {
  if (toolName === "attention_submit_content_enrichment") return normalizeContentEnrichmentInput(rawInput);
  const input = websiteAgentActionInputSchema(toolName).parse(rawInput) as Record<string, unknown>;
  if (toolName === "attention_report_content") {
    input.reason_code = String(input.reason_code).toLowerCase();
    input.details = typeof input.details === "string" ? input.details.normalize("NFKC").trim() || null : null;
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(String(input.reason_code)) || String(input.details ?? "").length > 2_000)
      throw new WebsiteAgentActionPolicyError("action_invalid_proposal");
  }
  if (toolName === "attention_update_digest_settings") {
    const domains = input.domain_slugs as string[];
    const start = parseWindowStart(String(input.window_start));
    if (new Set(domains).size !== domains.length || domains.some(slug => !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(slug)) ||
      !isValidTimeZone(String(input.timezone)) || start === null || start + Number(input.window_minutes) > 1440)
      throw new WebsiteAgentActionPolicyError("action_invalid_proposal");
    input.domain_slugs = [...domains].sort();
  }
  return input;
}
export function websiteAgentActionArgumentsHash(toolName: WebsiteAgentReviewedToolName, args: Record<string, unknown>,
  contractVersion = ATTENTION_TOOL_CONTRACT_VERSION): string {
  return websiteActionFingerprint("arguments", { toolName, contractVersion, arguments: args });
}

/** Pure envelope validation. Does not access the database, environment, provider, or source reader. */
export function parseWebsiteAgentActionProposal(value: unknown): WebsiteAgentActionProposal {
  try {
    const parsed = proposalSchema.parse(value);
    const normalized = normalizeArguments(parsed.toolName, parsed.arguments);
    const enrichment = parsed.toolName === "attention_submit_content_enrichment";
    const collection = parsed.toolName === "attention_collect_content" || parsed.toolName === "attention_select_collection_candidate";
    const prepared = parsed.prepared === undefined ? undefined : enrichment
      ? parsePreparedEnrichment(parsed.prepared) : parseWebsiteCollectionPrepared(parsed.prepared);
    if ((collection || enrichment) !== Boolean(prepared)) throw new Error("invalid_proposal");
    if (prepared?.kind === "enrichment") {
      if (!enrichment || stableWebsiteActionJson(prepared.plan.input) !== stableWebsiteActionJson(normalized) ||
          stableWebsiteActionJson(websiteEnrichmentReviewDetails(prepared)) !== stableWebsiteActionJson(parsed.review) ||
          parsed.targetFingerprint !== websiteActionFingerprint("enrichment-target", prepared)) throw new Error("invalid_proposal");
    } else if (prepared) {
      if (stableWebsiteActionJson(collectionReviewDetails(prepared)) !== stableWebsiteActionJson(parsed.review) ||
          parsed.targetFingerprint !== websiteActionFingerprint("collection-target", prepared)) throw new Error("invalid_proposal");
      if (prepared.kind === "collection" && (prepared.pending ? parsed.toolName !== "attention_select_collection_candidate" ||
          prepared.pending.attemptId !== parsed.arguments.attempt_id || prepared.pending.candidateId !== parsed.arguments.candidate_id :
          parsed.toolName !== "attention_collect_content" || prepared.attemptInput!.raw_input !== parsed.arguments.input || prepared.attemptInput!.idempotency_key !== parsed.arguments.idempotency_key)) throw new Error("invalid_proposal");
      if ((prepared.kind === "candidate_options" ? prepared.visibility : prepared.plan.requestedVisibility) !== parsed.arguments.visibility) throw new Error("invalid_proposal");
    }
    if (Buffer.byteLength(stableWebsiteActionJson(parsed), "utf8") > 40_000 || stableWebsiteActionJson(normalized) !== stableWebsiteActionJson(parsed.arguments) ||
      parsed.argumentsHash !== websiteAgentActionArgumentsHash(parsed.toolName, normalized, parsed.contractVersion) ||
      stableWebsiteActionJson(parsed.requiredScopes) !== stableWebsiteActionJson(scopes[parsed.toolName])) throw new Error("invalid_proposal");
    return { ...parsed, ...(prepared ? { prepared } : {}) } as WebsiteAgentActionProposal;
  } catch { throw new WebsiteAgentActionPolicyError("action_invalid_proposal"); }
}

export interface WebsiteAgentActionPolicyDependencies {
  getCollectionStatus: typeof getCollectionStatus;
  loadDigestSettings: typeof loadDigestSettings;
  loadPublicContents: typeof loadPublicContents;
  listModerationCourtCases: typeof listModerationCourtCases;
  loadPublicContentVersion(db: AttentionDatabase, publicContentId: string): Promise<{ revision: string; sourceFingerprint: string }>;
  loadDigestDeliveryRecipient(db: AttentionDatabase, accountId: string): Promise<{ email: string | null; verified: boolean }>;
  now(): Date;
}
async function loadDigestDeliveryRecipient(db: AttentionDatabase, accountId: string): Promise<{ email: string | null; verified: boolean }> {
  // Match the digest worker's actual delivery account, without loading password
  // state or other account fields. This value belongs only in the user's review.
  const [row] = await db.execute<{ email: string | null; verified: boolean }>(sql`select primary_email as email,
    email_verified_at is not null as verified from accounts where id = ${accountId}::uuid and status = 'active' limit 1`);
  if (!row || (row.email !== null && typeof row.email !== "string") || typeof row.verified !== "boolean")
    throw new WebsiteAgentActionPolicyError("action_target_unavailable");
  return { email: row.email, verified: row.verified };
}
async function loadPublicContentVersion(db: AttentionDatabase, publicContentId: string): Promise<{ revision: string; sourceFingerprint: string }> {
  const [row] = await db.execute<{ revision: string; source: string }>(sql`select updated_at::text as revision, outbound_url as source
    from contents where public_id = ${publicContentId}::uuid limit 1`);
  if (!row || typeof row.revision !== "string" || typeof row.source !== "string") throw new WebsiteAgentActionPolicyError("action_target_unavailable");
  return { revision: row.revision, sourceFingerprint: websiteActionFingerprint("public-source", row.source) };
}
const defaults: WebsiteAgentActionPolicyDependencies = { getCollectionStatus, loadDigestSettings, loadPublicContents,
  listModerationCourtCases, loadPublicContentVersion, loadDigestDeliveryRecipient, now: () => new Date() };
function assertAccess(context: AttentionToolContext, name: WebsiteAgentReviewedToolName, input: Record<string, unknown>): void {
  context.signal.throwIfAborted();
  if (context.caller.credentialKind !== "session" || context.caller.entrypoint !== "hosted_agent" || !context.isMember ||
    !scopes[name].every(scope => context.scopes.includes(scope)) ||
    ((name === "attention_cast_moderation_vote" || ((name === "attention_update_collection" || name === "attention_collect_content" || name === "attention_select_collection_candidate") && input.visibility === "public")) && !context.isFilter))
    throw new WebsiteAgentActionPolicyError("permission_revoked");
}

export async function prepareWebsiteAgentAction(context: AttentionToolContext, toolName: string, rawInput: unknown,
  dependencies: WebsiteAgentActionPolicyDependencies = defaults, evidenceRun?: WebsiteSourceEvidenceRun): Promise<WebsiteAgentActionProposal> {
  const name = reviewedName(toolName);
  let args: Record<string, unknown>;
  try { args = normalizeArguments(name, rawInput); }
  catch { throw new WebsiteAgentActionPolicyError("action_invalid_proposal"); }
  assertAccess(context, name, args);
  const db = context.getDatabase();
  let target: unknown, review: WebsiteAgentActionReview;
  if (name === "attention_submit_content_enrichment") {
    if (!evidenceRun) throw new WebsiteSourceEvidenceError("source_evidence_required");
    const { prepared } = await prepareWebsiteEnrichment(context, args, evidenceRun);
    return preparedWebsiteEnrichmentProposal(prepared);
  } else if (name === "attention_collect_content") {
    try {
      const prepared = await prepareWebsiteCollection(context, args);
      return preparedWebsiteCollectionProposal(name, args, prepared);
    } catch (error) {
      if (error instanceof WebsiteAgentActionPolicyError) throw error;
      throw new WebsiteAgentActionPolicyError(error instanceof Error && error.message === "permission_revoked" ? "permission_revoked" : "action_target_unavailable");
    }
  } else if (name === "attention_select_collection_candidate") {
    // Only the human candidate endpoint can construct this exact proposal from
    // the already durable server-owned choice set. The model cannot choose it.
    throw new WebsiteAgentActionPolicyError("action_not_supported");
  } else if (name === "attention_update_collection") {
    const status = await dependencies.getCollectionStatus(db, context, { collection_id: args.collection_id });
    if (!status.collection || !status.content || status.collection.collection_status !== "active") throw new WebsiteAgentActionPolicyError("action_target_unavailable");
    target = { collection: status.collection, content: status.content };
    review = { title: "更改收藏可见性", details: [
      { label: "收藏", value: status.content.title ?? String(args.collection_id) }, { label: "收藏 ID", value: String(args.collection_id) },
      { label: "当前可见性", value: status.collection.visibility }, { label: "新可见性", value: String(args.visibility) },
    ], consequences: [args.visibility === "public"
      ? "这会将此收藏设为公开。符合公开条件时，内容和你的公开收藏者身份可被其他人发现。"
      : "这会将你的此条收藏设为私密；不会删除其他人的公开收藏，也无法撤回他人已经看到的内容。"] };
  } else if (name === "attention_update_digest_settings") {
    const settings = await dependencies.loadDigestSettings(db, context.accountId);
    const recipient = await dependencies.loadDigestDeliveryRecipient(db, context.accountId);
    if (args.enabled && (!recipient.email || !recipient.verified)) throw new WebsiteAgentActionPolicyError("action_delivery_recipient_required");
    if ((args.domain_slugs as string[]).some(slug => !settings.domains.some(domain => domain.slug === slug)))
      throw new WebsiteAgentActionPolicyError("action_target_unavailable");
    target = { settings, recipient };
    review = { title: "更改摘要推送设置", details: [
      { label: "收件邮箱", value: recipient.email ? `${recipient.email}${recipient.verified ? "" : "（未验证）"}` : "尚未设置" },
      { label: "推送", value: args.enabled ? "启用" : "停用" }, { label: "主题", value: (args.domain_slugs as string[]).join(", ") || "无" },
      { label: "时区", value: String(args.timezone) }, { label: "开始时间", value: String(args.window_start) },
      { label: "投递窗口（分钟）", value: String(args.window_minutes) },
    ], consequences: ["这会替换当前摘要偏好。启用后，系统可按所选主题、时区和时间窗口持续发送摘要，直到再次更改或停用。"] };
  } else if (name === "attention_report_content") {
    const content = (await dependencies.loadPublicContents(db)).find(item => item.id === args.public_content_id);
    if (!content) throw new WebsiteAgentActionPolicyError("action_target_unavailable");
    target = { id: content.id, title: content.title, source: content.source, summary: content.summary, outboundHref: content.outboundHref,
      version: await dependencies.loadPublicContentVersion(db, content.id) };
    review = { title: "举报公开内容", details: [
      { label: "内容", value: content.title }, { label: "公开内容 ID", value: content.id },
      { label: "来源", value: content.source }, { label: "原文链接", value: new URL(`/out/public/${content.id}`, context.serviceOrigin).href },
      { label: "原因", value: String(args.reason_code) }, { label: "举报说明", value: String(args.details ?? "无") },
    ], consequences: ["举报会提交给社区审核，可能触发审核案件或影响此内容的公开展示。此操作不会自动投票；已提交的举报不能通过本工具撤回。"] };
  } else {
    const item = (await dependencies.listModerationCourtCases(db, { accountId: context.accountId })).find(item => item.id === args.case_id);
    if (!item || item.status !== "open" || item.votingEndsAt <= dependencies.now() || (item.myVote !== null && item.myVote !== args.decision))
      throw new WebsiteAgentActionPolicyError("action_target_unavailable");
    target = { id: item.id, publicContentId: item.publicContentId, title: item.title, source: item.source, status: item.status,
      communityStatus: item.communityStatus, openedAt: item.openedAt.toISOString(), votingEndsAt: item.votingEndsAt.toISOString(), myVote: item.myVote,
      version: await dependencies.loadPublicContentVersion(db, item.publicContentId) };
    review = { title: "提交不可更改的审核投票", details: [
      { label: "内容", value: item.title ?? item.publicContentId }, { label: "案件 ID", value: item.id },
      { label: "来源", value: item.source },
      { label: "原文链接", value: item.outboundHref ? new URL(`/out/court/${item.id}`, context.serviceOrigin).href : "当前原文链接不可用" },
      { label: "决定", value: args.decision === "hidden" ? "隐藏" : "公开" }, { label: "投票截止", value: item.votingEndsAt.toISOString() },
    ], consequences: ["这会以你的 Filter 身份对这个案件投票，并可能影响内容的公开可见性。投票提交后不可更改或撤回。"] };
  }
  context.signal.throwIfAborted();
  return parseWebsiteAgentActionProposal({ version: 1, toolName: name, contractVersion: ATTENTION_TOOL_CONTRACT_VERSION,
    arguments: args, argumentsHash: websiteAgentActionArgumentsHash(name, args), requiredScopes: [...scopes[name]],
    targetFingerprint: websiteActionFingerprint("target", { reviewVersion: 1, toolName: name, target }), review });
}

export async function revalidateWebsiteAgentAction(context: AttentionToolContext, rawProposal: WebsiteAgentActionProposal,
  dependencies: WebsiteAgentActionPolicyDependencies = defaults, enrichmentIdentity?: WebsiteEnrichmentRunIdentity): Promise<void> {
  const proposal = parseWebsiteAgentActionProposal(rawProposal);
  if (proposal.contractVersion !== ATTENTION_TOOL_CONTRACT_VERSION) throw new WebsiteAgentActionPolicyError("action_contract_changed");
  if (proposal.prepared) {
    assertAccess(context, proposal.toolName, proposal.arguments);
    if (proposal.prepared.kind === "enrichment") {
      if (!enrichmentIdentity || enrichmentIdentity.accountId !== context.accountId || enrichmentIdentity.authSessionId !== context.caller.credentialId)
        throw new WebsiteAgentActionPolicyError("permission_revoked");
      await revalidatePreparedEnrichmentInTransaction(context.getDatabase() as AttentionTransaction, proposal.prepared, enrichmentIdentity, dependencies.now);
      return;
    }
    if (proposal.prepared.kind !== "collection") throw new WebsiteAgentActionPolicyError("action_target_unavailable");
    const plan = proposal.prepared.plan;
    if (plan.accountId !== context.accountId || (plan.effects.resultingVisibility === "public" && !context.isFilter)) throw new WebsiteAgentActionPolicyError("permission_revoked");
    const currentPlan = await loadCollectionEffectPlan(context.getDatabase(), context.accountId, plan.candidate, plan.requestedVisibility);
    if (currentPlan.digest !== plan.digest) throw new WebsiteAgentActionPolicyError("action_target_changed");
    return;
  }
  const current = await prepareWebsiteAgentAction(context, proposal.toolName, proposal.arguments, dependencies);
  if (current.argumentsHash !== proposal.argumentsHash || current.targetFingerprint !== proposal.targetFingerprint)
    throw new WebsiteAgentActionPolicyError("action_target_changed");
}

/** Called only with server-prepared artifacts, never client/model approval flags. */
export function preparedWebsiteCollectionProposal(toolName: "attention_collect_content" | "attention_select_collection_candidate",
  args: Record<string, unknown>, prepared: WebsiteCollectionPrepared): WebsiteAgentActionProposal {
  const arguments_ = normalizeArguments(toolName, args);
  return parseWebsiteAgentActionProposal({ version: 1, toolName, contractVersion: ATTENTION_TOOL_CONTRACT_VERSION,
    arguments: arguments_, argumentsHash: websiteAgentActionArgumentsHash(toolName, arguments_),
    targetFingerprint: websiteActionFingerprint("collection-target", prepared), requiredScopes: scopes[toolName],
    prepared, review: collectionReviewDetails(prepared) });
}

/** Provenance is the current server-owned reader run, never model flags. */
export function preparedWebsiteEnrichmentProposal(raw: WebsiteEnrichmentPrepared): WebsiteAgentActionProposal {
  const prepared = parsePreparedEnrichment(raw), toolName = "attention_submit_content_enrichment";
  const args = normalizeArguments(toolName, prepared.plan.input);
  return parseWebsiteAgentActionProposal({ version: 1, toolName, contractVersion: ATTENTION_TOOL_CONTRACT_VERSION,
    arguments: args, argumentsHash: websiteAgentActionArgumentsHash(toolName, args),
    targetFingerprint: websiteActionFingerprint("enrichment-target", prepared), requiredScopes: scopes[toolName],
    prepared, review: websiteEnrichmentReviewDetails(prepared) });
}
