/**
 * Attention Tool Registry for DSH Cordis.
 *
 * Maps Attention MCP tools to Cordis tool definitions.
 * Each tool validates input, calls the MCP client, and returns structured output.
 */

import { AttentionMcpClient } from "../mcp-client.js";
import type { AttentionToolCallResult } from "../attention-client.js";

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  invoke(args: Record<string, unknown>): Promise<AttentionToolCallResult>;
}

export interface ToolRegistryOptions {
  readonly mcp: AttentionMcpClient;
}

const TOOL_DESCRIPTIONS: Record<string, string> = {
  attention_get_my_account:
    "Read the authenticated account's public Attention identity and live capabilities.",
  attention_get_membership_status:
    "Read the current Attention membership and subscription state.",
  attention_list_collections:
    "List the authenticated account's saved collections with pagination.",
  attention_collect_content:
    "Save a link or platform share text to an Attention collection.",
  attention_submit_content_enrichment:
    "Submit a grounded title, summary, and tags for collected content.",
  attention_select_collection_candidate:
    "Choose one candidate from an ambiguous collection result.",
  attention_get_collection_status:
    "Read the current processing status of a collection attempt.",
  attention_update_collection:
    "Change the visibility of an owned collection (public/private).",
  attention_list_public_content:
    "Browse the public feed of curated content with pagination.",
  attention_search_content:
    "AI-powered search across accessible Attention content.",
  attention_report_content:
    "Report public content for community moderation review.",
  attention_list_moderation_cases:
    "List open moderation court cases (Filter only).",
  attention_cast_moderation_vote:
    "Cast a vote in a moderation court case (Filter only).",
  attention_get_digest_settings:
    "Read the current daily digest subscription settings.",
  attention_update_digest_settings:
    "Update daily digest domains, timezone, and delivery window.",
};

export function createAttentionToolRegistry(
  options: ToolRegistryOptions,
): readonly ToolDefinition[] {
  const { mcp } = options;

  const makeTool = (name: string): ToolDefinition => ({
    name,
    description: TOOL_DESCRIPTIONS[name] ?? "Attention tool: " + name,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true,
    },
    invoke: (args: Record<string, unknown>) => mcp.call(name, args),
  });

  return [
    "attention_get_my_account",
    "attention_get_membership_status",
    "attention_list_collections",
    "attention_collect_content",
    "attention_submit_content_enrichment",
    "attention_select_collection_candidate",
    "attention_get_collection_status",
    "attention_update_collection",
    "attention_list_public_content",
    "attention_search_content",
    "attention_report_content",
    "attention_list_moderation_cases",
    "attention_cast_moderation_vote",
    "attention_get_digest_settings",
    "attention_update_digest_settings",
  ].map(makeTool);
}
