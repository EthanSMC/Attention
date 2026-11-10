import "server-only";

import { z } from "zod";

import { mutationRequestError, noStoreJson } from "./api-guard";
import { getWebDatabase } from "./db";
import { InvalidRequestBodyError, readJsonRequestWithinLimit, RequestBodyTooLargeError } from "./request-body";
import { clearInvalidSessionCookie, getRequestSession } from "./session";
import { websiteAgentAccountEligible, websiteAgentConfig, WebsiteAgentUnavailableError } from "./website-agent-config";
import { closeWebsiteAgentSession, createWebsiteAgentSession, listWebsiteAgentSessions, loadWebsiteAgentSession, WebsiteAgentSessionError } from "./website-agent-sessions";

const sessionIdSchema = z.string().uuid();
const revisionSchema = z.object({ expected_revision: z.number().int().min(0).max(2_147_483_645) }).strict();
export interface WebsiteAgentSessionRequestDependencies {
  getDatabase: typeof getWebDatabase;
  getSession: typeof getRequestSession;
  getConfig: typeof websiteAgentConfig;
  create: typeof createWebsiteAgentSession;
  list: typeof listWebsiteAgentSessions;
  load: typeof loadWebsiteAgentSession;
  close: typeof closeWebsiteAgentSession;
}
const defaults: WebsiteAgentSessionRequestDependencies = {
  getDatabase: getWebDatabase, getSession: getRequestSession, getConfig: websiteAgentConfig,
  create: createWebsiteAgentSession, list: listWebsiteAgentSessions, load: loadWebsiteAgentSession, close: closeWebsiteAgentSession,
};

/** Browser-session surface only. OAuth/MCP credentials never grant conversation access. */
export async function handleWebsiteAgentSessionRequest(request: Request,
  operation: "list" | "create" | "load" | "close", sessionId?: string,
  dependencies: WebsiteAgentSessionRequestDependencies = defaults): Promise<Response> {
  if (operation === "create" || operation === "close") {
    const guard = mutationRequestError(request, { maxContentLengthBytes: 4_096 });
    if (guard) return noStoreJson({ error: { code: guard } }, { status: guard === "request_too_large" ? 413 : 400 });
  }
  try {
    const session = await dependencies.getSession(request);
    if (!session.principal) {
      const response = noStoreJson({ error: { code: "authentication_required" } }, { status: 401 });
      clearInvalidSessionCookie(response, session);
      return response;
    }
    const principal = session.principal;
    if (!principal.isMember) return noStoreJson({ error: { code: "membership_required" } }, { status: 403 });
    if (!websiteAgentAccountEligible(dependencies.getConfig(), principal.accountId)) return noStoreJson({ error: { code: "website_agent_not_enabled_for_account" } }, { status: 403 });
    const currentAccessError = async (): Promise<Response | null> => {
      const latest = await dependencies.getSession(request);
      if (!latest.principal || latest.principal.accountId !== principal.accountId || latest.principal.sessionId !== principal.sessionId) {
        const response = noStoreJson({ error: { code: "authentication_required" } }, { status: 401 });
        clearInvalidSessionCookie(response, latest);
        return response;
      }
      if (!latest.principal.isMember) return noStoreJson({ error: { code: "membership_required" } }, { status: 403 });
      if (!websiteAgentAccountEligible(dependencies.getConfig(), latest.principal.accountId)) return noStoreJson({ error: { code: "website_agent_not_enabled_for_account" } }, { status: 403 });
      return null;
    };
    const authorizedResponse = async (body: unknown, status = 200): Promise<Response> =>
      await currentAccessError() ?? noStoreJson(body, { status });
    const db = dependencies.getDatabase();
    if (operation === "list") return await authorizedResponse({ sessions: await dependencies.list(db, principal.accountId) });
    if (operation === "create") {
      z.object({}).strict().parse(await readJsonRequestWithinLimit(request, 4_096));
      const accessError = await currentAccessError();
      if (accessError) return accessError;
      return await authorizedResponse({ session: await dependencies.create(db, principal.accountId) }, 201);
    }
    const id = sessionIdSchema.parse(sessionId);
    if (operation === "load") return await authorizedResponse({ session: await dependencies.load(db, principal.accountId, id) });
    const body = revisionSchema.parse(await readJsonRequestWithinLimit(request, 4_096));
    const accessError = await currentAccessError();
    if (accessError) return accessError;
    return await authorizedResponse({ session: await dependencies.close(db, { accountId: principal.accountId, sessionId: id, expectedRevision: body.expected_revision }) });
  } catch (error) {
    if (error instanceof WebsiteAgentSessionError) return noStoreJson({ error: { code: error.code } }, {
      status: error.code === "session_not_found" ? 404 : error.code === "session_expired" ? 410 : error.code === "session_unavailable" ? 503 : 409,
    });
    if (error instanceof WebsiteAgentUnavailableError) return noStoreJson({ error: { code: error.code } }, { status: 503 });
    if (error instanceof RequestBodyTooLargeError) return noStoreJson({ error: { code: "request_too_large" } }, { status: 413 });
    if (error instanceof z.ZodError || error instanceof InvalidRequestBodyError) return noStoreJson({ error: { code: "invalid_request" } }, { status: 400 });
    console.error("website_agent_session_failed", { name: error instanceof Error ? error.name : "UnknownError" });
    return noStoreJson({ error: { code: "session_unavailable" } }, { status: 503 });
  }
}
