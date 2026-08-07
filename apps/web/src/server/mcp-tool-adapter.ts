import "server-only";

import { createHash } from "node:crypto";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { AttentionToolStructuredErrorSchema } from "@attention/contracts";
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

function protocolRequestFingerprint(value: string | number): string {
  return `mcp-${createHash("sha256")
    .update(typeof value)
    .update("\0")
    .update(String(value))
    .digest("hex")}`;
}

function encodeToolResult(
  result: AttentionToolResult,
  requestId: string,
): CallToolResult {
  if (!result.ok) {
    return {
      content: [
        {
          type: "text",
          text: `${result.code}: ${result.guidance}`,
        },
      ],
      isError: true,
      structuredContent: {
        error: {
          code: result.code,
          guidance: result.guidance,
          request_id: requestId,
          ...(result.requiredScope
            ? { required_scope: result.requiredScope }
            : {}),
          ...(result.requiredEntitlement
            ? { required_entitlement: result.requiredEntitlement }
            : {}),
          ...(result.retryAfterSeconds !== undefined
            ? { retry_after_seconds: result.retryAfterSeconds }
            : {}),
        },
      },
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

function jsonSchemaBranch(schema: z.ZodType): Record<string, unknown> {
  const converted = z.toJSONSchema(schema, {
    target: "draft-7",
  }) as Record<string, unknown>;
  const { $schema: _schema, ...branch } = converted;
  return branch;
}

function jsonOutputSchema(
  definition: AttentionToolDefinition,
): Tool["outputSchema"] {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    oneOf: [
      jsonSchemaBranch(definition.outputSchema),
      jsonSchemaBranch(AttentionToolStructuredErrorSchema),
    ],
    type: "object",
  } as Tool["outputSchema"];
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
      outputSchema: jsonOutputSchema(definition),
      title: definition.title,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const definition = byName.get(request.params.name);
    if (!definition) {
      return encodeToolResult(
        {
          code: "tool_not_found",
          guidance: "Refresh the Attention tool list before calling this tool.",
          ok: false,
        },
        context.requestId,
      );
    }
    return encodeToolResult(
      await definition.invoke(
        {
          ...context,
          runId: protocolRequestFingerprint(extra.requestId),
          signal: extra.signal,
        },
        request.params.arguments ?? {},
      ),
      context.requestId,
    );
  });

  return server;
}
