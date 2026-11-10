import { handleWebsiteAgentSessionRequest } from "../../../../server/website-agent-session-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleWebsiteAgentSessionRequest(request, "list");
}
export async function POST(request: Request): Promise<Response> {
  return handleWebsiteAgentSessionRequest(request, "create");
}
