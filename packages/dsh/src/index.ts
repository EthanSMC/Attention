/**
 * @attention/dsh — DeepSeek Harness plugin for Attention
 *
 * Provides:
 * - Attention MCP tools (15 tools for collection management)
 * - iLink WeChat channel (receive and reply to WeChat messages)
 * - Runtime reporter (optional health checkpoints)
 */

export { createAttentionPlugin, type AttentionPluginOptions } from "./plugin.js";
export { AttentionClient, type AttentionClientOptions } from "./attention-client.js";
export { AttentionMcpClient } from "./mcp-client.js";
export { createAttentionToolRegistry } from "./tools/registry.js";
