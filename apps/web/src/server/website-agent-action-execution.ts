import "server-only";

import { setAccountContext, sql, type AttentionDatabase, type AttentionTransaction } from "@attention/db";
import { z } from "zod";

import type { AttentionToolAuditInput } from "./attention-tool-audit";
import { attentionToolRegistry, createAttentionToolRegistry, defaultAttentionToolCoreDependencies, type AttentionToolBaseContext, type AttentionToolContext,
  type AttentionToolDefinition, type AttentionToolResult } from "./attention-tool-registry";
import { parseWebsiteAgentActionProposal, revalidateWebsiteAgentAction, WebsiteAgentActionPolicyError,
  type WebsiteAgentActionProposal } from "./website-agent-action-policy";

import { preflightWebsiteEnrichment, websiteEnrichmentCoreOverrides } from "./website-agent-enrichment-review";
import type { WebsiteEnrichmentRunIdentity } from "./website-agent-source-evidence";
import { collectionPlanDigest } from "./collection-effect-plan";
import { establishPreparedCollection } from "./collection-service";
import type { WebsiteCollectionPreflight } from "./website-agent-collection-review";

const identitySchema = z.object({ accountId: z.string().uuid(), authSessionId: z.string().uuid() }).strict();

/**
 * The caller already holds the website account lock and a durable executing claim.
 * Fixed lock order: account, authentication session, Filter, entitlement, grant,
 * subscription. All reads use this transaction; no token, session touch, or new
 * connection is involved. Revalidate the real cookie with resolveSession(tx,
 * token, {touch:false}) and the current rollout after acquiring these locks.
 */
export async function lockWebsiteAgentActionAuthority(tx: AttentionTransaction,
  input: { accountId: string; authSessionId: string }): Promise<void> {
  const { accountId, authSessionId } = identitySchema.parse(input);
  await setAccountContext(tx, accountId);
  const account = await tx.execute(sql`select id from accounts where id = ${accountId}::uuid and status = 'active' for update`);
  if (account.length !== 1) throw new WebsiteAgentActionPolicyError("permission_revoked");
  const session = await tx.execute(sql`select id from sessions where id = ${authSessionId}::uuid and account_id = ${accountId}::uuid
    and revoked_at is null and expires_at > clock_timestamp() for share`);
  if (session.length !== 1) throw new WebsiteAgentActionPolicyError("permission_revoked");
  await tx.execute(sql`select account_id from filter_profiles where account_id = ${accountId}::uuid for share`);
  await tx.execute(sql`select id from entitlements where account_id = ${accountId}::uuid order by id for share`);
  await tx.execute(sql`select id from membership_grants where account_id = ${accountId}::uuid order by id for share`);
  await tx.execute(sql`select id from subscriptions where account_id = ${accountId}::uuid order by id for share`);
}

/** Target locks are held through both Core effects and the outer receipt commit. */
export async function lockWebsiteAgentActionTarget(tx: AttentionTransaction, rawProposal: WebsiteAgentActionProposal,
  accountId: string): Promise<void> {
  z.string().uuid().parse(accountId);
  const proposal = parseWebsiteAgentActionProposal(rawProposal), args = proposal.arguments;
  if (proposal.prepared) {
    // Core establishes sorted content/alias/collection locks and verifies the
    // entire prepared effect set, including absent unique identities.
    if (proposal.prepared.kind !== "collection" && proposal.prepared.kind !== "enrichment") throw new WebsiteAgentActionPolicyError("action_target_unavailable");
  } else if (proposal.toolName === "attention_update_collection") {
    await tx.execute(sql`select id from collections where id = ${args.collection_id}::uuid and account_id = ${accountId}::uuid for update`);
    await tx.execute(sql`select c.id from contents c join collections k on k.content_id = c.id
      where k.id = ${args.collection_id}::uuid and k.account_id = ${accountId}::uuid for share of c`);
  } else if (proposal.toolName === "attention_update_digest_settings") {
    await tx.execute(sql`select account_id from account_digest_preferences where account_id = ${accountId}::uuid for update`);
    await tx.execute(sql`select account_id from domain_digest_subscriptions where account_id = ${accountId}::uuid order by domain_id for update`);
  } else if (proposal.toolName === "attention_report_content") {
    // Match Core's lock order: reporter before content, never the reverse.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'moderation-report:' + accountId}::text, 0))`);
    await tx.execute(sql`select id from contents where public_id = ${args.public_content_id}::uuid for update`);
  } else {
    // The runtime cannot UPDATE moderation_cases. Core and the resolution worker
    // already share this exact advisory lock, so no privilege expansion is needed.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${args.case_id}::text, 0))`);
    await tx.execute(sql`select c.id from contents c join moderation_cases m on m.content_id = c.id
      where m.id = ${args.case_id}::uuid for share of c`);
  }
}

export interface WebsiteAgentReviewedExecutionInput {
  context: AttentionToolBaseContext;
  proposal: WebsiteAgentActionProposal;
  actionId: string;
  signal: AbortSignal;
  collectionPreflight?: WebsiteCollectionPreflight;
  enrichmentIdentity?: WebsiteEnrichmentRunIdentity;
  revalidate(tx: AttentionTransaction): Promise<AttentionToolBaseContext | null>;
}
export interface WebsiteAgentReviewedExecutionDependencies {
  registry: readonly AttentionToolDefinition[];
  lockAuthority: typeof lockWebsiteAgentActionAuthority;
  lockTarget: typeof lockWebsiteAgentActionTarget;
  revalidateProposal: typeof revalidateWebsiteAgentAction;
}
const defaults: WebsiteAgentReviewedExecutionDependencies = { registry: attentionToolRegistry,
  lockAuthority: lockWebsiteAgentActionAuthority, lockTarget: lockWebsiteAgentActionTarget,
  revalidateProposal: revalidateWebsiteAgentAction };
class RollbackToolResult extends Error {
  constructor(readonly result: AttentionToolResult) { super("rollback_tool_result"); }
}

/**
 * Does not grant approval, claim, retry, or commit the outer transaction. The store
 * must reload the EXACT durable executing claim under its account lock first,
 * call this function, then store the receipt in that same transaction. A lost
 * connection/expired claim is unknown, never authorization to invoke again.
 * Audits are captured data only: flush with the ROOT database after outer commit.
 */
export async function invokeReviewedWebsiteDatabaseAction(tx: AttentionTransaction, input: WebsiteAgentReviewedExecutionInput,
  dependencies: WebsiteAgentReviewedExecutionDependencies = defaults): Promise<{ result: AttentionToolResult; audits: AttentionToolAuditInput[] }> {
  input.signal.throwIfAborted();
  z.string().uuid().parse(input.actionId);
  const proposal = parseWebsiteAgentActionProposal(input.proposal);
  const original = input.context;
  if (original.caller.credentialKind !== "session" || original.caller.entrypoint !== "hosted_agent")
    throw new WebsiteAgentActionPolicyError("permission_revoked");
  await dependencies.lockAuthority(tx, { accountId: original.accountId, authSessionId: original.caller.credentialId });
  let registry = dependencies.registry;
  if (proposal.prepared?.kind === "enrichment") {
    if (!input.enrichmentIdentity || input.enrichmentIdentity.accountId !== original.accountId ||
        input.enrichmentIdentity.authSessionId !== original.caller.credentialId) throw new WebsiteAgentActionPolicyError("permission_revoked");
    preflightWebsiteEnrichment(proposal.prepared, input.enrichmentIdentity);
  } else if (proposal.prepared) {
    const prepared = proposal.prepared;
    if (prepared.kind !== "collection" || !input.collectionPreflight ||
        input.collectionPreflight.preparedDigest !== collectionPlanDigest(prepared)) throw new WebsiteAgentActionPolicyError("action_target_changed");
    // This closure is assembled by the trusted action executor. No model or
    // browser flag can activate the prepared path in the canonical registry.
    const establish: typeof defaultAttentionToolCoreDependencies.collectFromWeb = async (db, principal) =>
      establishPreparedCollection(db as AttentionTransaction, { ...principal, privateCollectionOnly: false,
        revalidateInTransaction: async currentTx => {
          const latest = await input.revalidate(currentTx);
          return latest ? { accountId: latest.accountId, scopes: latest.scopes, isFilter: latest.isFilter, isMember: latest.isMember } : null;
        } }, prepared);
    registry = createAttentionToolRegistry({ ...defaultAttentionToolCoreDependencies, collectFromWeb: establish, selectCandidateFromWeb: establish });
  }
  const definition = registry.find(tool => tool.name === proposal.toolName);
  if (!definition || definition.contractVersion !== proposal.contractVersion) throw new WebsiteAgentActionPolicyError("action_contract_changed");
  const audits: AttentionToolAuditInput[] = [];
  const current = async (): Promise<AttentionToolContext> => {
    input.signal.throwIfAborted();
    const context = await input.revalidate(tx);
    input.signal.throwIfAborted();
    if (!context || context.accountId !== original.accountId || context.caller.credentialId !== original.caller.credentialId ||
      context.caller.credentialKind !== "session" || context.caller.entrypoint !== "hosted_agent" || !context.isMember ||
      !proposal.requiredScopes.every(scope => context.scopes.includes(scope)) || !definition.isVisible(context) ||
      ((proposal.toolName === "attention_cast_moderation_vote" ||
        ((proposal.toolName === "attention_update_collection" || proposal.prepared) && (proposal.arguments.visibility === "public" || (proposal.prepared?.kind === "collection" && proposal.prepared.plan.effects.resultingVisibility === "public")))) && !context.isFilter))
      throw new WebsiteAgentActionPolicyError("permission_revoked");
    // AttentionTransaction is a PgDatabase; transaction() below uses SAVEPOINT.
    const database: AttentionDatabase = tx;
    return { ...context, getDatabase: () => database, runId: `website-action:${input.actionId}`, signal: input.signal,
      recordAudit: (_db, audit) => { audits.push(structuredClone(audit)); }, revalidate: async () => {
        const latest = await current();
        return { accountId: latest.accountId, scopes: latest.scopes, isMember: latest.isMember, isFilter: latest.isFilter };
      } };
  };
  const context = await current();
  await dependencies.lockTarget(tx, proposal, context.accountId);
  await dependencies.revalidateProposal(context, proposal, undefined, input.enrichmentIdentity);
  const rawInput = proposal.toolName === "attention_select_collection_candidate"
    ? { candidate_id: proposal.arguments.candidate_id, visibility: proposal.arguments.visibility, selection_token: input.collectionPreflight?.selectionToken }
    : proposal.toolName === "attention_report_content" || proposal.toolName === "attention_cast_moderation_vote"
    ? { ...proposal.arguments, explicit_confirmation: true } : proposal.arguments;
  let result: AttentionToolResult;
  try {
    result = await tx.transaction(async savepoint => {
      const database: AttentionDatabase = savepoint;
      input.signal.throwIfAborted();
      const invocation = proposal.prepared?.kind === "enrichment"
        ? createAttentionToolRegistry({ ...defaultAttentionToolCoreDependencies,
          ...websiteEnrichmentCoreOverrides(savepoint, proposal.prepared, input.enrichmentIdentity!) }).find(tool => tool.name === proposal.toolName)!
        : definition;
      const value = await invocation.invoke({ ...context, getDatabase: () => database }, rawInput);
      // Canonical invoke returns safe errors instead of throwing, even after a
      // successful Core write with invalid output. Roll those effects back too.
      if (!value.ok) throw new RollbackToolResult(value);
      input.signal.throwIfAborted();
      return value;
    });
  } catch (error) {
    if (!(error instanceof RollbackToolResult)) throw error;
    result = error.result;
  }
  // Includes wall-clock session/membership expiry and current rollout. The caller
  // performs its final check again immediately before the outer receipt commit.
  await current();
  if (proposal.prepared?.kind === "enrichment") preflightWebsiteEnrichment(proposal.prepared, input.enrichmentIdentity!);
  return { result, audits };
}
