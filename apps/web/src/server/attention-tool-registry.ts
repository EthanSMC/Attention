import "server-only";

import {
  CollectionRepositoryError,
  type AttentionDatabase,
} from "@attention/db";
import { z } from "zod";

import {
  AgentAccessError,
  retrieveForAgent,
} from "./agent-retrieval";
import {
  collectFromWeb,
  CollectionServiceError,
  selectCandidateFromWeb,
} from "./collection-service";
import {
  CollectionStatusServiceError,
  getCollectionStatus,
  updateCollectionVisibility,
} from "./collection-status-service";
import { loadMyCollections, loadPublicContents } from "./content-queries";
import { publicFeedPreviewLimit } from "./public-access";
import type { AttentionToolAuditInput } from "./attention-tool-audit";

export const ATTENTION_TOOL_CONTRACT_VERSION = "1.0.0";

export const ATTENTION_TOOL_NAMES = [
  "attention_list_collections",
  "attention_collect_content",
  "attention_select_collection_candidate",
  "attention_get_collection_status",
  "attention_update_collection",
  "attention_list_public_content",
  "attention_search_content",
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

export type AttentionToolResult =
  | { ok: true; value: Record<string, unknown> }
  | { code: string; guidance: string; ok: false };

export interface AttentionToolDefinition {
  annotations: AttentionToolAnnotations;
  contractVersion: typeof ATTENTION_TOOL_CONTRACT_VERSION;
  description: string;
  inputSchema: z.ZodObject;
  invoke(
    context: AttentionToolContext,
    rawInput: unknown,
  ): Promise<AttentionToolResult>;
  isVisible(context: AttentionToolBaseContext): boolean;
  name: AttentionToolName;
  title: string;
}

export interface AttentionToolCoreDependencies {
  collectFromWeb: typeof collectFromWeb;
  getCollectionStatus: typeof getCollectionStatus;
  loadMyCollections: typeof loadMyCollections;
  loadPublicContents: typeof loadPublicContents;
  publicFeedPreviewLimit: typeof publicFeedPreviewLimit;
  retrieveForAgent: typeof retrieveForAgent;
  selectCandidateFromWeb: typeof selectCandidateFromWeb;
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
      .literal("1.0.0")
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
    contractVersion: ATTENTION_TOOL_CONTRACT_VERSION,
    credentialId: context.caller.credentialId,
    credentialKind: context.caller.credentialKind,
    durationMs: Math.max(0, performance.now() - startedAt),
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
  return {
    annotations: definition.annotations,
    contractVersion: ATTENTION_TOOL_CONTRACT_VERSION,
    description: definition.description,
    inputSchema: definition.inputSchema,
    invoke: async (context, rawInput) => {
      const startedAt = performance.now();
      let input: z.output<TSchema> | null = null;
      let result: AttentionToolResult;
      try {
        input = definition.inputSchema.parse(rawInput);
        result = await definition.execute(context, input);
      } catch (error) {
        if (error instanceof z.ZodError) {
          result = toolError(
            "invalid_request",
            "Check the tool input and try again.",
          );
        } else if (
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
      auditToolCall(context, definition.name, input, result, startedAt);
      return result;
    },
    isVisible: definition.isVisible,
    name: definition.name,
    title: definition.title,
  };
}

function hasScope(context: AttentionToolBaseContext, scope: string): boolean {
  return context.scopes.includes(scope);
}

function toolSuccess(value: Record<string, unknown>): AttentionToolResult {
  return { ok: true, value };
}

function toolError(code: string, guidance: string): AttentionToolResult {
  return { code, guidance, ok: false };
}

const stableErrorGuidance: Readonly<Record<string, string>> = {
  account_not_active: "Sign in with an active Attention account.",
  attempt_lease_lost: "Check the collection status before retrying.",
  attempt_not_found: "The collection attempt does not exist for this account.",
  candidate_invalid: "Submit the original content again to refresh its candidates.",
  candidate_not_found: "Choose a candidate returned by the same collection attempt.",
  collection_deleted: "The collection has been deleted and cannot be updated.",
  collection_not_found: "The collection does not exist for this account.",
  filter_required: "Only an active Filter can make a collection public.",
  idempotency_payload_mismatch: "Use a new idempotency key for different content or visibility.",
  invalid_request: "Check the tool input and try again.",
  membership_required: "Upgrade to Member and reconnect before using AI search.",
  resolution_pending: "Wait before retrying the same collection workflow.",
  selection_expired: "Submit the original content again to get a new selection token.",
  selection_visibility_mismatch: "Use the visibility chosen by the original collection attempt.",
  unsafe_target: "Attention refused the destination for safety reasons.",
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
  if (error instanceof AgentAccessError) {
    return toolError(
      error.code,
      stableErrorGuidance[error.code] ?? "Member access is required.",
    );
  }
  return null;
}

const defaultCoreDependencies: AttentionToolCoreDependencies = {
  collectFromWeb,
  getCollectionStatus,
  loadMyCollections,
  loadPublicContents,
  publicFeedPreviewLimit,
  retrieveForAgent,
  selectCandidateFromWeb,
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
      description: "List the authenticated account's private and public collections. Returns original-link routes, never another account's private data.",
      execute: async (context, { limit, offset, query }) => {
        if (!hasScope(context, "collection:read")) {
          return toolError(
            "insufficient_scope",
            "Reconnect with collection:read.",
          );
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
          original_url: item.outboundHref,
          source: item.source,
          summary: item.summary,
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
      isVisible: () => true,
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
          return toolError(
            "insufficient_scope",
            "Reconnect with collection:write.",
          );
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
      isVisible: () => true,
      name: "attention_collect_content",
      title: "Collect a link in Attention",
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
          return toolError(
            "insufficient_scope",
            "Reconnect with collection:write.",
          );
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
      isVisible: () => true,
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
          return toolError(
            "insufficient_scope",
            "Reconnect with collection:read.",
          );
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
          return toolSuccess(
            await core.getCollectionStatus(
              context.getDatabase(),
              context,
              request,
            ) as unknown as Record<string, unknown>,
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
      isVisible: () => true,
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
          return toolError(
            "insufficient_scope",
            "Reconnect with collection:write.",
          );
        }
        if (visibility === "public" && !context.isFilter) {
          return toolError(
            "filter_required",
            "Only an active Filter can make a collection public.",
          );
        }
        try {
          return toolSuccess(
            await core.updateCollectionVisibility(
              context.getDatabase(),
              context,
              { collection_id, visibility },
            ) as unknown as Record<string, unknown>,
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
          collection_id: z.string().uuid(),
          visibility: z.enum(["private", "public"]),
        })
        .strict(),
      isVisible: () => true,
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
          return toolError(
            "insufficient_scope",
            "Reconnect with public:read.",
          );
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
            first_public_at: item.firstPublicAt,
            original_url: item.outboundHref,
            source: item.source,
            summary: item.summary,
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
      isVisible: () => true,
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
        try {
          return toolSuccess(
            await core.retrieveForAgent(
              context.getDatabase(),
              context.accountId,
              query,
            ) as unknown as Record<string, unknown>,
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
          query: z.string().trim().min(2).max(500),
        })
        .strict(),
      isVisible: (context) =>
        context.isMember && hasScope(context, "ai:search"),
      name: "attention_search_content",
      title: "Search Attention content",
    }),
  ];
}

export const attentionToolRegistry = createAttentionToolRegistry();
