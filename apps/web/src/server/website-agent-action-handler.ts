import "server-only";

import { ATTENTION_MCP_OAUTH_SCOPES } from "@attention/contracts";
import { readSessionToken, resolveSession, type SessionPrincipal } from "@attention/auth";
import type { AttentionDatabase, AttentionTransaction } from "@attention/db";
import { z } from "zod";

import { mutationRequestError, noStoreJson } from "./api-guard";
import { recordAttentionToolAuditBestEffort } from "./attention-tool-audit";
import type { AttentionToolBaseContext } from "./attention-tool-registry";
import { getWebDatabase } from "./db";
import { InvalidRequestBodyError, readJsonRequestWithinLimit, RequestBodyTooLargeError } from "./request-body";
import { clearInvalidSessionCookie, getRequestSession } from "./session";
import { storedWebsiteAgentActionProposal, WEBSITE_AGENT_ACTION_LEASE_MS } from "./website-agent-action-state";
import { invokeReviewedWebsiteDatabaseAction } from "./website-agent-action-execution";
import { WebsiteAgentActionPolicyError } from "./website-agent-action-policy";
import { WebsiteAgentAdmissionError } from "./website-agent-budget";
import { websiteAgentAccountEligible, websiteAgentConfig, WebsiteAgentUnavailableError } from "./website-agent-config";
import { claimWebsiteAgentAction, declineWebsiteAgentAction, executeClaimedWebsiteAgentAction, markWebsiteAgentActionUnknown,
  WebsiteAgentSessionError, type WebsiteAgentActionClaim } from "./website-agent-sessions";

const secureCookie = process.env.NODE_ENV === "production";
const ids = z.object({ sessionId: z.string().uuid(), actionId: z.string().uuid() }).strict();
const revision = z.number().int().min(0).max(2_147_483_645);
const approvalSchema = z.object({ expected_revision: revision, expected_arguments_hash: z.string().regex(/^[a-f0-9]{64}$/u),
  approval: z.literal(true) }).strict();
const declineSchema = z.object({ expected_revision: revision }).strict();
export interface WebsiteAgentActionRequestDependencies {
  getDatabase: typeof getWebDatabase;
  getSession: typeof getRequestSession;
  getConfig: typeof websiteAgentConfig;
  resolveSession: typeof resolveSession;
  claim: typeof claimWebsiteAgentAction;
  execute: typeof executeClaimedWebsiteAgentAction;
  unknown: typeof markWebsiteAgentActionUnknown;
  decline: typeof declineWebsiteAgentAction;
  invoke: typeof invokeReviewedWebsiteDatabaseAction;
  audit: typeof recordAttentionToolAuditBestEffort;
}
const defaults: WebsiteAgentActionRequestDependencies = { getDatabase: getWebDatabase, getSession: getRequestSession,
  getConfig: websiteAgentConfig, resolveSession, claim: claimWebsiteAgentAction, execute: executeClaimedWebsiteAgentAction,
  unknown: markWebsiteAgentActionUnknown, decline: declineWebsiteAgentAction,
  invoke: invokeReviewedWebsiteDatabaseAction, audit: recordAttentionToolAuditBestEffort };

/** Human-only same-origin boundary. The model has no tool for invoking this endpoint. */
export async function handleWebsiteAgentActionRequest(request: Request, operation: "approve" | "decline",
  sessionId: string, actionId: string, dependencies: WebsiteAgentActionRequestDependencies = defaults): Promise<Response> {
  const guard = mutationRequestError(request, { maxContentLengthBytes: 4_096 });
  if (guard) return noStoreJson({ error: { code: guard } }, { status: guard === "request_too_large" ? 413 : 400 });
  let claim: WebsiteAgentActionClaim | null = null;
  const executionSignal = AbortSignal.any([request.signal, AbortSignal.timeout(WEBSITE_AGENT_ACTION_LEASE_MS)]);
  let completed = false;
  let db: AttentionDatabase | null = null;
  try {
    const initial = await dependencies.getSession(request);
    if (!initial.principal) {
      const response = noStoreJson({ error: { code: "authentication_required" } }, { status: 401 });
      clearInvalidSessionCookie(response, initial);
      return response;
    }
    const principal = initial.principal;
    const eligible = (latest: SessionPrincipal | null): latest is SessionPrincipal => Boolean(latest &&
      latest.accountId === principal.accountId && latest.sessionId === principal.sessionId && latest.isMember &&
      websiteAgentAccountEligible(dependencies.getConfig(), latest.accountId));
    if (!principal.isMember) return noStoreJson({ error: { code: "membership_required" } }, { status: 403 });
    if (!eligible(principal)) return noStoreJson({ error: { code: "website_agent_not_enabled_for_account" } }, { status: 403 });
    ids.parse({ sessionId, actionId });
    const body = operation === "approve" ? approvalSchema.parse(await readJsonRequestWithinLimit(request, 4_096))
      : declineSchema.parse(await readJsonRequestWithinLimit(request, 4_096));
    executionSignal.throwIfAborted();
    if (!eligible((await dependencies.getSession(request)).principal)) throw new WebsiteAgentActionPolicyError("permission_revoked");
    db = dependencies.getDatabase();
    if (operation === "decline") {
      const session = await dependencies.decline(db, { accountId: principal.accountId, sessionId, actionId, expectedRevision: body.expected_revision });
      if (!eligible((await dependencies.getSession(request)).principal)) throw new WebsiteAgentActionPolicyError("permission_revoked");
      return noStoreJson({ session });
    }
    const approved = approvalSchema.parse(body);
    const token = readSessionToken(request.headers.get("cookie"), secureCookie);
    if (!token) return noStoreJson({ error: { code: "authentication_required" } }, { status: 401 });
    const claimed = await dependencies.claim(db, { accountId: principal.accountId, sessionId, actionId,
      authSessionId: principal.sessionId, expectedRevision: approved.expected_revision, argumentsHash: approved.expected_arguments_hash });
    claim = claimed.claim;
    if (!claim) {
      if (!eligible((await dependencies.getSession(request)).principal)) throw new WebsiteAgentActionPolicyError("permission_revoked");
      return noStoreJson({ session: claimed.session });
    }
    const identity = claim;
    const revalidate = async (tx: AttentionTransaction): Promise<AttentionToolBaseContext | null> => {
      executionSignal.throwIfAborted();
      // Same transaction, no lastSeenAt touch or second-connection lock inversion.
      const current = await dependencies.resolveSession(tx, token, { touch: false });
      if (!eligible(current)) return null;
      return { accountId: current.accountId, getDatabase: () => tx,
        caller: { clientId: "attention-website", credentialId: current.sessionId, credentialKind: "session", entrypoint: "hosted_agent" },
        isMember: current.isMember, isFilter: current.isFilter, scopes: ATTENTION_MCP_OAUTH_SCOPES,
        requestId: identity.actionId, serviceOrigin: new URL(request.url).origin };
    };
    const result = await dependencies.execute(db, identity, async (tx, action) => {
      const context = await revalidate(tx);
      if (!context) throw new WebsiteAgentActionPolicyError("permission_revoked");
      const executed = await dependencies.invoke(tx, { context, proposal: storedWebsiteAgentActionProposal(action),
        actionId: identity.actionId, signal: executionSignal, revalidate });
      if (!await revalidate(tx)) throw new WebsiteAgentActionPolicyError("permission_revoked");
      const duplicate = executed.result.ok && executed.result.value.duplicate === true;
      const receipt = executed.result.ok
        ? duplicate && action.toolName === "attention_report_content"
          ? { ok: true, code: "already_reported", message: "An existing report was found. No new report or changed report details were submitted." }
          : duplicate && action.toolName === "attention_cast_moderation_vote"
            ? { ok: true, code: "already_voted", message: "Your existing vote already has this decision. No new vote was submitted." }
            : { ok: true, code: "completed", message: "The exact reviewed action completed." }
        : { ok: false, code: executed.result.code, message: executed.result.guidance };
      return { receipt, value: executed.audits };
    });
    completed = true;
    // Captured audits use the root database only after the effect/receipt commit.
    for (const audit of result.value) await dependencies.audit(db, audit);
    if (!eligible((await dependencies.getSession(request)).principal)) throw new WebsiteAgentActionPolicyError("permission_revoked");
    return noStoreJson({ session: result.session });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return noStoreJson({ error: { code: "request_too_large" } }, { status: 413 });
    if (error instanceof z.ZodError || error instanceof InvalidRequestBodyError) return noStoreJson({ error: { code: "invalid_request" } }, { status: 400 });
    if (error instanceof WebsiteAgentActionPolicyError) return noStoreJson({ error: { code: error.code } }, { status: error.code === "permission_revoked" ? 403 : 409 });
    if (error instanceof WebsiteAgentSessionError) return noStoreJson({ error: { code: error.code } }, {
      status: error.code === "session_not_found" || error.code === "action_not_found" ? 404 : error.code === "session_unavailable" ? 503 : 409 });
    if (error instanceof WebsiteAgentUnavailableError) return noStoreJson({ error: { code: error.code } }, { status: 503 });
    if (error instanceof WebsiteAgentAdmissionError) return noStoreJson({ error: { code: error.code } }, { status: 409 });
    console.error("website_agent_action_failed", { name: error instanceof Error ? error.name : "UnknownError" });
    return noStoreJson({ error: { code: "action_outcome_unknown" } }, { status: 503 });
  } finally {
    if (db && claim && !completed) await dependencies.unknown(db, claim).catch(() => {
      console.error("website_agent_action_reconciliation_pending");
    });
  }
}
