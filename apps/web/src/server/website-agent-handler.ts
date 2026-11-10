import "server-only";

import { readSessionToken, resolveSession, type SessionPrincipal } from "@attention/auth";
import type { AttentionDatabase } from "@attention/db";
import { runWebsiteAgent, WebsiteAgentError } from "@attention/website-agent";
import { after } from "next/server";
import { z } from "zod";

import { mutationRequestError, noStoreJson } from "./api-guard";
import { recordAttentionToolAuditBestEffort } from "./attention-tool-audit";
import type { AttentionToolBaseContext } from "./attention-tool-registry";
import { getWebDatabase } from "./db";
import { InvalidRequestBodyError, readJsonRequestWithinLimit, RequestBodyTooLargeError } from "./request-body";
import { clearInvalidSessionCookie, getRequestSession, type RequestSession } from "./session";
import { websiteAgentRequestFingerprint, WebsiteAgentAdmissionError } from "./website-agent-budget";
import { beginWebsiteAgentTurn, finishWebsiteAgentTurn, isWebsiteAgentTurnActive, WebsiteAgentSessionError, type WebsiteAgentStartedTurn } from "./website-agent-sessions";
import { websiteAgentAccountEligible, websiteAgentConfig, WebsiteAgentUnavailableError } from "./website-agent-config";
import { createWebsiteAgentTools, WEBSITE_AGENT_TOOL_SCOPES } from "./website-agent-tools";
import { pendingWebsiteAgentAction, WEBSITE_AGENT_MAX_NEW_ACTIONS, type StoredWebsiteAgentAction } from "./website-agent-action-state";
import { prepareWebsiteAgentAction, WebsiteAgentActionPolicyError } from "./website-agent-action-policy";

export const WEBSITE_AGENT_TIMEOUT_MS = 60_000;
const secureCookie = process.env.NODE_ENV === "production";
const bodySchema = z.object({
  query: z.string().trim().min(1).max(4_000),
  session_id: z.string().uuid(),
  expected_revision: z.number().int().min(0).max(2_147_483_645),
  operation_id: z.string().uuid(),
  data_consent: z.literal(true),
  collect: z.boolean().default(false),
  read_sources: z.boolean().default(false),
}).strict();

export interface WebsiteAgentRequestDependencies {
  getDatabase(): AttentionDatabase;
  getSession(request: Request): Promise<RequestSession>;
  getConfig: typeof websiteAgentConfig;
  begin: typeof beginWebsiteAgentTurn;
  finish: typeof finishWebsiteAgentTurn;
  isActive: typeof isWebsiteAgentTurnActive;
  run: typeof runWebsiteAgent;
  createTools: typeof createWebsiteAgentTools;
  prepareAction?: typeof prepareWebsiteAgentAction;
  resolveSessionInTransaction?: typeof resolveSession;
}

const defaults: WebsiteAgentRequestDependencies = {
  getDatabase: getWebDatabase, getSession: getRequestSession, getConfig: websiteAgentConfig,
  begin: beginWebsiteAgentTurn, finish: finishWebsiteAgentTurn, isActive: isWebsiteAgentTurnActive, run: runWebsiteAgent, createTools: createWebsiteAgentTools,
};

export async function handleWebsiteAgentRequest(request: Request,
  dependencies: WebsiteAgentRequestDependencies = defaults): Promise<Response> {
  const guard = mutationRequestError(request, { maxContentLengthBytes: 20_480 });
  if (guard) return noStoreJson({ error: { code: guard } }, { status: guard === "request_too_large" ? 413 : 400 });
  let turn: WebsiteAgentStartedTurn | null = null;
  let finalized = false;
  let outcome: "completed" | "failed" | "cancelled" = "failed";
  let database: AttentionDatabase | null = null;
  try {
    const session = await dependencies.getSession(request);
    if (!session.principal) {
      const response = noStoreJson({ error: { code: "authentication_required" } }, { status: 401 });
      clearInvalidSessionCookie(response, session);
      return response;
    }
    const principal = session.principal;
    if (!principal.isMember) return noStoreJson({ error: { code: "membership_required" } }, { status: 403 });
    const config = dependencies.getConfig();
    if (!websiteAgentAccountEligible(config, principal.accountId)) return noStoreJson({ error: { code: "website_agent_not_enabled_for_account" } }, { status: 403 });
    const body = bodySchema.parse(await readJsonRequestWithinLimit(request, 20_480));
    request.signal.throwIfAborted();
    database = dependencies.getDatabase();
    turn = await dependencies.begin(database, {
      accountId: principal.accountId, sessionId: body.session_id, expectedRevision: body.expected_revision, query: body.query, operationId: body.operation_id,
      requestFingerprint: websiteAgentRequestFingerprint({ query: body.query, collect: body.collect, readSources: body.read_sources, sessionId: body.session_id, expectedRevision: body.expected_revision }),
      maxRunCostMicrousd: config.maxRunCostMicrousd, dailyCostMicrousd: config.dailyCostMicrousd,
      timeoutMs: WEBSITE_AGENT_TIMEOUT_MS,
    });
    const claimedTurn = turn;
    const cookieToken = readSessionToken(request.headers.get("cookie"), secureCookie);
    const requestId = claimedTurn.runId;
    const activeTurn = () => dependencies.isActive(database!, claimedTurn);
    // Scopes describe the account's canonical tools. The transport's explicit
    // consent/review adapters still prevent model calls from executing writes.
    const scopes = [...WEBSITE_AGENT_TOOL_SCOPES];
    const context = (current: SessionPrincipal): AttentionToolBaseContext => ({
      accountId: current.accountId,
      caller: { clientId: "attention-website", credentialId: current.sessionId, credentialKind: "session", entrypoint: "hosted_agent" },
      getDatabase: () => database!, isFilter: current.isFilter, isMember: current.isMember,
      requestId, serviceOrigin: new URL(request.url).origin, scopes,
      recordAudit: (db, input) => { after(() => recordAttentionToolAuditBestEffort(db, input)); },
      revalidate: async () => {
        const latest = (await dependencies.getSession(request)).principal;
        return latest && latest.accountId === principal.accountId && latest.sessionId === principal.sessionId &&
          latest.isMember && websiteAgentAccountEligible(dependencies.getConfig(), latest.accountId) && await activeTurn()
          ? { accountId: latest.accountId, scopes, isMember: latest.isMember, isFilter: latest.isFilter } : null;
      },
      revalidateInTransaction: async tx => {
        if (!cookieToken) return null;
        // Resolve on the current Core transaction, without a second connection
        // or session lastSeenAt update while business rows are locked.
        const latest = await (dependencies.resolveSessionInTransaction ?? resolveSession)(tx, cookieToken, { touch: false });
        return latest && latest.accountId === principal.accountId && latest.sessionId === principal.sessionId &&
          latest.isMember && websiteAgentAccountEligible(dependencies.getConfig(), latest.accountId) &&
          await dependencies.isActive(tx, claimedTurn)
          ? { accountId: latest.accountId, scopes, isMember: latest.isMember, isFilter: latest.isFilter } : null;
      },
    });
    const currentPrincipal = async () => {
      const latest = (await dependencies.getSession(request)).principal;
      return latest && latest.accountId === principal.accountId && latest.sessionId === principal.sessionId &&
        latest.isMember && websiteAgentAccountEligible(dependencies.getConfig(), latest.accountId) ? latest : null;
    };
    const currentContext = async () => {
      const latest = await currentPrincipal();
      return latest && await activeTurn() ? context(latest) : null;
    };
    const proposedActions: StoredWebsiteAgentAction[] = [];
    const result = await dependencies.run({
      apiKey: config.apiKey,
      prompt: body.query,
      nativeSession: claimedTurn.nativeSession,
      signal: request.signal,
      limits: { maxRunCostMicrousd: config.maxRunCostMicrousd, maxModelCalls: 6, maxToolCalls: 8,
        maxOutputTokensPerCall: 1_200, maxContextBytes: 131_072, maxToolOutputBytes: 65_536, timeoutMs: WEBSITE_AGENT_TIMEOUT_MS },
      tools: dependencies.createTools({ context: context(principal), getCurrentContext: currentContext,
        operationId: body.operation_id, query: body.query, collect: body.collect, readSources: body.read_sources,
        proposeAction: async (toolName, rawInput, execution) => {
          execution.signal.throwIfAborted();
          if (proposedActions.length >= WEBSITE_AGENT_MAX_NEW_ACTIONS) return { ok: false, code: "action_proposal_limit" };
          const latest = await currentContext();
          if (!latest) return { ok: false, code: "permission_revoked" };
          try {
            const proposal = await (dependencies.prepareAction ?? prepareWebsiteAgentAction)({ ...latest,
              runId: `website:${body.operation_id}:${execution.toolCallId}`.slice(0, 128), signal: execution.signal }, toolName, rawInput);
            execution.signal.throwIfAborted();
            if (!await currentContext()) return { ok: false, code: "permission_revoked" };
            const action = pendingWebsiteAgentAction({ proposal, authSessionId: principal.sessionId,
              originRunId: claimedTurn.runId, originRevision: claimedTurn.revision });
            proposedActions.push(action);
            return { ok: true, value: { status: "requires_user_confirmation", action_id: action.id,
              action_title: action.review.title, expires_at: action.expiresAt,
              guidance: "This is a proposal only. The user must review and approve the exact action in the website. Nothing has been changed." } };
          } catch (error) {
            if (error instanceof WebsiteAgentActionPolicyError) return { ok: false, code: error.code };
            return { ok: false, code: "action_proposal_unavailable" };
          }
        } }),
      beforeModelCall: async signal => {
        signal.throwIfAborted();
        if (!await currentContext()) throw new Error("permission_revoked");
        signal.throwIfAborted();
      },
    });
    request.signal.throwIfAborted();
    if (!await currentContext()) throw new WebsiteAgentError("permission_revoked", result.usage, result.toolReceipts);
    request.signal.throwIfAborted();
    outcome = "completed";
    const savedSession = await dependencies.finish(database, { ...claimedTurn, outcome, nativeSession: result.nativeSession, answer: result.answer,
      ...(proposedActions.length ? { proposedActions } : {}) });
    finalized = true;
    if (!savedSession) throw new WebsiteAgentSessionError("session_conflict");
    // Persistence may await a transaction while access changes. The completed
    // turn is no longer active, but its answer still requires a live principal.
    if (!await currentPrincipal()) throw new WebsiteAgentError("permission_revoked", result.usage, result.toolReceipts);
    return noStoreJson({ session: savedSession, answer: result.answer, model: "deepseek-flash", runtime: "pi-agent-core",
      tool_receipts: result.toolReceipts, usage: result.usage });
  } catch (error) {
    // A provider answer is not durable until its native session save commits.
    if (outcome === "completed" && !finalized) outcome = "failed";
    if (error instanceof RequestBodyTooLargeError) return noStoreJson({ error: { code: "request_too_large" } }, { status: 413 });
    if (error instanceof z.ZodError || error instanceof InvalidRequestBodyError) return noStoreJson({ error: { code: "invalid_request" } }, { status: 400 });
    if (error instanceof WebsiteAgentSessionError) return noStoreJson({ error: { code: error.code } }, { status: error.code === "session_not_found" ? 404 : error.code === "session_expired" ? 410 : error.code === "session_unavailable" ? 503 : 409 });
    if (error instanceof WebsiteAgentUnavailableError) return noStoreJson({ error: { code: error.code } }, { status: 503 });
    if (error instanceof WebsiteAgentAdmissionError) return noStoreJson({ error: { code: error.code } }, { status: error.code === "website_agent_daily_budget_exhausted" ? 429 : 409 });
    if (error instanceof WebsiteAgentError) {
      const failureOutcome = error.code === "cancelled" || error.code === "timeout" ? "cancelled" : "failed";
      if (!finalized) outcome = failureOutcome;
      return noStoreJson({ error: { code: error.code, guidance: "Check collection status before retrying; a committed save is not undone by cancellation." },
        tool_receipts: error.toolReceipts, usage: error.usage }, { status: failureOutcome === "cancelled" ? 408 : 502 });
    }
    if (request.signal.aborted) {
      outcome = "cancelled";
      return noStoreJson({ error: { code: "cancelled" } }, { status: 408 });
    }
    // Never return/log raw provider errors, prompts, source bodies, or credentials.
    console.error("website_agent_failed", { name: error instanceof Error ? error.name : "UnknownError" });
    return noStoreJson({ error: { code: "website_agent_unavailable" } }, { status: 503 });
  } finally {
    if (database && turn && !finalized) await dependencies.finish(database, { ...turn, outcome }).catch(() => {
      console.error("website_agent_reservation_finalize_failed");
    });
  }
}
