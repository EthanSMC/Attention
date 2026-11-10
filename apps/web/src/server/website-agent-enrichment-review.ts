import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import type { AttentionTransaction } from "@attention/db";
import type { AttentionToolContext, AttentionToolCoreDependencies } from "./attention-tool-registry";
import { applyPreparedContentEnrichment } from "./content-enrichment-service";
import { normalizeContentEnrichmentInput } from "./content-enrichment-model";
import { contentEnrichmentPlanSchema, enrichmentHash, enrichmentStableJson, loadContentEnrichmentPlan,
  lockAndRevalidateContentEnrichmentPlan, parseContentEnrichmentPlan, type ContentEnrichmentPlan } from "./content-enrichment-plan";
import { assertWebsiteSourceAttestation, parseWebsiteSourceAttestation, websiteSourceAttestationSchema,
  type WebsiteEnrichmentRunIdentity, type WebsiteSourceEvidenceRun } from "./website-agent-source-evidence";
import { sourceReadIdentity } from "./collection-source-reader";
import { getCollectionStatus } from "./collection-status-service";

const preparedSchema = z.object({ kind: z.literal("enrichment"), version: z.literal(1), plan: contentEnrichmentPlanSchema,
  evidence: websiteSourceAttestationSchema, expiresAt: z.iso.datetime(), bindingHash: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
export type WebsiteEnrichmentPrepared = z.infer<typeof preparedSchema>;
export interface EnrichmentReview { title: string; details: Array<{label: string; value: string}>; consequences: string[] }
export class WebsiteEnrichmentReviewError extends Error {
  constructor(readonly code: "enrichment_review_invalid" | "enrichment_source_changed" | "enrichment_permission_revoked") {
    super(code); this.name = "WebsiteEnrichmentReviewError";
  }
}
function bind(plan: ContentEnrichmentPlan, evidence: WebsiteEnrichmentPrepared["evidence"]): string {
  return enrichmentHash("evidence-binding", { planFingerprint: plan.fingerprint, input: plan.input, evidence });
}
export function parsePreparedEnrichment(value: unknown): WebsiteEnrichmentPrepared {
  try {
    const prepared = preparedSchema.parse(value), plan = parseContentEnrichmentPlan(prepared.plan), evidence = parseWebsiteSourceAttestation(prepared.evidence);
    const operation = createHash("sha256").update(JSON.stringify([plan.snapshot.ownedCollection.id,
      plan.snapshot.ownedCollection.updatedAt, plan.snapshot.owned.id, plan.snapshot.owned.updatedAt,
      plan.snapshot.owned.source, evidence.sourceUrl])).digest("hex");
    if (Buffer.byteLength(JSON.stringify(prepared)) > 40_000 || evidence.accountId !== plan.snapshot.accountId ||
        evidence.contentId !== plan.input.content_id || evidence.collectionId !== plan.snapshot.ownedCollection.id ||
        evidence.finalPublicUrl !== plan.input.resolved_url || evidence.sourceUrl !== new URL(plan.snapshot.owned.outboundUrl).toString() ||
        evidence.operation !== operation ||
        prepared.expiresAt !== evidence.expiresAt || prepared.bindingHash !== bind(plan, evidence)) throw new Error("mismatch");
    return { ...prepared, plan, evidence };
  } catch { throw new WebsiteEnrichmentReviewError("enrichment_review_invalid"); }
}
export function websiteEnrichmentReviewDetails(raw: WebsiteEnrichmentPrepared): EnrichmentReview {
  const { plan, evidence } = parsePreparedEnrichment(raw), { input, effects, snapshot } = plan;
  const merging = effects.softDeleteCollectionId !== null;
  return { title: effects.writeSharedSummary ? "提交共享内容摘要" : "合并收藏并沿用已有共享摘要", details: [
    { label: "原收藏", value: `${snapshot.owned.title ?? snapshot.owned.id} (${snapshot.ownedCollection.id})` },
    { label: "读取来源", value: evidence.sourceUrl }, { label: "最终来源链接", value: input.resolved_url },
    { label: "目标内容", value: `${snapshot.winner.title ?? snapshot.winner.id} (${snapshot.winner.id})` },
    { label: "拟提交标题", value: input.title }, { label: "拟提交摘要", value: input.summary },
    { label: "规范化标签", value: input.tags.join(", ") },
    { label: "摘要处理", value: effects.writeSharedSummary ? "写入此共享内容的首份摘要" : "已有摘要不覆盖；上方拟提交文本不会写入" },
    { label: "合并结果", value: merging ? `移除旧收藏 ${effects.softDeleteCollectionId}；${effects.createWinnerCollection ? "新建" : effects.restoreWinnerCollection ? "恢复已删除" : "保留"}目标收藏 ${effects.winnerCollectionId ?? "（提交时创建）"}` : "不合并、不移除收藏" },
    { label: "最终可见性", value: `${effects.resultingVisibility}；${effects.effectivelyPublic ? "当前符合公开条件" : "当前未满足公开条件"}` },
    { label: "来源记录", value: effects.promoteSourceChannel ? "将目标收藏来源改为 WeChat，保留本次合并原收藏的来源" : effects.resultingSourceChannel },
    { label: "当前共享来源链接", value: snapshot.winner.outboundUrl },
    { label: "共享链接身份", value: effects.claimIdentity ? `建立最终链接 ${input.resolved_url} 到目标内容的共享规范化身份` : "沿用已存在的最终链接共享身份" },
    { label: "历史提交迁移", value: merging ? `将你的 ${snapshot.affectedAttemptCount} 条关联历史提交指向目标收藏和内容` : "不迁移历史提交" },
    { label: "公开撤销记录", value: effects.resultingFilterRevokedAt ?? "无撤销记录" },
  ], consequences: [
    "标题、摘要、标签和最终来源链接属于共享 Content，其他有权访问该内容的用户及公开内容读者可能看到；这不是仅保存在本次对话中的草稿。",
    merging ? "这会连接原内容与目标内容的共享身份，迁移你的收藏并将旧收藏标记为删除。已有公开可见性会保留，不能撤回他人已经看到的内容。" : "不会覆盖已经完成的共享摘要；若当前内容或来源发生变化，需要重新读取和审核。",
    effects.promoteSourceChannel ? "只保留已拥有的 WeChat 收藏来源，不复制凭据或绑定，也不创建新连接。" : "不创建新的渠道连接或复制登录凭据。",
    effects.notification.mode === "queue_if_missing" ? "仅在缺少去重事件时排入摘要就绪通知，面向已有且符合条件的 WeChat 收藏者。不会强制重发，也不保证实际投递。" : "本次不新增摘要就绪通知。",
    "读取证明只确认来源和读取结果，不能自动保证摘要准确。请核对上方完整文本后批准；过期或中断不会自动重试。",
    `阅读证据：${evidence.extractionMethod}；${evidence.truncated ? "来源文本截断" : "来源文本未截断"}；${evidence.readAt}。`,
  ] };
}
export interface WebsiteEnrichmentPreparationDependencies {
  loadPlan: typeof loadContentEnrichmentPlan;
  getStatus: typeof getCollectionStatus;
  now(): Date;
}
const defaults: WebsiteEnrichmentPreparationDependencies = { loadPlan: loadContentEnrichmentPlan, getStatus: getCollectionStatus, now: () => new Date() };
export async function prepareWebsiteEnrichment(context: AttentionToolContext, rawInput: unknown,
  evidenceRun: WebsiteSourceEvidenceRun, dependencies: WebsiteEnrichmentPreparationDependencies = defaults): Promise<{ prepared: WebsiteEnrichmentPrepared; review: EnrichmentReview }> {
  context.signal.throwIfAborted();
  if (context.accountId !== evidenceRun.identity.accountId || context.caller.credentialId !== evidenceRun.identity.authSessionId ||
      context.caller.credentialKind !== "session" || context.caller.entrypoint !== "hosted_agent" || !context.isMember ||
      !context.scopes.includes("collection:write")) throw new WebsiteEnrichmentReviewError("enrichment_permission_revoked");
  const input = normalizeContentEnrichmentInput(rawInput), evidence = assertWebsiteSourceAttestation(evidenceRun.evidenceFor(input.content_id), evidenceRun.identity, dependencies.now());
  if (input.resolved_url !== evidence.finalPublicUrl) throw new WebsiteEnrichmentReviewError("enrichment_source_changed");
  const status = await dependencies.getStatus(context.getDatabase(), context, { collection_id: evidence.collectionId });
  const identity = sourceReadIdentity(status);
  if (!identity || identity.operation !== evidence.operation || identity.sourceFingerprint !== evidence.sourceFingerprint)
    throw new WebsiteEnrichmentReviewError("enrichment_source_changed");
  const plan = await dependencies.loadPlan(context.getDatabase(), context.accountId, input);
  context.signal.throwIfAborted();
  assertWebsiteSourceAttestation(evidence, evidenceRun.identity, dependencies.now());
  const prepared = parsePreparedEnrichment({ kind: "enrichment", version: 1, plan, evidence,
    expiresAt: evidence.expiresAt, bindingHash: bind(plan, evidence) });
  return { prepared, review: websiteEnrichmentReviewDetails(prepared) };
}
/** No network. The stored action expiry/deadline must also be capped to prepared.expiresAt. */
export function preflightWebsiteEnrichment(raw: WebsiteEnrichmentPrepared, identity: WebsiteEnrichmentRunIdentity, now = new Date()): WebsiteEnrichmentPrepared {
  const prepared = parsePreparedEnrichment(raw);
  assertWebsiteSourceAttestation(prepared.evidence, identity, now);
  return prepared;
}
/** Use after the action's authority locks, before the canonical invocation savepoint. */
export async function revalidatePreparedEnrichmentInTransaction(tx: AttentionTransaction, raw: WebsiteEnrichmentPrepared,
  identity: WebsiteEnrichmentRunIdentity, now: () => Date = () => new Date()): Promise<void> {
  const prepared = preflightWebsiteEnrichment(raw, identity, now());
  await lockAndRevalidateContentEnrichmentPlan(tx, identity.accountId, prepared.plan);
  preflightWebsiteEnrichment(prepared, identity, now());
}
/** Server-only canonical dependency override; exact stored args and plan, never a model-supplied flag. */
export function websiteEnrichmentCoreOverrides(tx: AttentionTransaction, raw: WebsiteEnrichmentPrepared,
  identity: WebsiteEnrichmentRunIdentity, now: () => Date = () => new Date()): Pick<AttentionToolCoreDependencies, "submitContentEnrichment"> {
  const prepared = preflightWebsiteEnrichment(raw, identity, now());
  return { async submitContentEnrichment(database, principal, args) {
    if (database !== tx || principal.accountId !== prepared.evidence.accountId ||
        enrichmentStableJson(normalizeContentEnrichmentInput(args)) !== enrichmentStableJson(prepared.plan.input))
      throw new WebsiteEnrichmentReviewError("enrichment_review_invalid");
    preflightWebsiteEnrichment(prepared, identity, now());
    const result = await applyPreparedContentEnrichment(tx, principal, prepared.plan);
    preflightWebsiteEnrichment(prepared, identity, now());
    return result;
  } };
}
