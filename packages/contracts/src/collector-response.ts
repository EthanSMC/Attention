import { z } from "zod";

export const SourceAdapterIdSchema = z.enum([
  "douyin",
  "xiaohongshu",
  "wechat_official_article",
  "generic_web"
]);
export type SourceAdapterId = z.infer<typeof SourceAdapterIdSchema>;

export const ContentTypeSchema = z.enum([
  "video",
  "note",
  "article",
  "web_page"
]);
export type ContentType = z.infer<typeof ContentTypeSchema>;

export const CollectionVisibilitySchema = z.enum(["public", "private"]);
export type CollectionVisibility = z.infer<
  typeof CollectionVisibilitySchema
>;

const AttemptResponseBaseSchema = z.object({
  attempt_id: z.string().min(1),
  received_at: z.string().datetime({ offset: true })
});

const EstablishedCollectionFieldsSchema = z.object({
  content_id: z.string().min(1),
  collection_id: z.string().min(1),
  source: SourceAdapterIdSchema,
  content_type: ContentTypeSchema,
  current_visibility: CollectionVisibilitySchema,
  display_title: z.string().max(1_024).optional()
});

export const AcceptedResponseSchema = AttemptResponseBaseSchema.merge(
  EstablishedCollectionFieldsSchema
)
  .extend({ status: z.literal("accepted") })
  .strict();

export const AlreadyCollectedResponseSchema = AttemptResponseBaseSchema.merge(
  EstablishedCollectionFieldsSchema
)
  .extend({ status: z.literal("already_collected") })
  .strict();

export const MergedWithExistingContentResponseSchema =
  AttemptResponseBaseSchema.merge(EstablishedCollectionFieldsSchema)
    .extend({ status: z.literal("merged_with_existing_content") })
    .strict();

export const AmbiguousCandidateSchema = z
  .object({
    candidate_id: z.string().min(1),
    source: SourceAdapterIdSchema,
    content_type: ContentTypeSchema,
    display_host: z.string().min(1).max(255),
    display_title: z.string().max(1_024).optional()
  })
  .strict();

export const AmbiguousResponseSchema = AttemptResponseBaseSchema.extend({
  status: z.literal("ambiguous"),
  candidates: z.array(AmbiguousCandidateSchema).min(2).max(16),
  selection_token: z.string().min(32).max(512),
  selection_expires_at: z.string().datetime({ offset: true })
}).strict();

export const ResolutionPendingResponseSchema =
  AttemptResponseBaseSchema.extend({
    status: z.literal("resolution_pending"),
    source: SourceAdapterIdSchema.optional(),
    retry_after_seconds: z.number().int().positive().max(86_400).optional()
  }).strict();

export const InvalidResponseSchema = AttemptResponseBaseSchema.extend({
  status: z.literal("invalid"),
  error_code: z.string().min(1).max(128)
}).strict();

export const UnsafeResponseSchema = AttemptResponseBaseSchema.extend({
  status: z.literal("unsafe"),
  error_code: z.string().min(1).max(128)
}).strict();

export const CollectorResponseSchema = z.discriminatedUnion("status", [
  AcceptedResponseSchema,
  AlreadyCollectedResponseSchema,
  MergedWithExistingContentResponseSchema,
  AmbiguousResponseSchema,
  ResolutionPendingResponseSchema,
  InvalidResponseSchema,
  UnsafeResponseSchema
]);

export type AcceptedResponse = z.infer<typeof AcceptedResponseSchema>;
export type AlreadyCollectedResponse = z.infer<
  typeof AlreadyCollectedResponseSchema
>;
export type MergedWithExistingContentResponse = z.infer<
  typeof MergedWithExistingContentResponseSchema
>;
export type AmbiguousCandidate = z.infer<typeof AmbiguousCandidateSchema>;
export type AmbiguousResponse = z.infer<typeof AmbiguousResponseSchema>;
export type ResolutionPendingResponse = z.infer<
  typeof ResolutionPendingResponseSchema
>;
export type InvalidResponse = z.infer<typeof InvalidResponseSchema>;
export type UnsafeResponse = z.infer<typeof UnsafeResponseSchema>;
export type CollectorResponse = z.infer<typeof CollectorResponseSchema>;
