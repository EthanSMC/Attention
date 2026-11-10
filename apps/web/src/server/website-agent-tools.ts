import "server-only";

import type { WebsiteAgentTool } from "@attention/website-agent";
import { z } from "zod";

import { attentionToolRegistry, type AttentionToolBaseContext, type AttentionToolDefinition } from "./attention-tool-registry";

const readTools = new Set([
  "attention_get_my_account", "attention_get_membership_status", "attention_list_collections",
  "attention_get_collection_status", "attention_list_public_content", "attention_search_content", "attention_get_digest_settings",
]);

export const WEBSITE_AGENT_READ_SCOPES = ["profile:read", "subscription:read", "collection:read", "public:read", "public:full", "ai:search", "digest:read"] as const;

/**
 * Transport adapter only: the canonical registry still owns input/output
 * schemas, business logic, live Core authorization, and tool-call auditing.
 * Consequential write tools require a separate trusted confirmation UI and
 * are intentionally not supplied to the model in this pilot.
 */
export function createWebsiteAgentTools(input: {
  context: AttentionToolBaseContext;
  getCurrentContext(): Promise<AttentionToolBaseContext | null>;
  operationId: string;
  query: string;
  collect: boolean;
  readSources: boolean;
  registry?: readonly AttentionToolDefinition[];
}): WebsiteAgentTool[] {
  const allowed = new Set(readTools);
  if (input.collect) allowed.add("attention_collect_content");
  if (input.readSources) allowed.add("attention_read_collection_source");
  return (input.registry ?? attentionToolRegistry)
    .filter(definition => allowed.has(definition.name) && definition.isVisible(input.context))
    .map(definition => {
      const collect = definition.name === "attention_collect_content";
      return {
        name: definition.name,
        description: collect
          ? "Save links from the original user message as private Attention collections. The server fixes the message, visibility, and retry key; no arguments are accepted. This does not imply the source was read or summarized."
          : definition.description,
        inputSchema: z.toJSONSchema(collect ? z.object({}).strict() : definition.inputSchema, { target: "draft-7" }) as Record<string, unknown>,
        async invoke(args, execution) {
          execution.signal.throwIfAborted();
          const current = await input.getCurrentContext();
          execution.signal.throwIfAborted();
          if (!current || current.accountId !== input.context.accountId || !current.isMember || !definition.isVisible(current)) {
            return { ok: false, code: "permission_revoked", guidance: "Sign in again and check your current Attention access." };
          }
          // The model can never widen collection data, visibility or operation.
          const rawInput = collect ? { input: input.query, visibility: "private", idempotency_key: `website:${input.operationId}` } : args;
          return definition.invoke({ ...current, runId: `website:${input.operationId}:${execution.toolCallId}`.slice(0, 128), signal: execution.signal }, rawInput);
        },
      };
    });
}
