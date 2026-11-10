import "server-only";

import { readSessionToken, resolveSession, type SessionPrincipal } from "@attention/auth";
import { ATTENTION_MCP_OAUTH_SCOPES } from "@attention/contracts";
import { z } from "zod";
import { mutationRequestError, noStoreJson } from "./api-guard";
import { getWebDatabase } from "./db";
import { clearInvalidSessionCookie, getRequestSession } from "./session";
import { InvalidRequestBodyError, readJsonRequestWithinLimit, RequestBodyTooLargeError } from "./request-body";
import { websiteAgentAccountEligible, websiteAgentConfig, WebsiteAgentUnavailableError } from "./website-agent-config";
import { loadWebsiteAgentCandidateAction, replaceWebsiteAgentCandidateAction, WebsiteAgentSessionError } from "./website-agent-sessions";
import { prepareWebsiteCandidateChoice } from "./website-agent-collection-review";
import { preparedWebsiteCollectionProposal, WebsiteAgentActionPolicyError } from "./website-agent-action-policy";
import { CollectionServiceError } from "./collection-service";
import { lockWebsiteAgentActionAuthority } from "./website-agent-action-execution";

const schema = z.object({ expected_revision: z.number().int().min(0).max(2_147_483_645),
  expected_arguments_hash: z.string().regex(/^[a-f0-9]{64}$/u), candidate_id: z.string().uuid() }).strict();
const ids = z.object({ sessionId: z.string().uuid(), actionId: z.string().uuid() }).strict();
export interface WebsiteAgentCandidateRequestDependencies {
  getDatabase: typeof getWebDatabase; getSession: typeof getRequestSession; getConfig: typeof websiteAgentConfig;
  load: typeof loadWebsiteAgentCandidateAction; replace: typeof replaceWebsiteAgentCandidateAction;
  prepare: typeof prepareWebsiteCandidateChoice; resolveSession: typeof resolveSession; lockAuthority: typeof lockWebsiteAgentActionAuthority;
}
const defaults: WebsiteAgentCandidateRequestDependencies = { getDatabase: getWebDatabase, getSession: getRequestSession,
  getConfig: websiteAgentConfig, load: loadWebsiteAgentCandidateAction, replace: replaceWebsiteAgentCandidateAction,
  prepare: prepareWebsiteCandidateChoice, resolveSession, lockAuthority: lockWebsiteAgentActionAuthority };

/** Human choice only: creates a fresh exact review, never executes collection effects. */
export async function handleWebsiteAgentCandidateRequest(request: Request, sessionId: string, actionId: string,
  deps: WebsiteAgentCandidateRequestDependencies = defaults): Promise<Response> {
  const guard = mutationRequestError(request, { maxContentLengthBytes: 4096 });
  if (guard) return noStoreJson({ error: { code: guard } }, { status: guard === "request_too_large" ? 413 : 400 });
  try {
    const initial = await deps.getSession(request);
    if (!initial.principal) {
      const response = noStoreJson({ error: { code: "authentication_required" } }, { status: 401 });
      clearInvalidSessionCookie(response, initial); return response;
    }
    const principal = initial.principal;
    const eligible = (value: SessionPrincipal | null): value is SessionPrincipal => Boolean(value && value.accountId === principal.accountId &&
      value.sessionId === principal.sessionId && value.isMember && websiteAgentAccountEligible(deps.getConfig(), value.accountId));
    if (!principal.isMember) return noStoreJson({ error: { code: "membership_required" } }, { status: 403 });
    if (!eligible(principal)) throw new WebsiteAgentActionPolicyError("permission_revoked");
    ids.parse({ sessionId, actionId });
    const input = schema.parse(await readJsonRequestWithinLimit(request, 4096));
    const token = readSessionToken(request.headers.get("cookie"), process.env.NODE_ENV === "production");
    if (!token) return noStoreJson({ error: { code: "authentication_required" } }, { status: 401 });
    const db = deps.getDatabase(), signal = AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]);
    const original = await deps.load(db, { accountId: principal.accountId, sessionId, actionId,
      authSessionId: principal.sessionId, expectedRevision: input.expected_revision, argumentsHash: input.expected_arguments_hash });
    if (original.prepared?.kind !== "candidate_options") throw new WebsiteAgentActionPolicyError("action_target_unavailable");
    if (original.prepared.visibility === "public" && !principal.isFilter) throw new WebsiteAgentActionPolicyError("permission_revoked");
    const context = { accountId: principal.accountId, getDatabase: () => db, isFilter: principal.isFilter, isMember: principal.isMember,
      scopes: ATTENTION_MCP_OAUTH_SCOPES, requestId: actionId, runId: `website-choice:${actionId}`, signal, serviceOrigin: new URL(request.url).origin,
      caller: { clientId: "attention-website", credentialId: principal.sessionId, credentialKind: "session" as const, entrypoint: "hosted_agent" as const },
      revalidate: async () => { const latest = (await deps.getSession(request)).principal;
        return eligible(latest) ? { accountId: latest.accountId, scopes: ATTENTION_MCP_OAUTH_SCOPES, isMember: latest.isMember, isFilter: latest.isFilter } : null; } };
    // Fetcher and snapshot preparation finish before the replacement transaction.
    const prepared = await deps.prepare(context, original.prepared, input.candidate_id);
    signal.throwIfAborted();
    const proposal = preparedWebsiteCollectionProposal("attention_select_collection_candidate", {
      attempt_id: original.prepared.attemptId, candidate_id: input.candidate_id, visibility: original.prepared.visibility,
    }, prepared);
    const session = await deps.replace(db, { accountId: principal.accountId, sessionId, expectedRevision: input.expected_revision, original, proposal,
      revalidate: async tx => {
        signal.throwIfAborted();
        await deps.lockAuthority(tx, { accountId: principal.accountId, authSessionId: principal.sessionId });
        const latest = await deps.resolveSession(tx, token, { touch: false });
        signal.throwIfAborted();
        return eligible(latest) && (prepared.plan.effects.resultingVisibility !== "public" || latest.isFilter);
      } });
    if (!eligible((await deps.getSession(request)).principal)) throw new WebsiteAgentActionPolicyError("permission_revoked");
    return noStoreJson({ session });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof InvalidRequestBodyError) return noStoreJson({ error: { code: "invalid_request" } }, { status: 400 });
    if (error instanceof RequestBodyTooLargeError) return noStoreJson({ error: { code: "request_too_large" } }, { status: 413 });
    if (error instanceof CollectionServiceError) return noStoreJson({ error: { code: error.code } }, { status: error.httpStatus });
    if (error instanceof WebsiteAgentSessionError) return noStoreJson({ error: { code: error.code } }, { status: error.code === "session_not_found" || error.code === "action_not_found" ? 404 : 409 });
    if (error instanceof WebsiteAgentActionPolicyError) return noStoreJson({ error: { code: error.code } }, { status: error.code === "permission_revoked" ? 403 : 409 });
    if (error instanceof WebsiteAgentUnavailableError) return noStoreJson({ error: { code: error.code } }, { status: 503 });
    if (error instanceof Error && ["action_target_changed", "action_target_unavailable", "permission_revoked"].includes(error.message))
      return noStoreJson({ error: { code: error.message } }, { status: error.message === "permission_revoked" ? 403 : 409 });
    return noStoreJson({ error: { code: request.signal.aborted ? "cancelled" : "candidate_review_unavailable" } }, { status: 503 });
  }
}
