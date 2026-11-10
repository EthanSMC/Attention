import { handleWebsiteAgentSessionRequest } from "../../../../../../server/website-agent-session-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }): Promise<Response> {
  return handleWebsiteAgentSessionRequest(request, "close", (await context.params).sessionId);
}
