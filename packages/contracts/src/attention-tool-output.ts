import { z } from "zod";

import { CollectorResponseSchema } from "./collector-response";

const isoDateTimeSchema = z.string().datetime({ offset: true });
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const absoluteUrlSchema = z.string().url();
const databaseIdSchema = z.string().uuid();
const attentionIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{5,19}$/u);

const capabilitiesSchema = z
  .object({
    is_filter: z.boolean(),
    is_member: z.boolean(),
  })
  .strict();

const filterAttributionSchema = z
  .object({
    attention_id: attentionIdSchema.nullable(),
    display_name: z.string().min(1).max(100),
  })
  .strict();

const collectionListItemSchema = z
  .object({
    author: z.string().nullable(),
    collected_at: isoDateTimeSchema,
    collection_id: databaseIdSchema,
    effective_visibility: z.enum(["public", "private", "paused", "blocked"]),
    filters: z.array(filterAttributionSchema),
    first_public_at: isoDateTimeSchema,
    original_url: absoluteUrlSchema.nullable(),
    published_at: dateSchema.nullable(),
    source: z.string(),
    summary: z.string().nullable(),
    summary_status: z.enum(["processing", "ready", "unavailable"]),
    tags: z.array(z.string()),
    title: z.string(),
    visibility: z.enum(["public", "private"]),
  })
  .strict();

const publicContentListItemSchema = z
  .object({
    author: z.string().nullable(),
    content_id: databaseIdSchema,
    filters: z.array(filterAttributionSchema),
    first_public_at: isoDateTimeSchema,
    original_url: absoluteUrlSchema.nullable(),
    published_at: dateSchema.nullable(),
    source: z.string(),
    summary: z.string().nullable(),
    summary_status: z.enum(["processing", "ready", "unavailable"]),
    tags: z.array(z.string()),
    title: z.string(),
  })
  .strict();

const collectionAttemptStatusSchema = z
  .object({
    attempt_id: databaseIdSchema,
    error_code: z.string().nullable(),
    next_action: z.enum(["none", "retry", "select_candidate", "wait"]),
    received_at: isoDateTimeSchema,
    retry_after_seconds: z.number().int().positive().nullable(),
    selection_expires_at: isoDateTimeSchema.nullable(),
    status: z.enum([
      "processing",
      "accepted",
      "already_collected",
      "merged_with_existing_content",
      "ambiguous",
      "resolution_pending",
      "invalid",
      "unsafe",
      "failed",
    ]),
    updated_at: isoDateTimeSchema,
  })
  .strict();

const ownedCollectionStatusSchema = z
  .object({
    collected_at: isoDateTimeSchema,
    collection_id: databaseIdSchema,
    collection_status: z.enum(["active", "deleted"]),
    effectively_public: z.boolean(),
    filter_revoked_at: isoDateTimeSchema.nullable(),
    moderation_status: z.enum(["blocked", "clear"]),
    original_url: absoluteUrlSchema.nullable(),
    public_since: isoDateTimeSchema.nullable(),
    updated_at: isoDateTimeSchema,
    visibility: z.enum(["private", "public"]),
  })
  .strict();

const ownedContentStatusSchema = z
  .object({
    community_moderation_status: z.enum(["clear", "hidden", "pending_review"]),
    content_id: databaseIdSchema,
    content_status: z.enum(["active", "merged"]),
    content_type: z.string(),
    enrichment_action: z.enum(["reuse_summary", "generate_summary", "none"]),
    enrichment_status: z.enum(["complete", "failed", "partial", "pending", "processing"]),
    public_read_url: absoluteUrlSchema.nullable(),
    public_safety_status: z.enum(["allowed", "blocked"]),
    source: z.string(),
    summary_status: z.enum(["hidden", "pending", "ready", "unavailable"]),
    takedown_status: z.enum(["none", "removed"]),
    title: z.string().nullable(),
    updated_at: isoDateTimeSchema,
  })
  .strict();

const digestDomainSchema = z
  .object({
    active: z.boolean(),
    name: z.string(),
    slug: z.string(),
  })
  .strict();

const digestSettingsSchema = z
  .object({
    domains: z.array(digestDomainSchema),
    enabled: z.boolean(),
    timezone: z.string(),
    window_minutes: z.number().int().min(15).max(240),
    window_start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
  })
  .strict();

export const AttentionToolStructuredErrorSchema = z
  .object({
    error: z
      .object({
        code: z.string().min(1),
        guidance: z.string().min(1),
        request_id: z.string().min(1),
        required_entitlement: z
          .enum(["filter", "member", "member_or_filter"])
          .optional(),
        required_scope: z.string().min(1).optional(),
        retry_after_seconds: z.number().int().positive().optional(),
      })
      .strict(),
  })
  .strict();

export const AttentionToolSuccessOutputSchemas = {
  attention_get_my_account: z
    .object({
      capabilities: capabilitiesSchema,
      profile: z
        .object({
          attention_id: attentionIdSchema.nullable(),
          display_name: z.string().min(1).max(100),
          has_avatar: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  attention_get_membership_status: z
    .object({
      capabilities: capabilitiesSchema,
      subscription: z
        .object({
          cancel_at_period_end: z.boolean(),
          current_period_end: isoDateTimeSchema,
          status: z.enum(["trialing", "active", "past_due", "cancelled", "expired"]),
        })
        .strict()
        .nullable(),
    })
    .strict(),
  attention_list_collections: z
    .object({
      count: z.number().int().nonnegative(),
      has_more: z.boolean(),
      items: z.array(collectionListItemSchema),
      next_offset: z.number().int().nonnegative().nullable(),
      offset: z.number().int().nonnegative(),
      total_count: z.number().int().nonnegative(),
    })
    .strict(),
  attention_collect_content: CollectorResponseSchema,
  attention_submit_content_enrichment: z
    .object({
      content_id: databaseIdSchema,
      status: z.enum(["enriched", "already_enriched"]),
      summary_status: z.literal("ready"),
    })
    .strict(),
  attention_select_collection_candidate: CollectorResponseSchema,
  attention_get_collection_status: z
    .object({
      attempt: collectionAttemptStatusSchema.nullable(),
      collection: ownedCollectionStatusSchema.nullable(),
      content: ownedContentStatusSchema.nullable(),
    })
    .strict(),
  attention_update_collection: z
    .object({
      collection_id: databaseIdSchema,
      effectively_public: z.boolean(),
      original_url: absoluteUrlSchema.nullable(),
      updated_at: isoDateTimeSchema,
      visibility: z.enum(["private", "public"]),
    })
    .strict(),
  attention_list_public_content: z
    .object({
      count: z.number().int().nonnegative(),
      has_more: z.boolean(),
      items: z.array(publicContentListItemSchema),
      next_offset: z.number().int().nonnegative().nullable(),
      offset: z.number().int().nonnegative(),
      preview_limited: z.boolean(),
      total_count: z.number().int().nonnegative(),
    })
    .strict(),
  attention_search_content: z
    .object({
      answer: z.string(),
      citations: z.array(
        z
          .object({
            author: z.string().nullable(),
            href: absoluteUrlSchema,
            id: databaseIdSchema,
            scope: z.enum(["mine", "public"]),
            source: z.string(),
            title: z.string(),
          })
          .strict(),
      ),
      mode: z.enum(["deterministic", "generated"]),
    })
    .strict(),
  attention_report_content: z
    .object({
      case_id: databaseIdSchema.nullable(),
      case_opened: z.boolean(),
      community_status: z.enum(["clear", "hidden", "pending_review"]),
      duplicate: z.boolean(),
      report_id: databaseIdSchema,
    })
    .strict(),
  attention_list_moderation_cases: z
    .object({
      cases: z.array(
        z
          .object({
            author: z.string().nullable(),
            community_status: z.enum(["clear", "hidden", "pending_review"]),
            eligible_filter_count: z.number().int().nonnegative(),
            hidden_votes: z.number().int().nonnegative(),
            id: databaseIdSchema,
            my_vote: z.enum(["public", "hidden"]).nullable(),
            opened_at: isoDateTimeSchema,
            original_url: absoluteUrlSchema.nullable(),
            public_content_id: databaseIdSchema,
            public_votes: z.number().int().nonnegative(),
            source: z.string(),
            status: z.enum(["open", "requires_admin"]),
            title: z.string().nullable(),
            voting_ends_at: isoDateTimeSchema,
          })
          .strict(),
      ),
      count: z.number().int().nonnegative(),
      has_more: z.boolean(),
      next_offset: z.number().int().nonnegative().nullable(),
      offset: z.number().int().nonnegative(),
      total_count: z.number().int().nonnegative(),
    })
    .strict(),
  attention_cast_moderation_vote: z
    .object({
      case_id: databaseIdSchema,
      decision: z.enum(["public", "hidden"]),
      duplicate: z.boolean(),
      vote_id: databaseIdSchema,
    })
    .strict(),
  attention_get_digest_settings: z
    .object({
      eligible: z.boolean(),
      settings: digestSettingsSchema,
    })
    .strict(),
  attention_update_digest_settings: z
    .object({ settings: digestSettingsSchema })
    .strict(),
} as const;

export type AttentionToolSuccessOutputName =
  keyof typeof AttentionToolSuccessOutputSchemas;
