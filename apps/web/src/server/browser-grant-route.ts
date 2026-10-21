import "server-only";
import { BrowserEnrichmentError, resolveBrowserGrant } from "./browser-private-enrichment";
import { getWebDatabase } from "./db";

/** Capability-only endpoint. No session cookies, redirects, CORS or token logs. */
export async function handleBrowserGrantResolve(request: Request): Promise<Response> {
  const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
  const token = /^Bearer (att_browser_[a-f0-9]{64})$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!token) return Response.json({ error: "permission_revoked" }, { status: 403, headers });
  // Resolution has no request payload; do not buffer attacker-controlled bodies.
  if (request.headers.get("content-length") && Number(request.headers.get("content-length")) > 2)
    return Response.json({ error: "invalid_request" }, { status: 400, headers });
  try {
    return Response.json(await resolveBrowserGrant(getWebDatabase(), token), { headers });
  } catch (error) {
    const status = error instanceof BrowserEnrichmentError ? error.status : 503;
    return Response.json({ error: error instanceof BrowserEnrichmentError ? error.code : "unavailable" }, { status, headers });
  }
}
