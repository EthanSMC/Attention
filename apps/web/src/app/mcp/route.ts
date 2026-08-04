import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { collectFromWeb, selectCandidateFromWeb } from "../../server/collection-service";
import { resolveCloudPrincipal, type CloudPrincipal } from "../../server/cloud-credentials";
import { loadMyCollections, loadPublicContents } from "../../server/content-queries";
import { getWebDatabase } from "../../server/db";
import { retrieveForAgent } from "../../server/agent-retrieval";
import { publicFeedPreviewLimit } from "../../server/public-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function hasScope(principal: CloudPrincipal, scope: string): boolean {
  return principal.scopes.includes(scope);
}

function jsonToolResult(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function toolError(code: string, guidance: string) {
  return {
    content: [{ type: "text" as const, text: `${code}: ${guidance}` }],
    isError: true,
  };
}

function createMcpServer(principal: CloudPrincipal): McpServer {
  const server = new McpServer({ name: "attention-mcp-server", version: "0.1.0" });

  server.registerTool(
    "attention_list_collections",
    {
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: true },
      description: "List the authenticated account's private and public collections. Returns original-link routes, never another account's private data.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).default(20),
        offset: z.number().int().min(0).default(0),
        query: z.string().trim().max(200).optional(),
      }).strict(),
      title: "List Attention collections",
    },
    async ({ limit, offset, query }) => {
      if (!hasScope(principal, "collection:read")) return toolError("insufficient_scope", "Reconnect with collection:read.");
      const allItems = await loadMyCollections(getWebDatabase(), principal.accountId);
      const normalizedQuery = query?.toLocaleLowerCase("zh-CN");
      const filtered = normalizedQuery
        ? allItems.filter((item) => `${item.title} ${item.summary ?? ""} ${item.source} ${item.author ?? ""}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery))
        : allItems;
      const items = filtered.slice(offset, offset + limit).map((item) => ({
        author: item.author,
        collected_at: item.collectedAt,
        collection_id: item.id,
        original_url: item.outboundHref,
        source: item.source,
        summary: item.summary,
        title: item.title,
        visibility: item.visibility,
      }));
      return jsonToolResult({
        count: items.length,
        has_more: offset + items.length < filtered.length,
        items,
        next_offset: offset + items.length < filtered.length ? offset + items.length : null,
        offset,
        total_count: filtered.length,
      });
    },
  );

  server.registerTool(
    "attention_collect_content",
    {
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: false },
      description: "Save a URL or platform share text to the authenticated account. Free accounts can save unlimited private links; public visibility requires live Filter status.",
      inputSchema: z.object({
        idempotency_key: z.string().min(8).max(128).optional(),
        input: z.string().trim().min(1).max(32_768),
        visibility: z.enum(["private", "public"]).default("private"),
      }).strict(),
      title: "Collect a link in Attention",
    },
    async ({ idempotency_key, input, visibility }) => {
      if (!hasScope(principal, "collection:write")) return toolError("insufficient_scope", "Reconnect with collection:write.");
      if (visibility === "public" && !principal.isFilter) return toolError("filter_required", "Only an active Filter can create public collections.");
      try {
        const result = await collectFromWeb(getWebDatabase(), principal, {
          idempotency_key: idempotency_key ?? crypto.randomUUID(),
          raw_input: input,
          visibility,
        });
        return jsonToolResult(result as unknown as Record<string, unknown>);
      } catch (error) {
        console.error("mcp_collect_failed", { name: error instanceof Error ? error.name : "UnknownError" });
        return toolError("collection_failed", "Check the link or share text and try again.");
      }
    },
  );

  server.registerTool(
    "attention_select_collection_candidate",
    {
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: false },
      description: "Complete an ambiguous collection after attention_collect_content returns candidate IDs and a one-time selection token.",
      inputSchema: z.object({
        candidate_id: z.string().uuid(),
        selection_token: z.string().min(32).max(512),
        visibility: z.enum(["private", "public"]).default("private"),
      }).strict(),
      title: "Select a collection candidate",
    },
    async (input) => {
      if (!hasScope(principal, "collection:write")) return toolError("insufficient_scope", "Reconnect with collection:write.");
      if (input.visibility === "public" && !principal.isFilter) return toolError("filter_required", "Only an active Filter can create public collections.");
      try {
        return jsonToolResult(await selectCandidateFromWeb(getWebDatabase(), principal, input) as unknown as Record<string, unknown>);
      } catch {
        return toolError("selection_failed", "The token may be expired or already used. Submit the content again.");
      }
    },
  );

  server.registerTool(
    "attention_list_public_content",
    {
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: true },
      description: "List public Attention content in current chronological order. Free credentials receive only the same server-configured preview window as the website.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(50).default(20), offset: z.number().int().min(0).default(0) }).strict(),
      title: "List public Attention content",
    },
    async ({ limit, offset }) => {
      if (!hasScope(principal, "public:read") && !hasScope(principal, "public:full")) return toolError("insufficient_scope", "Reconnect with public:read.");
      const allItems = await loadPublicContents(getWebDatabase());
      const hasFullPublicAccess = principal.isMember && hasScope(principal, "public:full");
      const accessible = hasFullPublicAccess
        ? allItems
        : allItems.slice(0, publicFeedPreviewLimit());
      const items = accessible.slice(offset, offset + limit).map((item) => ({
        author: item.author,
        content_id: item.id,
        first_public_at: item.firstPublicAt,
        original_url: item.outboundHref,
        source: item.source,
        summary: item.summary,
        title: item.title,
      }));
      return jsonToolResult({
        count: items.length,
        has_more: offset + items.length < accessible.length,
        items,
        next_offset: offset + items.length < accessible.length ? offset + items.length : null,
        offset,
        preview_limited: !hasFullPublicAccess && allItems.length > accessible.length,
        total_count: accessible.length,
      });
    },
  );

  if (principal.isMember && hasScope(principal, "ai:search")) {
    server.registerTool(
      "attention_search_content",
      {
        annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: true },
        description: "Search the authenticated account's collections and the complete public network. Returns cited original-link routes. Requires live Member status on every call.",
        inputSchema: z.object({ query: z.string().trim().min(2).max(500) }).strict(),
        title: "Search Attention content",
      },
      async ({ query }) => jsonToolResult(await retrieveForAgent(getWebDatabase(), principal.accountId, query) as unknown as Record<string, unknown>),
    );
  }

  return server;
}

function unauthorized(request: NextRequest): Response {
  const origin = process.env.NEXT_PUBLIC_APP_URL
    ? new URL(process.env.NEXT_PUBLIC_APP_URL).origin
    : request.nextUrl.origin;
  return Response.json(
    { error: "invalid_token", error_description: "Connect this MCP server with Attention OAuth." },
    {
      headers: {
        "Cache-Control": "no-store",
        "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
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

async function handle(request: NextRequest): Promise<Response> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 65_536) {
    return withMcpCors(Response.json({ error: "request_too_large" }, { status: 413 }));
  }
  const principal = await resolveCloudPrincipal(request, "attention-mcp");
  if (!principal) return withMcpCors(unauthorized(request));
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  const server = createMcpServer(principal);
  await server.connect(transport);
  return withMcpCors(await transport.handleRequest(request));
}

export async function POST(request: NextRequest): Promise<Response> { return handle(request); }
export async function GET(request: NextRequest): Promise<Response> { return handle(request); }
export async function DELETE(request: NextRequest): Promise<Response> { return handle(request); }

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
