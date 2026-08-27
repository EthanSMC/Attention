/**
 * Attention MCP Client — JSON-RPC 2.0 over HTTP transport.
 *
 * Thin wrapper around the AttentionClient that provides
 * tool-calling primitives for Cordis tool implementations.
 */

import {
  AttentionClient,
  type AttentionClientOptions,
  type AttentionToolCallResult,
  type AttentionToolInfo,
  isAttentionToolName,
} from "./attention-client.js";

export class AttentionMcpClient {
  readonly #client: AttentionClient;
  #toolsCache: readonly AttentionToolInfo[] | null = null;

  constructor(options: AttentionClientOptions = {}) {
    this.#client = new AttentionClient(options);
  }

  /** Discover available tools (cached). */
  async tools(): Promise<readonly AttentionToolInfo[]> {
    if (!this.#toolsCache) {
      this.#toolsCache = await this.#client.listTools();
    }
    return this.#toolsCache;
  }

  /** Call a tool by name, validating the name first. */
  async call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<AttentionToolCallResult> {
    if (!isAttentionToolName(name)) {
      return {
        ok: false,
        error: {
          code: "tool_not_found",
          guidance:
            "Unknown Attention tool: " +
            name +
            ". Use the available Attention tools instead.",
          requestId: "unknown",
        },
      };
    }
    return await this.#client.callTool(name, args);
  }

  /** Check if the client has valid credentials configured. */
  hasCredentials(): boolean {
    return this.#client["config"] !== undefined;
  }
}
