import { handleWebsiteAgentActionRequest } from "../../../../../../../../server/website-agent-action-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ sessionId: string; actionId: string }> }): Promise<Response> {
  const { sessionId, actionId } = await context.params;
  return handleWebsiteAgentActionRequest(request, "decline", sessionId, actionId);
}
