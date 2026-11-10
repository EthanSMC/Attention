import "server-only";

import type { WebsiteAgentTool } from "@attention/website-agent";
import { z } from "zod";

import { attentionToolRegistry, type AttentionToolBaseContext, type AttentionToolDefinition } from "./attention-tool-registry";
import { websiteAgentActionInputSchema, websiteAgentToolPolicy, type WebsiteAgentReviewedToolName } from "./website-agent-action-policy";

export const WEBSITE_AGENT_READ_SCOPES = ["profile:read", "subscription:read", "collection:read", "public:read", "public:full", "ai:search", "digest:read", "moderation:court:read"] as const;
export const WEBSITE_AGENT_TOOL_SCOPES = [...WEBSITE_AGENT_READ_SCOPES, "collection:write", "digest:write", "moderation:write", "moderation:court:vote"] as const;
const collectSchema = z.object({ visibility: z.enum(["private", "public"]).default("private") }).strict();

/**
 * Transport adapter only: the canonical registry still owns input/output
 * schemas, business logic, live Core authorization, and tool-call auditing.
 * All canonical capabilities are classified explicitly. A model call proposes
 * consequential writes; only the separate trusted review endpoint executes them.
 */
export function createWebsiteAgentTools(input: {
  context: AttentionToolBaseContext;
  getCurrentContext(): Promise<AttentionToolBaseContext | null>;
  operationId: string;
  query: string;
  collect: boolean;
  readSources: boolean;
  proposeAction?(toolName: WebsiteAgentReviewedToolName, rawInput: unknown,
    execution: { signal: AbortSignal; toolCallId: string }): Promise<unknown>;
  registry?: readonly AttentionToolDefinition[];
}): WebsiteAgentTool[] {
  return (input.registry ?? attentionToolRegistry)
    .filter(definition => Object.hasOwn(websiteAgentToolPolicy, definition.name) && definition.isVisible(input.context))
    .map(definition => {
      const collect = definition.name === "attention_collect_content";
      const policy = websiteAgentToolPolicy[definition.name];
      const schema = collect ? collectSchema : policy === "reviewed_action"
        ? websiteAgentActionInputSchema(definition.name as WebsiteAgentReviewedToolName) : definition.inputSchema;
      const description = collect
        ? "Save only links from the original user message as private Attention collections, and only with the form's collect consent. The server fixes the message and retry key. Public collection prepares an exact human review and does not publish before approval. This does not imply the source was read or summarized."
        : policy === "reviewed_action" ? `${definition.description} ${definition.name === "attention_submit_content_enrichment" ? "First read the owned article with source-reading consent in this same run. Review requires fresh server-attested ready article evidence, the exact summary/title/tags/final URL, and all shared merge/notification effects. " : ""}This website call only proposes the exact action for a separate user review card. It never executes the write or proves user approval.`
          : policy === "source_read_consent" ? `${definition.description} Without this request's source-reading consent, returns source_read_consent_required.`
            : policy === "candidate_review_required" ? `${definition.description} The human must choose a server-owned option in the website candidate review. A model token or candidate choice never authorizes selection.`
              : definition.description;
      return {
        name: definition.name,
        description,
        inputSchema: z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>,
        async invoke(args, execution) {
          execution.signal.throwIfAborted();
          const current = await input.getCurrentContext();
          execution.signal.throwIfAborted();
          if (!current || current.accountId !== input.context.accountId ||
            current.caller.credentialId !== input.context.caller.credentialId || current.caller.credentialKind !== "session" ||
            current.caller.entrypoint !== "hosted_agent" || !current.isMember || !definition.isVisible(current)) {
            return { ok: false, code: "permission_revoked", guidance: "Sign in again and check your current Attention access." };
          }
          if (policy === "source_read_consent" && !input.readSources)
            return { ok: false, code: "source_read_consent_required", guidance: "Ask the user to enable source reading for a new request. No source was read." };
          if (policy === "candidate_review_required") return { ok: false, code: "candidate_selection_review_required",
            guidance: "The user must choose the exact candidate in the website selection card, then review its effects. No candidate was selected by the model." };
          if (policy === "reviewed_action") {
            const parsed = schema.safeParse(args);
            if (!parsed.success) return { ok: false, code: "invalid_request", guidance: "Use the action schema. A model-provided confirmation flag is not user approval." };
            if (!input.proposeAction) return { ok: false, code: "action_review_unavailable", guidance: "The trusted action review is unavailable. No change was made." };
            return input.proposeAction(definition.name as WebsiteAgentReviewedToolName, parsed.data, execution);
          }
          if (collect) {
            const parsed = collectSchema.safeParse(args);
            if (!parsed.success) return { ok: false, code: "invalid_request", guidance: "Only the requested visibility is accepted; source input is fixed to the original user message." };
            if (parsed.data.visibility === "public") {
              if (!current.isFilter) return { ok: false, code: "filter_required", guidance: "Public collection requires current Filter access." };
              if (!input.proposeAction) return { ok: false, code: "action_review_unavailable", guidance: "The trusted action review is unavailable. Nothing was saved." };
              return input.proposeAction("attention_collect_content", { input: input.query, visibility: "public", idempotency_key: `website-review:${input.operationId}` }, execution);
            }
            if (!input.collect) return { ok: false, code: "collection_consent_required", guidance: "Ask the user to enable private collection for a new request. Nothing was saved." };
          }
          // The model can never widen collection data, visibility or operation.
          const rawInput = collect ? { input: input.query, visibility: "private", idempotency_key: `website:${input.operationId}` } : args;
          const result = await definition.invoke({ ...current, runId: `website:${input.operationId}:${execution.toolCallId}`.slice(0, 128), signal: execution.signal }, rawInput);
          if (collect && ((result.ok && result.value.status === "ambiguous") || (!result.ok && result.code === "website_collection_review_required"))) {
            if (!input.proposeAction) return { ok: false, code: "action_review_unavailable", guidance: "No collection was changed. The trusted review is unavailable." };
            return input.proposeAction("attention_collect_content", { input: input.query, visibility: "private",
              idempotency_key: result.ok ? `website:${input.operationId}` : `website-review-private:${input.operationId}` }, execution);
          }
          // Selection capabilities are server-only, even within the live model run.
          if (collect && result.ok) {
            const value = { ...result.value };
            delete value.selection_token;
            return { ...result, value };
          }
          return result;
        },
      };
    });
}
