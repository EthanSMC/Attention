import { z } from "zod";

import { CHANNEL_RUNTIME_RESOURCE, CHANNEL_RUNTIME_SCOPES } from "./channel-runtime";

export const ATTENTION_CAPABILITY_MANIFEST_SCHEMA_VERSION = "1.0.0";
export const ATTENTION_MCP_TOOL_CONTRACT_VERSION = "1.3.0";
export const ATTENTION_MCP_OAUTH_AUDIENCE = "attention-mcp";

export const ATTENTION_MCP_OAUTH_SCOPES = [
  "profile:read",
  "collection:read",
  "collection:write",
  "digest:read",
  "digest:write",
  "moderation:write",
  "moderation:court:read",
  "moderation:court:vote",
  "public:read",
  "public:full",
  "ai:search",
  "subscription:read",
] as const;

export const ATTENTION_MCP_TOOL_NAMES = [
  "attention_get_my_account",
  "attention_get_membership_status",
  "attention_list_collections",
  "attention_collect_content",
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

const manifestIdSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9_.-]*$/u);
const nonEmptyDescriptionSchema = z.string().trim().min(12).max(1_000);
const absolutePathSchema = z.string().regex(/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*$/u);

export const AttentionMcpOAuthScopeSchema = z.enum(
  ATTENTION_MCP_OAUTH_SCOPES,
);
export const AttentionMcpToolNameSchema = z.enum(ATTENTION_MCP_TOOL_NAMES);

export const AttentionWebSurfaceSchema = z
  .object({
    kind: z.enum(["page", "api"]),
    path: absolutePathSchema,
    shared_policy: z.literal(true),
  })
  .strict();

export const AttentionMcpCapabilitySchema = z
  .object({
    contract_version: z.literal(ATTENTION_MCP_TOOL_CONTRACT_VERSION),
    entitlement: z
      .object({
        conditional: z
          .enum([
            "filter_for_public_visibility",
            "member_for_full_public_feed",
          ])
          .nullable(),
        required: z.enum([
          "authenticated_account",
          "member",
          "filter",
          "member_or_filter",
        ]),
      })
      .strict(),
    id: manifestIdSchema,
    oauth: z
      .object({
        any_of_scopes: z.array(AttentionMcpOAuthScopeSchema).min(1),
        audience: z.literal(ATTENTION_MCP_OAUTH_AUDIENCE),
      })
      .strict(),
    summary: nonEmptyDescriptionSchema,
    tool_name: AttentionMcpToolNameSchema,
    web_surface: AttentionWebSurfaceSchema,
  })
  .strict();

export const AttentionWebOnlyCapabilitySchema = z
  .object({
    id: manifestIdSchema,
    reason: nonEmptyDescriptionSchema,
    reason_code: z.enum([
      "anti_abuse_boundary",
      "credential_bootstrap_boundary",
      "credential_lifecycle_boundary",
      "human_identity_boundary",
      "interactive_payment_boundary",
    ]),
    summary: nonEmptyDescriptionSchema,
    web_surface: AttentionWebSurfaceSchema.omit({ shared_policy: true }),
  })
  .strict();

export const AttentionIndependentProtocolCapabilitySchema = z
  .object({
    audience: z.string().min(1).max(128).nullable(),
    id: manifestIdSchema,
    path: absolutePathSchema,
    protocol: z.enum([
      "mcp_streamable_http",
      "oauth_2_1_pkce",
      "runtime_reporting_http",
      "sync_http",
    ]),
    reason: nonEmptyDescriptionSchema,
    scopes: z.array(z.string().min(1).max(128)),
  })
  .strict();

export const AttentionCapabilityManifestSchema = z
  .object({
    independent_protocols: z.array(
      AttentionIndependentProtocolCapabilitySchema,
    ),
    mcp: z
      .object({
        audience: z.literal(ATTENTION_MCP_OAUTH_AUDIENCE),
        contract_version: z.literal(ATTENTION_MCP_TOOL_CONTRACT_VERSION),
        scopes: z.array(AttentionMcpOAuthScopeSchema),
        tools: z.array(AttentionMcpCapabilitySchema),
      })
      .strict(),
    release_stage: z.literal("infrastructure_only"),
    schema_version: z.literal(ATTENTION_CAPABILITY_MANIFEST_SCHEMA_VERSION),
    web_only: z.array(AttentionWebOnlyCapabilitySchema),
  })
  .strict();

export type AttentionCapabilityManifest = z.output<
  typeof AttentionCapabilityManifestSchema
>;

export const ATTENTION_CAPABILITY_MANIFEST_PUBLIC_PATH =
  "/skills/attention/capabilities/v1/index.json";
export const ATTENTION_CAPABILITY_SCHEMA_PUBLIC_PATH =
  "/skills/attention/capabilities/v1/schema.json";

export function createAttentionCapabilityManifestJsonSchema(): Record<
  string,
  unknown
> {
  return {
    $id: "https://attention.noveltystudio.cn/skills/attention/capabilities/v1/schema.json",
    title: "Attention capability manifest v1",
    ...z.toJSONSchema(AttentionCapabilityManifestSchema, {
      io: "output",
      target: "draft-2020-12",
    }),
  };
}

export const attentionCapabilityManifest =
  AttentionCapabilityManifestSchema.parse({
    independent_protocols: [
      {
        audience: null,
        id: "oauth.authorization",
        path: "/oauth/authorize",
        protocol: "oauth_2_1_pkce",
        reason:
          "OAuth authorization, discovery, token exchange, refresh, and revocation establish credentials; they are protocol infrastructure rather than user business tools.",
        scopes: [],
      },
      {
        audience: ATTENTION_MCP_OAUTH_AUDIENCE,
        id: "mcp.transport",
        path: "/mcp",
        protocol: "mcp_streamable_http",
        reason:
          "The Streamable HTTP endpoint transports the MCP tools declared below and performs audience, scope, entitlement, and request validation.",
        scopes: [...ATTENTION_MCP_OAUTH_SCOPES],
      },
      {
        audience: "attention-sync",
        id: "collection.sync",
        path: "/api/sync",
        protocol: "sync_http",
        reason:
          "Local-first collection synchronization has conflict, tombstone, and batch semantics that are intentionally separate from conversational MCP tool calls.",
        scopes: ["sync:read", "sync:write"],
      },
      {
        audience: CHANNEL_RUNTIME_RESOURCE,
        id: "local-agent.runtime-reporting",
        path: "/api/runtime",
        protocol: "runtime_reporting_http",
        reason:
          "A local Agent may report installation health and host-managed channel pairing outcomes without uploading local channel credentials; this is not a hosted Channel UI.",
        scopes: [...CHANNEL_RUNTIME_SCOPES],
      },
    ],
    mcp: {
      audience: ATTENTION_MCP_OAUTH_AUDIENCE,
      contract_version: ATTENTION_MCP_TOOL_CONTRACT_VERSION,
      scopes: [...ATTENTION_MCP_OAUTH_SCOPES],
      tools: [
        {
          contract_version: ATTENTION_MCP_TOOL_CONTRACT_VERSION,
          entitlement: {
            conditional: null,
            required: "authenticated_account",
          },
          id: "account.read",
          oauth: {
            any_of_scopes: ["profile:read"],
            audience: ATTENTION_MCP_OAUTH_AUDIENCE,
          },
          summary:
            "Read the signed-in account's public identity and current Member and Filter capabilities.",
          tool_name: "attention_get_my_account",
          web_surface: {
            kind: "page",
            path: "/account",
            shared_policy: true,
          },
        },
        {
          contract_version: ATTENTION_MCP_TOOL_CONTRACT_VERSION,
          entitlement: {
            conditional: null,
            required: "authenticated_account",
          },
          id: "membership.read",
          oauth: {
            any_of_scopes: ["subscription:read"],
            audience: ATTENTION_MCP_OAUTH_AUDIENCE,
          },
          summary:
            "Read live Member and Filter capability and the current billing subscription record without changing billing.",
          tool_name: "attention_get_membership_status",
          web_surface: {
            kind: "page",
            path: "/membership",
            shared_policy: true,
          },
        },
        {
          contract_version: ATTENTION_MCP_TOOL_CONTRACT_VERSION,
          entitlement: {
            conditional: null,
            required: "authenticated_account",
          },
          id: "collection.list",
          oauth: {
            any_of_scopes: ["collection:read"],
            audience: ATTENTION_MCP_OAUTH_AUDIENCE,
          },
          summary:
            "List and search the authenticated account's private and public collections with pagination.",
          tool_name: "attention_list_collections",
          web_surface: {
            kind: "page",
            path: "/account",
            shared_policy: true,
          },
        },
        {
          contract_version: ATTENTION_MCP_TOOL_CONTRACT_VERSION,
          entitlement: {
            conditional: "filter_for_public_visibility",
            required: "authenticated_account",
          },
          id: "collection.create",
          oauth: {
            any_of_scopes: ["collection:write"],
            audience: ATTENTION_MCP_OAUTH_AUDIENCE,
          },
          summary:
            "Collect a URL or platform share text privately, or publicly when the account has live Filter status.",
          tool_name: "attention_collect_content",
          web_surface: {
            kind: "page",
            path: "/collect",
            shared_policy: true,
          },
        },
        {
          contract_version: ATTENTION_MCP_TOOL_CONTRACT_VERSION,
          entitlement: {
            conditional: "filter_for_public_visibility",
            required: "authenticated_account",
          },
          id: "collection.candidate.select",
          oauth: {
            any_of_scopes: ["collection:write"],
            audience: ATTENTION_MCP_OAUTH_AUDIENCE,
          },
          summary:
            "Resolve one ambiguous collection attempt by selecting a candidate using its one-time selection token.",
          tool_name: "attention_select_collection_candidate",
          web_surface: {
            kind: "page",
            path: "/collect",
            shared_policy: true,
          },
        },
        {
          contract_version: ATTENTION_MCP_TOOL_CONTRACT_VERSION,
          entitlement: {
            conditional: null,
            required: "authenticated_account",
          },
          id: "collection.status.read",
          oauth: {
            any_of_scopes: ["collection:read"],
            audience: ATTENTION_MCP_OAUTH_AUDIENCE,
          },
          summary:
            "Read processing, collection, and content status for an owned collection attempt or collection.",
          tool_name: "attention_get_collection_status",
          web_surface: {
            kind: "page",
            path: "/collect",
            shared_policy: true,
          },
        },
        {
          contract_version: ATTENTION_MCP_TOOL_CONTRACT_VERSION,
          entitlement: {
            conditional: "filter_for_public_visibility",
            required: "authenticated_account",
          },
          id: "collection.visibility.update",
          oauth: {
            any_of_scopes: ["collection:write"],
            audience: ATTENTION_MCP_OAUTH_AUDIENCE,
          },
          summary:
            "Change an owned collection between private and public while enforcing live Filter status for public visibility.",
          tool_name: "attention_update_collection",
          web_surface: {
            kind: "page",
            path: "/account",
            shared_policy: true,
          },
        },
        {
          contract_version: ATTENTION_MCP_TOOL_CONTRACT_VERSION,
          entitlement: {
            conditional: "member_for_full_public_feed",
            required: "authenticated_account",
          },
          id: "public-content.list",
          oauth: {
            any_of_scopes: ["public:read", "public:full"],
            audience: ATTENTION_MCP_OAUTH_AUDIENCE,
          },
          summary:
            "List the chronological public feed with the same preview wall and full-feed Member policy as the website.",
          tool_name: "attention_list_public_content",
          web_surface: {
            kind: "page",
            path: "/ai",
            shared_policy: true,
          },
        },
        {
          contract_version: ATTENTION_MCP_TOOL_CONTRACT_VERSION,
          entitlement: { conditional: null, required: "member" },
          id: "content.search",
          oauth: {
            any_of_scopes: ["ai:search"],
            audience: ATTENTION_MCP_OAUTH_AUDIENCE,
          },
          summary:
            "Search owned collections and the complete public network and return citations to original-link routes.",
          tool_name: "attention_search_content",
          web_surface: {
            kind: "api",
            path: "/api/agent/query",
            shared_policy: true,
          },
        },
        {
          contract_version: ATTENTION_MCP_TOOL_CONTRACT_VERSION,
          entitlement: {
            conditional: null,
            required: "authenticated_account",
          },
          id: "moderation.report.create",
          oauth: {
            any_of_scopes: ["moderation:write"],
            audience: ATTENTION_MCP_OAUTH_AUDIENCE,
          },
          summary:
            "Report public content after explicit user confirmation, with duplicate reports handled idempotently.",
          tool_name: "attention_report_content",
          web_surface: {
            kind: "api",
            path: "/api/moderation/reports",
            shared_policy: true,
          },
        },
        {
          contract_version: ATTENTION_MCP_TOOL_CONTRACT_VERSION,
          entitlement: { conditional: null, required: "filter" },
          id: "moderation.court.list",
          oauth: {
            any_of_scopes: ["moderation:court:read"],
            audience: ATTENTION_MCP_OAUTH_AUDIENCE,
          },
          summary:
            "List current moderation-court cases, vote counts, prior vote, and original-link routes for an active Filter.",
          tool_name: "attention_list_moderation_cases",
          web_surface: {
            kind: "page",
            path: "/account/court",
            shared_policy: true,
          },
        },
        {
          contract_version: ATTENTION_MCP_TOOL_CONTRACT_VERSION,
          entitlement: { conditional: null, required: "filter" },
          id: "moderation.court.vote",
          oauth: {
            any_of_scopes: ["moderation:court:vote"],
            audience: ATTENTION_MCP_OAUTH_AUDIENCE,
          },
          summary:
            "Cast an active Filter's irreversible moderation vote only after explicit confirmation of the exact case and decision.",
          tool_name: "attention_cast_moderation_vote",
          web_surface: {
            kind: "page",
            path: "/account/court",
            shared_policy: true,
          },
        },
        {
          contract_version: ATTENTION_MCP_TOOL_CONTRACT_VERSION,
          entitlement: {
            conditional: null,
            required: "authenticated_account",
          },
          id: "digest.settings.read",
          oauth: {
            any_of_scopes: ["digest:read"],
            audience: ATTENTION_MCP_OAUTH_AUDIENCE,
          },
          summary:
            "Read digest schedule, domains, delivery settings, and current eligibility without modifying delivery.",
          tool_name: "attention_get_digest_settings",
          web_surface: {
            kind: "page",
            path: "/account/digests",
            shared_policy: true,
          },
        },
        {
          contract_version: ATTENTION_MCP_TOOL_CONTRACT_VERSION,
          entitlement: {
            conditional: null,
            required: "member_or_filter",
          },
          id: "digest.settings.update",
          oauth: {
            any_of_scopes: ["digest:write"],
            audience: ATTENTION_MCP_OAUTH_AUDIENCE,
          },
          summary:
            "Enable, disable, or reschedule digest delivery with the same domain and live entitlement checks as the website.",
          tool_name: "attention_update_digest_settings",
          web_surface: {
            kind: "page",
            path: "/account/digests",
            shared_policy: true,
          },
        },
      ],
    },
    release_stage: "infrastructure_only",
    schema_version: ATTENTION_CAPABILITY_MANIFEST_SCHEMA_VERSION,
    web_only: [
      {
        id: "account.authentication",
        reason:
          "Email verification, password login, and browser-session bootstrap cannot be delegated to a bearer credential that does not exist until authentication succeeds.",
        reason_code: "credential_bootstrap_boundary",
        summary:
          "Register, sign in, verify email ownership, and establish the browser session used to approve later Agent access.",
        web_surface: { kind: "page", path: "/login" },
      },
      {
        id: "account.security",
        reason:
          "Password changes and session logout stay behind a fresh interactive browser session so a compromised MCP credential cannot replace account credentials or terminate sessions.",
        reason_code: "credential_lifecycle_boundary",
        summary:
          "Set or change the account password and manage the current authenticated browser session.",
        web_surface: { kind: "page", path: "/account/security" },
      },
      {
        id: "account.public-identity",
        reason:
          "Display name, Attention ID, and avatar changes affect public attribution and therefore require an explicit human-controlled profile interaction rather than an Agent content workflow.",
        reason_code: "human_identity_boundary",
        summary:
          "Edit public identity fields and avatar while preserving the Attention ID rename policy.",
        web_surface: { kind: "page", path: "/account/settings" },
      },
      {
        id: "agent.credential-management",
        reason:
          "OAuth consent, client revocation, and API Key creation or revocation must not be exposed through the same credential whose authority they could expand, replace, or conceal.",
        reason_code: "credential_lifecycle_boundary",
        summary:
          "Approve Agent access and create, inspect, or revoke OAuth connections and API Keys.",
        web_surface: { kind: "page", path: "/account/connections" },
      },
      {
        id: "membership.checkout",
        reason:
          "Starting a paid subscription requires interactive price disclosure, payment-provider checkout, and user confirmation; MCP only exposes read-only membership status.",
        reason_code: "interactive_payment_boundary",
        summary:
          "Review membership terms and start or manage an interactive paid subscription checkout.",
        web_surface: { kind: "page", path: "/membership" },
      },
      {
        id: "growth.rewards",
        reason:
          "Invitation rewards, Filter redemption codes, and annual gifts remain in a rate-limited human flow because automating issuance or redemption would weaken abuse controls.",
        reason_code: "anti_abuse_boundary",
        summary:
          "Create and redeem invitation or Filter reward codes and inspect the account's reward state.",
        web_surface: { kind: "page", path: "/account/rewards" },
      },
    ],
  } satisfies AttentionCapabilityManifest);
