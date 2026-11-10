import "server-only";

import { z } from "zod";
import { setAccountContext } from "@attention/db";
import type { AttentionToolContext } from "./attention-tool-registry";
import { collectionPlanCanonical, collectionPlanDigest, loadCollectionEffectPlan, parseCollectionEffectPlan,
  type CollectionEffectPlan } from "./collection-effect-plan";
import { collectRequestSchema, loadPendingCandidateForReview, parsePendingCandidateBinding, prepareSelectionFromResolved, resolveCollectionInput,
  type PendingCandidateForReview, type PendingCandidateBinding } from "./collection-service";

const candidateOptionSchema = z.object({ candidateId: z.string().uuid(), url: z.string().url().max(4096),
  displayHost: z.string().min(1).max(255), source: z.string().min(1).max(64), contentType: z.string().min(1).max(64) }).strict();
export type WebsiteCandidateOption = z.infer<typeof candidateOptionSchema>;
const choicesSchema = z.object({ kind: z.literal("candidate_options"), attemptId: z.string().uuid(),
  visibility: z.enum(["public", "private"]), options: z.array(candidateOptionSchema).min(2).max(16),
  pendingId: z.string().uuid(), tokenHash: z.string().regex(/^[a-f0-9]{64}$/u), vaultDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  expiresAt: z.iso.datetime() }).strict();
export type WebsiteCandidateChoices = z.infer<typeof choicesSchema>;
export type WebsitePreparedCollection = { kind: "collection"; plan: CollectionEffectPlan;
  attemptInput?: z.infer<typeof collectRequestSchema>; pending?: PendingCandidateBinding };
export type WebsiteCollectionPrepared = WebsiteCandidateChoices | WebsitePreparedCollection;

function unavailable(code = "action_target_changed"): never { throw new Error(code); }
export function parseWebsiteCollectionPrepared(value: unknown): WebsiteCollectionPrepared {
  if (!value || typeof value !== "object" || Buffer.byteLength(JSON.stringify(value)) > 32_000) return unavailable("action_invalid_proposal");
  if ((value as { kind?: unknown }).kind === "candidate_options") {
    const choices = choicesSchema.parse(value);
    if (new Set(choices.options.map(option => option.candidateId)).size !== choices.options.length) return unavailable("action_invalid_proposal");
    return choices;
  }
  const parsed = z.object({ kind: z.literal("collection"), plan: z.unknown(), attemptInput: collectRequestSchema.optional(), pending: z.unknown().optional() }).strict().parse(value);
  const plan = parseCollectionEffectPlan(parsed.plan);
  if (Boolean(parsed.attemptInput) === Boolean(parsed.pending)) return unavailable("action_invalid_proposal");
  const pending = parsed.pending ? parsePendingCandidateBinding(parsed.pending) : undefined;
  if (pending && (!pending.candidateId || pending.visibility !== plan.requestedVisibility)) return unavailable("action_invalid_proposal");
  if (parsed.attemptInput && parsed.attemptInput.visibility !== plan.requestedVisibility) return unavailable("action_invalid_proposal");
  return { kind: "collection", plan, ...(parsed.attemptInput ? { attemptInput: parsed.attemptInput } : {}), ...(pending ? { pending } : {}) };
}

export function collectionReviewDetails(prepared: WebsiteCollectionPrepared) {
  if (prepared.kind === "candidate_options") return { title: "选择要收藏的来源", details: [
    { label: "请求可见性", value: prepared.visibility }, { label: "候选数量", value: String(prepared.options.length) },
    { label: "选择有效至", value: prepared.expiresAt },
  ], consequences: ["选择只会准备这一来源的具体操作确认，不会收藏或发布内容。请在下一张卡片核对来源、公开身份、恢复及合并后果后再确认。"] };
  const { plan } = prepared, effects = plan.effects;
  const current = plan.snapshot.collections.map(row => `${row.id}: content=${row.contentId}; status=${row.collectionStatus}; visibility=${row.visibility}; moderation=${row.moderationStatus}; domain=${row.domainId}`);
  return { title: "确认收藏来源与全部影响", details: [
    { label: "选择的原始链接", value: plan.candidate.selectedUrl },
    { label: "解析后来源", value: plan.candidate.observedUrl },
    { label: "规范链接", value: plan.candidate.identity.normalizedUrl },
    { label: "收藏实际原文跳转链接", value: effects.resultingOutboundUrl },
    { label: "来源身份", value: `${plan.candidate.identity.adapter} · ${plan.candidate.identity.contentType} · ${plan.candidate.identity.dedupeKey} · resolution=${plan.candidate.resolutionStatus}` },
    { label: "目标", value: `${effects.targetDisposition}; content=${effects.targetContentId ?? "新内容"}; collection=${effects.targetCollectionId ?? "新收藏"}` },
    { label: "最终可见性 / 审核 / 主题", value: `${effects.resultingVisibility} / ${effects.resultingModeration} / ${effects.resultingDomainId}（请求 ${plan.requestedVisibility}）` },
    { label: "当前收藏状态", value: current.join("\n") || "没有已有收藏" },
    { label: "身份与别名映射（含未存在项）", value: [plan.candidate.identity, ...plan.candidate.aliasIdentities].map(identity => {
      const existing = plan.snapshot.identities.find(row => row.dedupeKey === identity.dedupeKey);
      return `${identity.normalizedUrl} · ${identity.dedupeKey}: ${existing ? `content=${existing.contentId}; active=${existing.active}` : "未存在，将关联到目标内容"}`;
    }).join("\n") },
    { label: "已有内容别名关系", value: plan.snapshot.aliases.map(row => `${row.aliasContentId} → ${row.primaryContentId}; active=${row.active}`).join("\n") || "无" },
    { label: "本次共享别名映射", value: effects.pendingAliasContentIds.map(aliasId => {
      const linked = plan.snapshot.aliases.some(row => row.aliasContentId === aliasId && row.primaryContentId === effects.targetContentId && row.active === true);
      return `${aliasId} → ${effects.targetContentId ?? "本次新建内容"}: ${linked ? "保留已有映射" : "新建共享映射"}`;
    }).join("\n") || "无" },
    { label: "恢复或新建的别名收藏", value: Object.entries(effects.aliasCollectionDispositions).map(([id, status]) => `${id}: ${status}`).join("\n") || "无" },
    { label: "合并后删除的收藏", value: effects.mergedCollectionIds.join("\n") || "无" },
    { label: "新建后立即合并删除的别名收藏", value: effects.mergedNewAliasContentIds.join("\n") || "无" },
    { label: "共享原文链接变更", value: effects.sharedOutboundChange ? `将共享链接更新为 ${plan.candidate.outboundUrl}` : "无" },
    { label: "元数据任务", value: effects.metadataJob === "schedule" ? "提交后台元数据抓取任务" : "已有任务，不重复创建" },
  ], consequences: [
    effects.resultingVisibility === "public" ? "最终收藏为公开，包括因已有公开收藏合并而保持公开的情况。符合公开条件时，来源内容和你的公开收藏者身份可被其他人发现。" : "最终收藏为私密。已有共享内容及他人的公开收藏不因此删除。",
    "将按上述状态新建、复用或恢复收藏；恢复会以本次时间重新记录收藏及公开时间。列出的合并收藏将软删除，并采用本次参与合并的收藏中的最早时间；已屏蔽状态不会被合并解除。",
    effects.sharedOutboundChange ? "共享原文链接变更会影响同一内容的其他收藏者。" : "没有列出的共享原文链接变更不会执行。",
    "列出的本次共享别名映射会影响其他用户今后对这些来源身份的解析，不只是合并你自己的收藏。未列出的共享映射不会执行。",
    "系统会记录来源链接和收藏事件，并按上述计划处理元数据任务。收藏成功不代表已读取正文或完成摘要。来源或影响变化时，本确认失效，不会自动重试。",
  ] };
}

async function withOwner<T>(context: AttentionToolContext, run: (db: ReturnType<AttentionToolContext["getDatabase"]>) => Promise<T>): Promise<T> {
  // A short SELECT-only snapshot transaction, after all external resolution.
  return context.getDatabase().transaction(async tx => { await setAccountContext(tx, context.accountId); return run(tx); });
}
export async function prepareWebsiteCollection(context: AttentionToolContext, args: Record<string, unknown>): Promise<WebsiteCollectionPrepared> {
  const input = collectRequestSchema.parse({ idempotency_key: args.idempotency_key, raw_input: args.input, visibility: args.visibility });
  const resolved = await resolveCollectionInput(input.raw_input, { signal: context.signal, revalidate: async () => {
    if (context.revalidate && !await context.revalidate()) return unavailable("permission_revoked");
  } });
  if (resolved.status !== "resolved" || resolved.candidates.length === 0) return unavailable("action_target_unavailable");
  if (resolved.candidates.length > 1) {
    const response = await prepareSelectionFromResolved(context.getDatabase(), context, input, resolved);
    if (response.status !== "ambiguous") return unavailable("action_target_changed");
    const pending = await withOwner(context, db => loadPendingCandidateForReview(db, context.accountId, { attemptId: response.attempt_id }));
    return choicesFromPending(pending);
  }
  const plan = await withOwner(context, db => loadCollectionEffectPlan(db, context.accountId, resolved.candidates[0]!, input.visibility));
  if (plan.effects.resultingVisibility === "public" && !context.isFilter) return unavailable("permission_revoked");
  return parseWebsiteCollectionPrepared({ kind: "collection", plan, attemptInput: input });
}

function choicesFromPending(pending: PendingCandidateForReview): WebsiteCandidateChoices {
  return choicesSchema.parse({ kind: "candidate_options", attemptId: pending.attemptId, visibility: pending.visibility,
    pendingId: pending.pendingId, tokenHash: pending.tokenHash, vaultDigest: pending.vaultDigest, expiresAt: pending.expiresAt,
    options: pending.candidates.map(candidate => ({ candidateId: candidate.candidateId, url: candidate.url,
      displayHost: candidate.displayHost, source: candidate.source, contentType: candidate.contentType })) });
}
export async function prepareWebsiteCandidateChoice(context: AttentionToolContext, choices: WebsiteCandidateChoices, candidateId: string): Promise<WebsitePreparedCollection> {
  if (!choices.options.some(option => option.candidateId === candidateId)) return unavailable("action_target_unavailable");
  const pending = await withOwner(context, db => loadPendingCandidateForReview(db, context.accountId, { attemptId: choices.attemptId, candidateId, visibility: choices.visibility }));
  if (collectionPlanCanonical(choicesFromPending(pending)) !== collectionPlanCanonical(choices)) return unavailable();
  const selected = pending.candidates.find(candidate => candidate.candidateId === candidateId)!;
  const resolved = await resolveCollectionInput(selected.url, { signal: context.signal, revalidate: async () => {
    if (context.revalidate && !await context.revalidate()) return unavailable("permission_revoked");
  } });
  if (resolved.status !== "resolved" || resolved.candidates.length !== 1 || resolved.candidates[0]!.identity.dedupeKey !== selected.dedupeKey || resolved.candidates[0]!.identity.adapter !== selected.source) return unavailable();
  const plan = await withOwner(context, db => loadCollectionEffectPlan(db, context.accountId, resolved.candidates[0]!, choices.visibility));
  if (plan.effects.resultingVisibility === "public" && !context.isFilter) return unavailable("permission_revoked");
  const binding: PendingCandidateBinding = { attemptId: pending.attemptId, pendingId: pending.pendingId,
    tokenHash: pending.tokenHash, vaultDigest: pending.vaultDigest, visibility: pending.visibility, expiresAt: pending.expiresAt, candidateId };
  return parseWebsiteCollectionPrepared({ kind: "collection", plan, pending: binding }) as WebsitePreparedCollection;
}

export interface WebsiteCollectionPreflight { preparedDigest: string; selectionToken?: string }
/** Fetcher is called only before acquiring action authority/target locks. */
export async function reResolveWebsiteCollection(context: AttentionToolContext, prepared: WebsiteCollectionPrepared): Promise<WebsiteCollectionPreflight> {
  if (prepared.kind !== "collection") return unavailable("candidate_selection_required");
  const resolved = await resolveCollectionInput(prepared.plan.candidate.selectedUrl, { signal: context.signal, revalidate: async () => {
    if (context.revalidate && !await context.revalidate()) return unavailable("permission_revoked");
  } });
  if (resolved.status !== "resolved" || resolved.candidates.length !== 1 || collectionPlanCanonical(resolved.candidates[0]) !== collectionPlanCanonical(prepared.plan.candidate)) return unavailable();
  if (prepared.pending) {
    const pending = await withOwner(context, db => loadPendingCandidateForReview(db, context.accountId, { attemptId: prepared.pending!.attemptId,
      candidateId: prepared.pending!.candidateId!, visibility: prepared.pending!.visibility }));
    const binding = { attemptId: pending.attemptId, pendingId: pending.pendingId, tokenHash: pending.tokenHash,
      vaultDigest: pending.vaultDigest, visibility: pending.visibility, expiresAt: pending.expiresAt, candidateId: pending.candidateId };
    if (collectionPlanCanonical(binding) !== collectionPlanCanonical(prepared.pending)) return unavailable();
    return { preparedDigest: collectionPlanDigest(prepared), selectionToken: pending.selectionToken };
  }
  return { preparedDigest: collectionPlanDigest(prepared) };
}
