import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { after, type NextRequest } from "next/server";

import { resolveCloudPrincipal, type CloudPrincipal } from "../../server/cloud-credentials";
import { getWebDatabase } from "../../server/db";
import { createAttentionMcpServer } from "../../server/mcp-tool-adapter";
import { oauthResourceMetadataUrl } from "../../server/oauth-resources";
import { recordAttentionToolAuditBestEffort } from "../../server/attention-tool-audit";
import {
  readRequestBytesWithinLimit,
  RequestBodyTooLargeError,
} from "../../server/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_MCP_BODY_BYTES = 65_536;

function unauthorized(request: Request): Response {
  return Response.json(
    { error: "invalid_token", error_description: "Connect this MCP server with Attention OAuth." },
    {
      headers: {
        "Cache-Control": "no-store",
        "WWW-Authenticate": `Bearer resource_metadata="${oauthResourceMetadataUrl(request, "attention-mcp")}"`,
      },
      status: 401,
    },
  );
}

function withMcpCors(response: Response): Response {
  response.headers.set("Access-Control-Allow-Headers", "authorization, content-type, mcp-protocol-version, mcp-session-id");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Expose-Headers", "mcp-protocol-version, mcp-session-id, www-authenticate");
  return response;
}

type CloudPrincipalResolver = (
  request: Request,
  audience: "attention-mcp" | "attention-sync",
) => Promise<CloudPrincipal | null>;

export async function handleMcpRequest(
  request: Request,
  principalResolver: CloudPrincipalResolver = resolveCloudPrincipal,
): Promise<Response> {
  let boundedRequest: Request;
  try {
    const body = await readRequestBytesWithinLimit(request, MAX_MCP_BODY_BYTES);
    const carriesBody = request.method !== "GET" && request.method !== "HEAD" && body.byteLength > 0;
    const boundedBody = carriesBody
      ? new Blob([
          body.buffer.slice(
            body.byteOffset,
            body.byteOffset + body.byteLength,
          ) as ArrayBuffer,
        ])
      : null;
    boundedRequest = new Request(request.url, {
      ...(boundedBody ? { body: boundedBody } : {}),
      headers: request.headers,
      method: request.method,
      signal: request.signal,
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return withMcpCors(
        Response.json({ error: "request_too_large" }, { status: 413 }),
      );
    }
    throw error;
  }
  const principal = await principalResolver(boundedRequest, "attention-mcp");
  if (!principal) return withMcpCors(unauthorized(boundedRequest));
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  const server = createAttentionMcpServer({
    accountId: principal.accountId,
    caller: {
      clientId: principal.clientId,
      credentialId: principal.credentialId,
      credentialKind: principal.credentialKind,
      entrypoint: "hosted_mcp",
    },
    getDatabase: getWebDatabase,
    isFilter: principal.isFilter,
    isMember: principal.isMember,
    recordAudit: (db, input) => {
      after(() => recordAttentionToolAuditBestEffort(db, input));
    },
    requestId: crypto.randomUUID(),
    scopes: principal.scopes,
  });
  await server.connect(transport);
  return withMcpCors(await transport.handleRequest(boundedRequest));
}

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
