import type { NextRequest } from "next/server";
import { handleMcpRequest } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> { return handleMcpRequest(request); }
export async function GET(request: NextRequest): Promise<Response> { return handleMcpRequest(request); }
export async function DELETE(request: NextRequest): Promise<Response> { return handleMcpRequest(request); }

export function OPTIONS(): Response {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "mcp-protocol-version, mcp-session-id, www-authenticate",
    },
    status: 204,
  });
}
