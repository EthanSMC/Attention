import "server-only";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  attentionToolRegistry,
  type AttentionToolBaseContext,
  type AttentionToolDefinition,
  type AttentionToolResult,
} from "./attention-tool-registry";

const MCP_SERVER_INFO = {
  name: "attention-mcp-server",
  version: "0.1.0",
} as const;

function encodeToolResult(result: AttentionToolResult): CallToolResult {
  if (!result.ok) {
    return {
      content: [
        {
          type: "text",
          text: `${result.code}: ${result.guidance}`,
        },
      ],
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(result.value) }],
    structuredContent: result.value,
  };
}

function jsonInputSchema(
  definition: AttentionToolDefinition,
): Tool["inputSchema"] {
  return z.toJSONSchema(definition.inputSchema, {
    target: "draft-7",
  }) as Tool["inputSchema"];
}

/**
 * The low-level SDK server is intentional here: the canonical Registry owns
 * strict input validation so malformed calls receive the same stable tool
 * error and audit path as every other entrypoint. Tool discovery still
 * advertises the Registry's complete JSON Schema.
 */
export function createAttentionMcpServer(
  context: AttentionToolBaseContext,
  registry: readonly AttentionToolDefinition[] = attentionToolRegistry,
): Server {
  const visibleTools = registry.filter((definition) =>
    definition.isVisible(context),
  );
  const byName = new Map<string, AttentionToolDefinition>(
    visibleTools.map((definition) => [definition.name, definition]),
  );
  const server = new Server(MCP_SERVER_INFO, {
    capabilities: { tools: { listChanged: true } },
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: visibleTools.map((definition) => ({
      annotations: definition.annotations,
      description: definition.description,
      inputSchema: jsonInputSchema(definition),
      name: definition.name,
      title: definition.title,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const definition = byName.get(request.params.name);
    if (!definition) {
      return encodeToolResult({
        code: "tool_not_found",
        guidance: "Refresh the Attention tool list before calling this tool.",
        ok: false,
      });
    }
    return encodeToolResult(
      await definition.invoke(
        {
          ...context,
          runId: `${context.requestId}:${String(extra.requestId)}`,
          signal: extra.signal,
        },
        request.params.arguments ?? {},
      ),
    );
  });

  return server;
}
