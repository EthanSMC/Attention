/**
 * Attention HTTP API client.
 *
 * Wraps the Attention MCP endpoint with Bearer token authentication.
 * Uses @attention/contracts Zod schemas for response validation.
 */

import {
  ATTENTION_MCP_TOOL_NAMES,
  AttentionToolStructuredErrorSchema,
} from "@attention/contracts";
import { type AttentionConfig, loadAttentionConfig, mcpEndpoint } from "./config.js";

export interface AttentionClientOptions {
  readonly config?: Partial<AttentionConfig> | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

export interface AttentionToolCallResult {
  readonly ok: boolean;
  readonly value?: Record<string, unknown>;
  readonly error?: {
    readonly code: string;
    readonly guidance: string;
    readonly requestId: string;
    readonly requiredEntitlement?: string | undefined;
    readonly requiredScope?: string | undefined;
    readonly retryAfterSeconds?: number | undefined;
  };
}

export interface AttentionToolInfo {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly annotations?: Record<string, unknown>;
  readonly title?: string;
}

export class AttentionClient {
  private readonly config: AttentionConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AttentionClientOptions = {}) {
    this.config = loadAttentionConfig(options.config);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get endpoint(): string {
    return mcpEndpoint(this.config);
  }

  /** List all available Attention tools. */
  async listTools(): Promise<readonly AttentionToolInfo[]> {
    const response = await this.mcpRequest("tools/list", {});
    const tools = response?.tools as readonly AttentionToolInfo[] | undefined;
    if (!Array.isArray(tools)) {
      throw new Error("MCP tools/list did not return a valid tools array.");
    }
    return tools;
  }

  /** Call a named Attention tool with arguments. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<AttentionToolCallResult> {
    const result = await this.mcpRequest("tools/call", {
      name,
      arguments: args,
    });

    // Check for structured error
    const errorParse = AttentionToolStructuredErrorSchema.safeParse(result);
    if (errorParse.success) {
      return {
        ok: false,
        error: {
          code: errorParse.data.error.code,
          guidance: errorParse.data.error.guidance,
          requestId: errorParse.data.error.request_id,
          requiredEntitlement:
            errorParse.data.error.required_entitlement,
          requiredScope: errorParse.data.error.required_scope,
          retryAfterSeconds:
            errorParse.data.error.retry_after_seconds,
        },
      };
    }

    // Check for MCP-level error
    if (result?.isError) {
      const content = Array.isArray(result.content)
        ? result.content
        : [];
      const text = content
        .filter(
          (c): c is { type: "text"; text: string } =>
            (c as Record<string, unknown>).type === "text",
        )
        .map((c) => c.text)
        .join("\n");
      return {
        ok: false,
        error: {
          code: "mcp_error",
          guidance: text || "Unknown MCP error.",
          requestId: "unknown",
        },
      };
    }

    // Success — extract structuredContent or content
    const value =
      result?.structuredContent ??
      (() => {
        const content = Array.isArray(result?.content)
          ? result.content
          : [];
        const text = content
          .filter(
            (c): c is { type: "text"; text: string } =>
              (c as Record<string, unknown>).type === "text",
          )
          .map((c) => c.text)
          .join("");
        try {
          return text ? JSON.parse(text) : {};
        } catch {
          return { text };
        }
      })();

    return { ok: true, value: value as Record<string, unknown> };
  }

  /** Send a JSON-RPC request to the MCP endpoint. */
  private async mcpRequest(
    method: string,
    params: unknown,
  ): Promise<Record<string, unknown>> {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      params,
    });

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + this.config.apiKey,
            "Content-Type": "application/json",
            "Accept": "application/json",
          },
          body,
          signal: AbortSignal.timeout(this.config.timeoutMs),
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => "");
          throw new Error(
            "MCP request failed with HTTP " +
              String(response.status) +
              ": " +
              errorText.slice(0, 200),
          );
        }

        const data = (await response.json()) as Record<string, unknown>;
        if (data.error) {
          throw new Error(
            "MCP JSON-RPC error: " +
              JSON.stringify(data.error).slice(0, 200),
          );
        }
        return (data.result as Record<string, unknown>) ?? {};
      } catch (error) {
        lastError =
          error instanceof Error ? error : new Error(String(error));
        if (attempt < this.config.maxRetries) {
          // Exponential backoff: 1s, 2s, 4s, ...
          await new Promise((resolve) =>
            setTimeout(resolve, 1000 * Math.pow(2, attempt)),
          );
        }
      }
    }
    throw lastError ?? new Error("MCP request failed after retries.");
  }
}

/** Validate that a tool name is a known Attention tool. */
export function isAttentionToolName(name: string): boolean {
  return (ATTENTION_MCP_TOOL_NAMES as readonly string[]).includes(name);
}
