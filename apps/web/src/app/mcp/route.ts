import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { oauthDefaultScopesByAudience } from "@attention/auth";
import type { AttentionDatabase } from "@attention/db";
import { after, type NextRequest } from "next/server";

import { resolveCloudPrincipal, type CloudPrincipal } from "../../server/cloud-credentials";
import { getWebDatabase } from "../../server/db";
import { createAttentionMcpServer } from "../../server/mcp-tool-adapter";
import { oauthResourceMetadataUrl } from "../../server/oauth-resources";
import { recordAttentionToolAuditBestEffort } from "../../server/attention-tool-audit";
import {
  consumeMcpRequestBudget,
  type McpRateLimitDecision,
} from "../../server/mcp-rate-limit";
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
        "WWW-Authenticate": `Bearer resource_metadata="${oauthResourceMetadataUrl(request, "attention-mcp")}", scope="${oauthDefaultScopesByAudience["attention-mcp"].join(" ")}"`,
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

type McpRateLimitConsumer = (
  db: AttentionDatabase,
  principal: CloudPrincipal,
) => Promise<McpRateLimitDecision>;

export interface McpRequestDependencies {
  getDatabase(): AttentionDatabase;
  principalResolver: CloudPrincipalResolver;
  rateLimitConsumer?: McpRateLimitConsumer;
}

const defaultMcpRequestDependencies: McpRequestDependencies = {
  getDatabase: getWebDatabase,
  principalResolver: resolveCloudPrincipal,
};

export async function handleMcpRequest(
  request: Request,
  dependencies: McpRequestDependencies = defaultMcpRequestDependencies,
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
  const principal = await dependencies.principalResolver(
    boundedRequest,
    "attention-mcp",
  );
  if (!principal) return withMcpCors(unauthorized(boundedRequest));
  let database: AttentionDatabase;
  let rateLimit: McpRateLimitDecision;
  try {
    database = dependencies.getDatabase();
    rateLimit = await (
      dependencies.rateLimitConsumer ?? consumeMcpRequestBudget
    )(database, principal);
  } catch (error) {
    console.error("attention_mcp_rate_limit_failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return withMcpCors(
      Response.json(
        {
          error: "rate_limit_unavailable",
          error_description: "Attention could not verify the MCP request budget.",
        },
        {
          headers: { "Cache-Control": "no-store" },
          status: 503,
        },
      ),
    );
  }
  if (!rateLimit.allowed) {
    return withMcpCors(
      Response.json(
        {
          error: "rate_limited",
          retry_after_seconds: rateLimit.retryAfterSeconds,
        },
        {
          headers: {
            "Cache-Control": "no-store",
            "Retry-After": String(rateLimit.retryAfterSeconds),
          },
          status: 429,
        },
      ),
    );
  }
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
    getDatabase: () => database,
    isFilter: principal.isFilter,
    isMember: principal.isMember,
    recordAudit: (db, input) => {
      after(() => recordAttentionToolAuditBestEffort(db, input));
    },
    requestId: crypto.randomUUID(),
    serviceOrigin: new URL(boundedRequest.url).origin,
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
