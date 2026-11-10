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
        ? "Save only links from the original user message as private Attention collections, and only with the form's collect consent. The server fixes the message and retry key. Public collection returns a review-required gate and does not publish. This does not imply the source was read or summarized."
        : policy === "reviewed_action" ? `${definition.description} This website call only proposes the exact action for a separate user review card. It never executes the write or proves user approval.`
          : policy === "source_read_consent" ? `${definition.description} Without this request's source-reading consent, returns source_read_consent_required.`
            : policy === "candidate_review_required" ? `${definition.description} Website execution requires a trusted user candidate-selection review, which is not yet available. This call returns candidate_selection_review_required without selecting.`
              : policy === "source_evidence_and_merge_review_required" ? `${definition.description} Website execution requires fresh verified source evidence and exact review of shared enrichment, possible identity merges and notifications. This call returns source_evidence_and_merge_review_required without writing.`
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
            guidance: "The user must choose the exact candidate in a trusted selection review. That website review is not available yet; no candidate was selected." };
          if (policy === "source_evidence_and_merge_review_required") return { ok: false, code: "source_evidence_and_merge_review_required",
            guidance: "Shared enrichment needs fresh server-verified article evidence and user review of the exact summary, final URL, possible identity merges and notifications. That review is not available yet; no enrichment was submitted." };
          if (policy === "reviewed_action") {
            const parsed = schema.safeParse(args);
            if (!parsed.success) return { ok: false, code: "invalid_request", guidance: "Use the action schema. A model-provided confirmation flag is not user approval." };
            if (!input.proposeAction) return { ok: false, code: "action_review_unavailable", guidance: "The trusted action review is unavailable. No change was made." };
            return input.proposeAction(definition.name as WebsiteAgentReviewedToolName, parsed.data, execution);
          }
          if (collect) {
            const parsed = collectSchema.safeParse(args);
            if (!parsed.success) return { ok: false, code: "invalid_request", guidance: "Only the requested visibility is accepted; source input is fixed to the original user message." };
            if (parsed.data.visibility === "public") return { ok: false, code: current.isFilter ? "public_collection_review_required" : "filter_required",
              guidance: "Public collection requires current Filter access and a trusted source/visibility review that is not available yet. No public collection was created." };
            if (!input.collect) return { ok: false, code: "collection_consent_required", guidance: "Ask the user to enable private collection for a new request. Nothing was saved." };
          }
          // The model can never widen collection data, visibility or operation.
          const rawInput = collect ? { input: input.query, visibility: "private", idempotency_key: `website:${input.operationId}` } : args;
          return definition.invoke({ ...current, runId: `website:${input.operationId}:${execution.toolCallId}`.slice(0, 128), signal: execution.signal }, rawInput);
        },
      };
    });
}
