import { handleWebsiteAgentSessionRequest } from "../../../../../server/website-agent-session-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ sessionId: string }> }): Promise<Response> {
  return handleWebsiteAgentSessionRequest(request, "load", (await context.params).sessionId);
}
