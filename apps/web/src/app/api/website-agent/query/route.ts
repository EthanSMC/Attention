import { handleWebsiteAgentRequest } from "../../../../server/website-agent-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 90;

export async function POST(request: Request): Promise<Response> {
  return handleWebsiteAgentRequest(request);
}
