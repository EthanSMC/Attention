import "server-only";

import { AttentionToolSuccessOutputSchemas } from "@attention/contracts";
import {
  castModerationVote,
  CollectionRepositoryError,
  listModerationCourtCases,
  ModerationRepositoryError,
  type AttentionDatabase,
} from "@attention/db";
import { z } from "zod";

import {
  AgentAccessError,
  retrieveForAgent,
} from "./agent-retrieval";
import { loadAccountOverview } from "./account";
import {
  collectFromWeb,
  CollectionServiceError,
  selectCandidateFromWeb,
} from "./collection-service";
import {
  ContentEnrichmentServiceError,
  submitContentEnrichment,
} from "./content-enrichment-service";
import {
  CollectionStatusServiceError,
  getCollectionStatus,
  updateCollectionVisibility,
} from "./collection-status-service";
import { loadMyCollections, loadPublicContents } from "./content-queries";
import { loadCurrentSubscription } from "./membership";
import {
  DigestSettingsError,
  loadDigestSettings,
  updateDigestSettings,
} from "./digest-settings";
import { reportPublicContent } from "./moderation-service";
import { publicFeedPreviewLimit } from "./public-access";
import type { AttentionToolAuditInput } from "./attention-tool-audit";

export const ATTENTION_TOOL_CONTRACT_VERSION = "1.4.0";

export const ATTENTION_TOOL_NAMES = [
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
] as const;

export const ATTENTION_PUBLIC_TOOL_NAMES = ATTENTION_TOOL_NAMES;

export type AttentionToolName = (typeof ATTENTION_TOOL_NAMES)[number];

export function getAttentionPublicToolNames(): readonly AttentionToolName[] {
  return [...ATTENTION_TOOL_NAMES];
}

export interface AttentionToolCaller {
  clientId: string | null;
  credentialId: string;
  credentialKind: "oauth" | "pat";
  entrypoint: "hosted_agent" | "hosted_mcp";
}

export interface AttentionToolBaseContext {
  accountId: string;
  caller: AttentionToolCaller;
  getDatabase(): AttentionDatabase;
  isFilter: boolean;
  isMember: boolean;
  recordAudit?: (
    db: AttentionDatabase,
    input: AttentionToolAuditInput,
  ) => void;
  requestId: string;
  serviceOrigin: string;
  scopes: readonly string[];
}

export interface AttentionToolContext extends AttentionToolBaseContext {
  runId: string;
  signal: AbortSignal;
}

export interface AttentionToolAnnotations {
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
  readOnlyHint: boolean;
}

export type AttentionToolRequiredEntitlement =
  | "filter"
  | "member"
  | "member_or_filter";

export type AttentionToolResult =
  | { ok: true; value: Record<string, unknown> }
  | {
      code: string;
      guidance: string;
      ok: false;
      requiredEntitlement?: AttentionToolRequiredEntitlement;
      requiredScope?: string;
      retryAfterSeconds?: number;
    };

export interface AttentionToolDefinition {
  annotations: AttentionToolAnnotations;
  contractVersion: typeof ATTENTION_TOOL_CONTRACT_VERSION;
  description: string;
  inputSchema: z.ZodObject;
  outputSchema: z.ZodType<Record<string, unknown>>;
  invoke(
    context: AttentionToolContext,
    rawInput: unknown,
  ): Promise<AttentionToolResult>;
  isVisible(context: AttentionToolBaseContext): boolean;
  name: AttentionToolName;
  title: string;
}

export interface AttentionToolCoreDependencies {
  castModerationVote: typeof castModerationVote;
  collectFromWeb: typeof collectFromWeb;
  getCollectionStatus: typeof getCollectionStatus;
  loadAccountOverview: typeof loadAccountOverview;
  loadCurrentSubscription: typeof loadCurrentSubscription;
  loadDigestSettings: typeof loadDigestSettings;
  listModerationCourtCases: typeof listModerationCourtCases;
  loadMyCollections: typeof loadMyCollections;
  loadPublicContents: typeof loadPublicContents;
  publicFeedPreviewLimit: typeof publicFeedPreviewLimit;
  reportPublicContent: typeof reportPublicContent;
  retrieveForAgent: typeof retrieveForAgent;
  selectCandidateFromWeb: typeof selectCandidateFromWeb;
  submitContentEnrichment: typeof submitContentEnrichment;
  updateDigestSettings: typeof updateDigestSettings;
  updateCollectionVisibility: typeof updateCollectionVisibility;
}

interface TypedAttentionToolDefinition<TSchema extends z.ZodObject> {
  annotations: AttentionToolAnnotations;
  description: string;
  execute(
    context: AttentionToolContext,
    input: z.output<TSchema>,
  ): Promise<AttentionToolResult>;
  inputSchema: TSchema;
  isVisible(context: AttentionToolBaseContext): boolean;
  name: AttentionToolName;
  title: string;
}

const attentionClientContextSchema = z
  .object({
    skill_id: z
      .literal("attention")
      .optional(),
    skill_version: z
      .enum(["1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0", "1.5.0", "1.6.0"])
      .optional(),
    workflow_run_id: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
      .optional(),
  })
  .strict();

const attentionClientContextShape = {
  client_context: attentionClientContextSchema.optional(),
} as const;

type AttentionClientContext = z.output<typeof attentionClientContextSchema>;

function stringField(
  value: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const candidate = value?.[key];
  return typeof candidate === "string" ? candidate : null;
}

function nestedRecord(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const candidate = value[key];
  return candidate !== null && typeof candidate === "object"
    ? (candidate as Record<string, unknown>)
    : undefined;
}

function publicCitationIds(
  value: Record<string, unknown> | undefined,
): string[] {
  const citations = value?.citations;
  if (!Array.isArray(citations)) return [];
  const ids = new Set<string>();
  for (const citation of citations) {
    if (
      citation !== null &&
      typeof citation === "object" &&
      (citation as Record<string, unknown>).scope === "public" &&
      typeof (citation as Record<string, unknown>).id === "string"
    ) {
      ids.add((citation as Record<string, unknown>).id as string);
    }
  }
  return [...ids].slice(0, 8);
}

function auditToolCall(
  context: AttentionToolContext,
  toolName: AttentionToolName,
  input: Record<string, unknown> | null,
  result: AttentionToolResult,
  startedAt: number,
): void {
  if (!context.recordAudit) return;
  const clientContext = input?.client_context as
    | AttentionClientContext
    | undefined;
  const value = result.ok ? result.value : undefined;
  const attempt = value ? nestedRecord(value, "attempt") : undefined;
  const collection = value ? nestedRecord(value, "collection") : undefined;
  const auditInput: AttentionToolAuditInput = {
    accountId: context.accountId,
    attemptId:
      stringField(value, "attempt_id") ??
      stringField(attempt, "attempt_id"),
    clientId: context.caller.clientId,
    collectionId:
      stringField(value, "collection_id") ??
      stringField(collection, "collection_id"),
    contentId:
      stringField(value, "content_id") ??
      stringField(input ?? undefined, "content_id"),
    contractVersion: ATTENTION_TOOL_CONTRACT_VERSION,
    credentialId: context.caller.credentialId,
    credentialKind: context.caller.credentialKind,
    durationMs: Math.max(0, performance.now() - startedAt),
    entitlementTier: context.isFilter
      ? "filter"
      : context.isMember
        ? "member"
        : "free",
    entrypoint: context.caller.entrypoint,
    outcome: result.ok
      ? "success"
      : result.code === "internal_error"
        ? "internal_error"
        : result.code === "cancelled"
          ? "cancelled"
          : "tool_error",
    reportedSkillId: clientContext?.skill_id,
    reportedSkillVersion: clientContext?.skill_version,
    reportedWorkflowId: clientContext?.workflow_run_id,
    protocolRequestId: context.runId,
    publicCitationIds: publicCitationIds(value),
    requestId: context.requestId,
    resultStatus:
      stringField(value, "status") ?? stringField(attempt, "status"),
    stableErrorCode: result.ok ? null : result.code,
    toolName,
  };
  try {
    context.recordAudit(context.getDatabase(), auditInput);
  } catch (error) {
    console.error("attention_tool_audit_dispatch_failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

function defineAttentionTool<TSchema extends z.ZodObject>(
  definition: TypedAttentionToolDefinition<TSchema>,
): AttentionToolDefinition {
  const outputSchema = AttentionToolSuccessOutputSchemas[definition.name] as z.ZodType<
    Record<string, unknown>
  >;
  return {
    annotations: definition.annotations,
    contractVersion: ATTENTION_TOOL_CONTRACT_VERSION,
    description: definition.description,
    inputSchema: definition.inputSchema,
    invoke: async (context, rawInput) => {
      const startedAt = performance.now();
      let input: z.output<TSchema> | null = null;
      let result: AttentionToolResult = toolError(
        "internal_error",
        "Attention could not complete the operation. Try again later.",
      );
      try {
        input = definition.inputSchema.parse(rawInput);
      } catch (error) {
        if (error instanceof z.ZodError) {
          result = toolError(
            "invalid_request",
            "Check the tool input and try again.",
          );
        } else {
          console.error("attention_tool_input_validation_failed", {
            name: error instanceof Error ? error.name : "UnknownError",
            tool: definition.name,
          });
          result = toolError(
            "internal_error",
            "Attention could not complete the operation. Try again later.",
          );
        }
      }
      if (input !== null) {
        try {
          result = await definition.execute(context, input);
        } catch (error) {
          if (
          context.signal.aborted ||
          (error instanceof Error && error.name === "AbortError")
          ) {
            result = toolError("cancelled", "The tool call was cancelled.");
          } else {
            console.error("attention_tool_failed", {
              name: error instanceof Error ? error.name : "UnknownError",
              tool: definition.name,
            });
            result = toolError(
              "internal_error",
              "Attention could not complete the operation. Try again later.",
            );
          }
        }
        if (result.ok) {
          const validatedOutput = outputSchema.safeParse(result.value);
          if (validatedOutput.success) {
            result = {
              ok: true,
              value: validatedOutput.data,
            };
          } else {
            console.error("attention_tool_output_contract_violation", {
              issues: validatedOutput.error.issues.map((issue) => ({
                code: issue.code,
                path: issue.path,
              })),
              tool: definition.name,
            });
            result = toolError(
              "internal_error",
              "Attention could not complete the operation. Try again later.",
            );
          }
        }
      }
      auditToolCall(context, definition.name, input, result, startedAt);
      return result;
    },
    isVisible: definition.isVisible,
    name: definition.name,
    outputSchema,
    title: definition.title,
  };
}

function hasScope(context: AttentionToolBaseContext, scope: string): boolean {
  return context.scopes.includes(scope);
}

function absoluteServiceUrl(
  context: AttentionToolBaseContext,
  href: string,
): string;
function absoluteServiceUrl(
  context: AttentionToolBaseContext,
  href: null,
): null;
function absoluteServiceUrl(
  context: AttentionToolBaseContext,
  href: string | null,
): string | null;
function absoluteServiceUrl(
  context: AttentionToolBaseContext,
  href: string | null,
): string | null {
  return href === null
    ? null
    : new URL(href, `${context.serviceOrigin}/`).href;
}

function toolSuccess(value: Record<string, unknown>): AttentionToolResult {
  return { ok: true, value };
}

interface AttentionToolErrorMetadata {
  requiredScope?: string;
  retryAfterSeconds?: number;
}

function requiredEntitlementForError(
  code: string,
): AttentionToolRequiredEntitlement | undefined {
  if (code === "filter_required") return "filter";
  if (code === "membership_required") return "member";
  if (code === "digest_entitlement_required") return "member_or_filter";
  return undefined;
}

function toolError(
  code: string,
  guidance: string,
  metadata: AttentionToolErrorMetadata = {},
): AttentionToolResult {
  const requiredEntitlement = requiredEntitlementForError(code);
  return {
    code,
    guidance,
    ok: false,
    ...(requiredEntitlement ? { requiredEntitlement } : {}),
    ...(metadata.requiredScope
      ? { requiredScope: metadata.requiredScope }
      : {}),
    ...(metadata.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: metadata.retryAfterSeconds }
      : {}),
  };
}

function insufficientScope(scope: string): AttentionToolResult {
  return toolError(
    "insufficient_scope",
    `Reconnect with ${scope}.`,
    { requiredScope: scope },
  );
}

function validRetryAfterSeconds(value: number | null): number | undefined {
  return value !== null && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

const stableErrorGuidance: Readonly<Record<string, string>> = {
  account_not_active: "Sign in with an active Attention account.",
  attempt_lease_lost: "Check the collection status before retrying.",
  attempt_not_found: "The collection attempt does not exist for this account.",
  candidate_invalid: "Submit the original content again to refresh its candidates.",
  candidate_not_found: "Choose a candidate returned by the same collection attempt.",
  content_enrichment_hidden: "This Content cannot accept a replacement summary.",
  content_not_eligible: "This Content is not eligible for enrichment.",
  content_not_found: "The Content does not exist in an active collection for this account.",
  case_not_found: "Refresh the moderation case list and choose a current case.",
  case_not_open: "Refresh the moderation case list; this voting round is no longer open.",
  collection_deleted: "The collection has been deleted and cannot be updated.",
  collection_not_found: "The collection does not exist for this account.",
  filter_required: "Only an active Filter can perform this action.",
  idempotency_payload_mismatch: "Use a new idempotency key for different content or visibility.",
  invalid_request: "Check the tool input and try again.",
  membership_required: "Upgrade to Member and reconnect before using AI search.",
  content_not_reportable: "Refresh the public feed before reporting this content.",
  digest_entitlement_required: "Upgrade to Member before changing digest settings.",
  invalid_digest_settings: "Check the digest domains, timezone, and delivery window.",
  invalid_report: "Choose a valid reason and keep report details under 2,000 characters.",
  report_rate_limited: "Wait before opening another moderation case.",
  resolution_pending: "Wait before retrying the same collection workflow.",
  selection_expired: "Submit the original content again to get a new selection token.",
  selection_visibility_mismatch: "Use the visibility chosen by the original collection attempt.",
  unsafe_target: "Attention refused the destination for safety reasons.",
  vote_already_cast: "This Filter already voted in the current case and the decision cannot be changed.",
  voting_closed: "Refresh the moderation case list; the voting window has closed.",
};

function knownServiceError(error: unknown): AttentionToolResult | null {
  if (error instanceof CollectionRepositoryError) {
    const code =
      error.code === "public_requires_filter"
        ? "filter_required"
        : error.code === "member_required"
          ? "membership_required"
          : error.code;
    return toolError(
      code,
      stableErrorGuidance[code] ??
        "Attention could not complete this collection operation.",
    );
  }
  if (
    error instanceof CollectionServiceError ||
    error instanceof CollectionStatusServiceError
  ) {
    return toolError(
      error.code,
      stableErrorGuidance[error.code] ??
        "Attention could not complete this collection operation.",
    );
  }
  if (error instanceof ContentEnrichmentServiceError) {
    return toolError(
      error.code,
      stableErrorGuidance[error.code] ??
        "Attention could not submit this Content enrichment.",
    );
  }
  if (error instanceof AgentAccessError) {
    return toolError(
      error.code,
      stableErrorGuidance[error.code] ?? "Member access is required.",
    );
  }
  if (error instanceof ModerationRepositoryError) {
    const retryAfterSeconds = validRetryAfterSeconds(
      error.retryAfterSeconds,
    );
    return toolError(
      error.code,
      stableErrorGuidance[error.code] ??
        "Attention could not submit this content report.",
      retryAfterSeconds === undefined ? {} : { retryAfterSeconds },
    );
  }
  if (error instanceof DigestSettingsError) {
    return toolError(
      error.code,
      stableErrorGuidance[error.code] ??
        "Attention could not update digest settings.",
    );
  }
  return null;
}

const defaultCoreDependencies: AttentionToolCoreDependencies = {
  castModerationVote,
  collectFromWeb,
  getCollectionStatus,
  loadAccountOverview,
  loadCurrentSubscription,
  loadDigestSettings,
  listModerationCourtCases,
  loadMyCollections,
  loadPublicContents,
  publicFeedPreviewLimit,
  reportPublicContent,
  retrieveForAgent,
  selectCandidateFromWeb,
  submitContentEnrichment,
  updateDigestSettings,
  updateCollectionVisibility,
};

export function createAttentionToolRegistry(
  core: AttentionToolCoreDependencies = defaultCoreDependencies,
): readonly AttentionToolDefinition[] {
  return [
    defineAttentionTool({
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description: "Read the authenticated account's public Attention identity and live capabilities. Email, password state, session data, and internal account IDs are never returned.",
      execute: async (context) => {
        if (!hasScope(context, "profile:read")) {
          return insufficientScope("profile:read");
        }
        const account = await core.loadAccountOverview(
          context.getDatabase(),
          context.accountId,
        );
        if (!account) {
          return toolError(
            "account_not_active",
            "Sign in with an active Attention account.",
          );
        }
        return toolSuccess({
          capabilities: {
            is_filter: context.isFilter,
            is_member: context.isMember,
          },
          profile: {
            attention_id: account.attentionId,
            display_name: account.displayName,
            has_avatar: account.avatarUrl !== null,
          },
        });
      },
      inputSchema: z.object(attentionClientContextShape).strict(),
      isVisible: (context) => hasScope(context, "profile:read"),
      name: "attention_get_my_account",
      title: "Get my Attention account",
    }),
    defineAttentionTool({
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description: "Read the authenticated account's live Member and Filter capability plus its current billing subscription record, if one exists. This never starts, changes, or cancels billing.",
      execute: async (context) => {
        if (!hasScope(context, "subscription:read")) {
          return insufficientScope("subscription:read");
        }
        const subscription = await core.loadCurrentSubscription(
          context.getDatabase(),
          context.accountId,
        );
        return toolSuccess({
          capabilities: {
            is_filter: context.isFilter,
            is_member: context.isMember,
          },
          subscription: subscription
            ? {
                cancel_at_period_end: subscription.cancelAtPeriodEnd,
                current_period_end:
                  subscription.currentPeriodEnd.toISOString(),
                status: subscription.status,
              }
            : null,
        });
      },
      inputSchema: z.object(attentionClientContextShape).strict(),
      isVisible: (context) => hasScope(context, "subscription:read"),
      name: "attention_get_membership_status",
      title: "Get Attention membership status",
    }),
    defineAttentionTool({
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description: "List the authenticated account's private and public collections. Returns original-link routes, never another account's private data.",
      execute: async (context, { limit, offset, query }) => {
        if (!hasScope(context, "collection:read")) {
          return insufficientScope("collection:read");
        }
        const allItems = await core.loadMyCollections(
          context.getDatabase(),
          context.accountId,
        );
        const normalizedQuery = query?.toLocaleLowerCase("zh-CN");
        const filtered = normalizedQuery
          ? allItems.filter((item) =>
              `${item.title} ${item.summary ?? ""} ${item.source} ${item.author ?? ""}`
                .toLocaleLowerCase("zh-CN")
                .includes(normalizedQuery),
            )
          : allItems;
        const items = filtered.slice(offset, offset + limit).map((item) => ({
          author: item.author,
          collected_at: item.collectedAt,
          collection_id: item.id,
          effective_visibility: item.effectiveVisibility,
          filters: item.filters.map((filter) => ({
            attention_id: filter.attentionId,
            display_name: filter.displayName,
          })),
          first_public_at: item.firstPublicAt,
          original_url: absoluteServiceUrl(context, item.outboundHref),
          published_at: item.publishedAt,
          source: item.source,
          summary: item.summary,
          summary_status: item.summaryStatus,
          tags: item.tags,
          title: item.title,
          visibility: item.visibility,
        }));
        return toolSuccess({
          count: items.length,
          has_more: offset + items.length < filtered.length,
          items,
          next_offset:
            offset + items.length < filtered.length
              ? offset + items.length
              : null,
          offset,
          total_count: filtered.length,
        });
      },
      inputSchema: z
        .object({
          ...attentionClientContextShape,
          limit: z.number().int().min(1).max(50).default(20),
          offset: z.number().int().min(0).default(0),
          query: z.string().trim().max(200).optional(),
        })
        .strict(),
      isVisible: (context) => hasScope(context, "collection:read"),
      name: "attention_list_collections",
      title: "List Attention collections",
    }),
    defineAttentionTool({
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: false,
      },
      description: "Save a URL or platform share text to the authenticated account. Free accounts can save unlimited private links; public visibility requires live Filter status.",
      execute: async (context, { idempotency_key, input, visibility }) => {
        if (!hasScope(context, "collection:write")) {
          return insufficientScope("collection:write");
        }
        if (visibility === "public" && !context.isFilter) {
          return toolError(
            "filter_required",
            "Only an active Filter can create public collections.",
          );
        }
        try {
          const result = await core.collectFromWeb(context.getDatabase(), context, {
            idempotency_key,
            raw_input: input,
            visibility,
          });
          return toolSuccess(
            result as unknown as Record<string, unknown>,
          );
        } catch (error) {
          const known = knownServiceError(error);
          if (known) return known;
          throw error;
        }
      },
      inputSchema: z
        .object({
          ...attentionClientContextShape,
          idempotency_key: z.string().min(8).max(128),
          input: z.string().trim().min(1).max(32_768),
          visibility: z.enum(["private", "public"]).default("private"),
        })
        .strict(),
      isVisible: (context) => hasScope(context, "collection:write"),
      name: "attention_collect_content",
      title: "Collect a link in Attention",
    }),
    defineAttentionTool({
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description: "Submit the first grounded summary and normalized tags for Content in an active collection owned by the authenticated account. An existing shared summary is never overwritten.",
      execute: async (
        context,
        { content_id, idempotency_key, summary, tags },
      ) => {
        if (!hasScope(context, "collection:write")) {
          return insufficientScope("collection:write");
        }
        try {
          const result = await core.submitContentEnrichment(
            context.getDatabase(),
            context,
            { content_id, idempotency_key, summary, tags },
          );
          return toolSuccess({
            content_id: result.contentId,
            status: result.status,
            summary_status: result.summaryStatus,
          });
        } catch (error) {
          const known = knownServiceError(error);
          if (known) return known;
          throw error;
        }
      },
      inputSchema: z
        .object({
          ...attentionClientContextShape,
          content_id: z.string().uuid(),
          idempotency_key: z.string().trim().min(8).max(128),
          summary: z.string().trim().min(1).max(2_000),
          tags: z
            .array(z.string().trim().min(1).max(64))
            .min(1)
            .max(8),
        })
        .strict(),
      isVisible: (context) => hasScope(context, "collection:write"),
      name: "attention_submit_content_enrichment",
      title: "Submit shared Content enrichment",
    }),
    defineAttentionTool({
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: false,
      },
      description: "Complete an ambiguous collection after attention_collect_content returns candidate IDs and a one-time selection token.",
      execute: async (
        context,
        { candidate_id, selection_token, visibility },
      ) => {
        if (!hasScope(context, "collection:write")) {
          return insufficientScope("collection:write");
        }
        if (visibility === "public" && !context.isFilter) {
          return toolError(
            "filter_required",
            "Only an active Filter can create public collections.",
          );
        }
        try {
          const result = await core.selectCandidateFromWeb(
            context.getDatabase(),
            context,
            { candidate_id, selection_token, visibility },
          );
          return toolSuccess(
            result as unknown as Record<string, unknown>,
          );
        } catch (error) {
          const known = knownServiceError(error);
          if (known) return known;
          throw error;
        }
      },
      inputSchema: z
        .object({
          ...attentionClientContextShape,
          candidate_id: z.string().uuid(),
          selection_token: z.string().min(32).max(512),
          visibility: z.enum(["private", "public"]).default("private"),
        })
        .strict(),
      isVisible: (context) => hasScope(context, "collection:write"),
      name: "attention_select_collection_candidate",
      title: "Select a collection candidate",
    }),
    defineAttentionTool({
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description: "Get the authenticated account's processing state for one collection attempt or collection. Returns orthogonal attempt, collection, and content states without exposing another account's data.",
      execute: async (context, { attempt_id, collection_id }) => {
        if (!hasScope(context, "collection:read")) {
          return insufficientScope("collection:read");
        }
        try {
          const request = attempt_id
            ? { attempt_id }
            : collection_id
              ? { collection_id }
              : null;
          if (!request) {
            return toolError(
              "invalid_request",
              "Check the tool input and try again.",
            );
          }
          const status = await core.getCollectionStatus(
            context.getDatabase(),
            context,
            request,
          );
          return toolSuccess({
            ...status,
            collection: status.collection
              ? {
                  ...status.collection,
                  original_url: absoluteServiceUrl(
                    context,
                    status.collection.original_url,
                  ),
                }
              : null,
          });
        } catch (error) {
          const known = knownServiceError(error);
          if (known) return known;
          throw error;
        }
      },
      inputSchema: z
        .object({
          ...attentionClientContextShape,
          attempt_id: z.string().uuid().optional(),
          collection_id: z.string().uuid().optional(),
        })
        .strict()
        .refine(
          (value) =>
            (value.attempt_id === undefined) !==
            (value.collection_id === undefined),
          { message: "Provide exactly one of attempt_id or collection_id" },
        ),
      isVisible: (context) => hasScope(context, "collection:read"),
      name: "attention_get_collection_status",
      title: "Get Attention collection status",
    }),
    defineAttentionTool({
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description: "Change one owned collection between private and public. The same-value update is idempotent, and public visibility requires live Filter status on every call.",
      execute: async (context, { collection_id, visibility }) => {
        if (!hasScope(context, "collection:write")) {
          return insufficientScope("collection:write");
        }
        if (visibility === "public" && !context.isFilter) {
          return toolError(
            "filter_required",
            "Only an active Filter can make a collection public.",
          );
        }
        try {
          const updated = await core.updateCollectionVisibility(
            context.getDatabase(),
            context,
            { collection_id, visibility },
          );
          return toolSuccess({
            ...updated,
            original_url: absoluteServiceUrl(context, updated.original_url),
          });
        } catch (error) {
          const known = knownServiceError(error);
          if (known) return known;
          throw error;
        }
      },
      inputSchema: z
        .object({
          ...attentionClientContextShape,
          collection_id: z.string().uuid(),
          visibility: z.enum(["private", "public"]),
        })
        .strict(),
      isVisible: (context) => hasScope(context, "collection:write"),
      name: "attention_update_collection",
      title: "Update Attention collection",
    }),
    defineAttentionTool({
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description: "List public Attention content in current chronological order. Free credentials receive only the same server-configured preview window as the website.",
      execute: async (context, { limit, offset }) => {
        if (
          !hasScope(context, "public:read") &&
          !hasScope(context, "public:full")
        ) {
          return insufficientScope("public:read");
        }
        const allItems = await core.loadPublicContents(context.getDatabase());
        const hasFullPublicAccess =
          context.isMember && hasScope(context, "public:full");
        const accessible = hasFullPublicAccess
          ? allItems
          : allItems.slice(0, core.publicFeedPreviewLimit());
        const items = accessible
          .slice(offset, offset + limit)
          .map((item) => ({
            author: item.author,
            content_id: item.id,
            filters: item.filters.map((filter) => ({
              attention_id: filter.attentionId,
              display_name: filter.displayName,
            })),
            first_public_at: item.firstPublicAt,
            original_url: absoluteServiceUrl(context, item.outboundHref),
            published_at: item.publishedAt,
            source: item.source,
            summary: item.summary,
            summary_status: item.summaryStatus,
            tags: item.tags,
            title: item.title,
          }));
        return toolSuccess({
          count: items.length,
          has_more: offset + items.length < accessible.length,
          items,
          next_offset:
            offset + items.length < accessible.length
              ? offset + items.length
              : null,
          offset,
          preview_limited:
            !hasFullPublicAccess && allItems.length > accessible.length,
          total_count: accessible.length,
        });
      },
      inputSchema: z
        .object({
          ...attentionClientContextShape,
          limit: z.number().int().min(1).max(50).default(20),
          offset: z.number().int().min(0).default(0),
        })
        .strict(),
      isVisible: (context) =>
        hasScope(context, "public:read") || hasScope(context, "public:full"),
      name: "attention_list_public_content",
      title: "List public Attention content",
    }),
    defineAttentionTool({
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description: "Search the authenticated account's collections and the complete public network. Returns cited original-link routes. Requires live Member status on every call.",
      execute: async (context, { query }) => {
        if (!hasScope(context, "ai:search")) {
          return insufficientScope("ai:search");
        }
        try {
          const result = await core.retrieveForAgent(
            context.getDatabase(),
            context.accountId,
            query,
          );
          return toolSuccess({
            ...result,
            citations: result.citations.map((citation) => ({
              ...citation,
              href: absoluteServiceUrl(context, citation.href),
            })),
          });
        } catch (error) {
          const known = knownServiceError(error);
          if (known) return known;
          throw error;
        }
      },
      inputSchema: z
        .object({
          ...attentionClientContextShape,
          query: z.string().trim().min(2).max(500),
        })
        .strict(),
      isVisible: (context) =>
        context.isMember && hasScope(context, "ai:search"),
      name: "attention_search_content",
      title: "Search Attention content",
    }),
    defineAttentionTool({
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description: "Report currently public Attention content for community review after the user explicitly confirms that exact public content in the current conversation. Duplicate reports from the same account are idempotent and return the existing report.",
      execute: async (
        context,
        { details, explicit_confirmation, public_content_id, reason_code },
      ) => {
        if (!hasScope(context, "moderation:write")) {
          return insufficientScope("moderation:write");
        }
        if (explicit_confirmation !== true) {
          return toolError(
            "explicit_confirmation_required",
            "Ask the user to explicitly confirm reporting this exact public content before continuing.",
          );
        }
        try {
          const result = await core.reportPublicContent(
            context.getDatabase(),
            context.accountId,
            {
              details: details ?? null,
              publicContentId: public_content_id,
              reasonCode: reason_code,
            },
          );
          return toolSuccess({
            case_id: result.caseId,
            case_opened: result.caseOpened,
            community_status: result.communityStatus,
            duplicate: result.duplicate,
            report_id: result.reportId,
          });
        } catch (error) {
          const known = knownServiceError(error);
          if (known) return known;
          throw error;
        }
      },
      inputSchema: z
        .object({
          ...attentionClientContextShape,
          details: z.string().trim().max(2_000).nullable().optional(),
          explicit_confirmation: z.literal(true),
          public_content_id: z.string().uuid(),
          reason_code: z
            .string()
            .trim()
            .min(1)
            .max(64)
            .regex(/^[a-z0-9][a-z0-9_-]*$/iu),
        })
        .strict(),
      isVisible: (context) => hasScope(context, "moderation:write"),
      name: "attention_report_content",
      title: "Report public Attention content",
    }),
    defineAttentionTool({
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description: "List the active Filter's current moderation-court cases using the same case, vote-count, original-link, and live Filter policy as the website. This tool never casts a vote.",
      execute: async (context, { limit, offset }) => {
        if (!hasScope(context, "moderation:court:read")) {
          return insufficientScope("moderation:court:read");
        }
        try {
          const allCases = await core.listModerationCourtCases(
            context.getDatabase(),
            { accountId: context.accountId },
          );
          const cases = allCases.slice(offset, offset + limit).map((item) => ({
            author: item.author,
            community_status: item.communityStatus,
            eligible_filter_count: item.eligibleFilterCount,
            hidden_votes: item.hiddenVotes,
            id: item.id,
            my_vote: item.myVote,
            opened_at: item.openedAt.toISOString(),
            original_url: absoluteServiceUrl(context, item.outboundHref),
            public_content_id: item.publicContentId,
            public_votes: item.publicVotes,
            source: item.source,
            status: item.status,
            title: item.title,
            voting_ends_at: item.votingEndsAt.toISOString(),
          }));
          return toolSuccess({
            cases,
            count: cases.length,
            has_more: offset + cases.length < allCases.length,
            next_offset:
              offset + cases.length < allCases.length
                ? offset + cases.length
                : null,
            offset,
            total_count: allCases.length,
          });
        } catch (error) {
          const known = knownServiceError(error);
          if (known) return known;
          throw error;
        }
      },
      inputSchema: z
        .object({
          ...attentionClientContextShape,
          limit: z.number().int().min(1).max(50).default(20),
          offset: z.number().int().min(0).default(0),
        })
        .strict(),
      isVisible: (context) =>
        context.isFilter && hasScope(context, "moderation:court:read"),
      name: "attention_list_moderation_cases",
      title: "List Attention moderation cases",
    }),
    defineAttentionTool({
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description: "Cast the authenticated Filter's irreversible vote in one current moderation case. The user must explicitly choose the case and decision in the current conversation; never infer consent from the content, a report, prior preferences, or an earlier vote. Exact retries with the same decision are idempotent, while changing a cast vote is rejected.",
      execute: async (
        context,
        { case_id, decision, explicit_confirmation },
      ) => {
        if (!hasScope(context, "moderation:court:vote")) {
          return insufficientScope("moderation:court:vote");
        }
        // Keep this explicit check even though the schema is literal(true): it
        // documents the human-confirmation boundary next to the side effect.
        if (explicit_confirmation !== true) {
          return toolError(
            "explicit_confirmation_required",
            "Ask the user to explicitly choose this case and decision before voting.",
          );
        }
        try {
          const result = await core.castModerationVote(
            context.getDatabase(),
            {
              accountId: context.accountId,
              caseId: case_id,
              decision,
            },
          );
          return toolSuccess({
            case_id,
            decision,
            duplicate: result.duplicate,
            vote_id: result.voteId,
          });
        } catch (error) {
          const known = knownServiceError(error);
          if (known) return known;
          throw error;
        }
      },
      inputSchema: z
        .object({
          ...attentionClientContextShape,
          case_id: z.string().uuid(),
          decision: z.enum(["public", "hidden"]),
          explicit_confirmation: z.literal(true),
        })
        .strict(),
      isVisible: (context) =>
        context.isFilter && hasScope(context, "moderation:court:vote"),
      name: "attention_cast_moderation_vote",
      title: "Cast an Attention moderation vote",
    }),
    defineAttentionTool({
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description: "Read the authenticated account's digest schedule, available domains, and current eligibility. This does not subscribe or modify delivery.",
      execute: async (context) => {
        if (!hasScope(context, "digest:read")) {
          return insufficientScope("digest:read");
        }
        const settings = await core.loadDigestSettings(
          context.getDatabase(),
          context.accountId,
        );
        return toolSuccess({
          eligible: context.isMember || context.isFilter,
          settings: {
            domains: settings.domains,
            enabled: settings.enabled,
            timezone: settings.timezone,
            window_minutes: settings.windowMinutes,
            window_start: settings.windowStart,
          },
        });
      },
      inputSchema: z.object(attentionClientContextShape).strict(),
      isVisible: (context) => hasScope(context, "digest:read"),
      name: "attention_get_digest_settings",
      title: "Get Attention digest settings",
    }),
    defineAttentionTool({
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description: "Enable, disable, or reschedule the authenticated account's digest using the same live Member/Filter entitlement and domain validation as the website.",
      execute: async (
        context,
        { domain_slugs, enabled, timezone, window_minutes, window_start },
      ) => {
        if (!hasScope(context, "digest:write")) {
          return insufficientScope("digest:write");
        }
        try {
          const settings = await core.updateDigestSettings(
            context.getDatabase(),
            context.accountId,
            {
              domainSlugs: domain_slugs,
              enabled,
              timezone,
              windowMinutes: window_minutes,
              windowStart: window_start,
            },
          );
          return toolSuccess({
            settings: {
              domains: settings.domains,
              enabled: settings.enabled,
              timezone: settings.timezone,
              window_minutes: settings.windowMinutes,
              window_start: settings.windowStart,
            },
          });
        } catch (error) {
          const known = knownServiceError(error);
          if (known) return known;
          throw error;
        }
      },
      inputSchema: z
        .object({
          ...attentionClientContextShape,
          domain_slugs: z.array(z.string().max(64)).max(20),
          enabled: z.boolean(),
          timezone: z.string().trim().min(1).max(64),
          window_minutes: z.number().int().min(15).max(240),
          window_start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
        })
        .strict(),
      isVisible: (context) =>
        (context.isMember || context.isFilter) &&
        hasScope(context, "digest:write"),
      name: "attention_update_digest_settings",
      title: "Update Attention digest settings",
    }),
  ];
}

export const attentionToolRegistry = createAttentionToolRegistry();
