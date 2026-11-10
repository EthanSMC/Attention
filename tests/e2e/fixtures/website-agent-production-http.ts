// NextRequest canonicalizes loopback IP URLs to localhost. Use the same browser
// origin instead of overriding Origin or weakening the real mutation guard.
// The standalone process still binds only to 127.0.0.1.
export const productionOrigin = "http://localhost:4179";

const safeErrorCodes = new Set([
  "authentication_required", "membership_required", "website_agent_not_enabled_for_account",
  "cross_origin_request", "invalid_request", "request_too_large", "session_unavailable",
  "session_conflict", "session_not_found", "session_expired", "session_closed", "action_outcome_unknown",
]);

/** Never emit a response body, arbitrary error text, cookies, tokens, or headers. */
export async function productionResponseDiagnostic(status: number, readJson: () => Promise<unknown>): Promise<string> {
  if (status < 400) return `HTTP ${status}`;
  try {
    const body = await readJson();
    const error = body && typeof body === "object" && "error" in body ? body.error : undefined;
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    return `HTTP ${status}; error=${typeof code === "string" && safeErrorCodes.has(code) ? code : "unrecognized_error"}`;
  } catch {
    return `HTTP ${status}; error=unreadable_error`;
  }
}
