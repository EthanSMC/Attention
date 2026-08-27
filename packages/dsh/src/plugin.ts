/**
 * Attention DSH Plugin — main orchestrator.
 *
 * Combines the MCP client, iLink channel, and runtime reporter
 * into a single plugin entry point.
 */

import type { AttentionConfig } from "./config.js";
import { loadAttentionConfig } from "./config.js";
import { AttentionMcpClient } from "./mcp-client.js";

export interface AttentionPluginOptions {
  readonly config?: Partial<AttentionConfig> | undefined;
  readonly enableChannel?: boolean | undefined;
  readonly enableRuntimeReporter?: boolean | undefined;
}

export interface AttentionPlugin {
  readonly mcp: AttentionMcpClient;
  readonly config: AttentionConfig;
}

export function createAttentionPlugin(
  options: AttentionPluginOptions = {},
): AttentionPlugin {
  const mcp = new AttentionMcpClient({ config: options.config });

  return {
    mcp,
    config: loadAttentionConfig(options.config),
  };
}
