import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgPolicy,
  pgTable,
  pgView,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar
} from "drizzle-orm/pg-core";

const timestampColumns = () => ({
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
});

export const accountStatusEnum = pgEnum("account_status", [
  "invited",
  "active",
  "suspended",
  "deleted"
]);
export const entitlementSourceEnum = pgEnum("entitlement_source", [
  "invite",
  "admin_grant",
  "filter_grant"
]);
export const invitationKindEnum = pgEnum("invitation_kind", ["member", "filter"]);
export const inputChannelEnum = pgEnum("input_channel", ["web", "wechat"]);
export const inputPayloadTypeEnum = pgEnum("input_payload_type", ["text", "link_card", "url"]);
export const inputAttemptStatusEnum = pgEnum("input_attempt_status", [
  "processing",
  "accepted",
  "already_collected",
  "merged_with_existing_content",
  "ambiguous",
  "resolution_pending",
  "invalid",
  "unsafe",
  "failed"
]);
export const contentStatusEnum = pgEnum("content_status", ["active", "merged"]);
export const contentIdentityKindEnum = pgEnum("content_identity_kind", [
  "normalized",
  "canonical"
]);
export const canonicalTrustStatusEnum = pgEnum("canonical_trust_status", [
  "unknown",
  "trusted",
  "rejected"
]);
export const linkResolutionStatusEnum = pgEnum("link_resolution_status", [
  "pending",
  "resolved",
  "failed"
]);
export const safetyStatusEnum = pgEnum("safety_status", ["allowed", "blocked"]);
export const summaryStatusEnum = pgEnum("summary_status", [
  "pending",
  "ready",
  "unavailable",
  "hidden",
  "failed"
]);
export const enrichmentStatusEnum = pgEnum("enrichment_status", [
  "pending",
  "processing",
  "partial",
  "complete",
  "failed"
]);
export const takedownStatusEnum = pgEnum("takedown_status", ["none", "removed"]);
export const collectionVisibilityEnum = pgEnum("collection_visibility", ["public", "private"]);
export const collectionStatusEnum = pgEnum("collection_status", ["active", "deleted"]);
export const moderationStatusEnum = pgEnum("moderation_status", ["clear", "blocked"]);
export const jobStatusEnum = pgEnum("job_status", [
  "pending",
  "running",
  "completed",
  "failed"
]);
export const eventScopeEnum = pgEnum("event_scope", ["public", "private", "system"]);

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    stableHandle: varchar("stable_handle", { length: 64 }).notNull(),
    status: accountStatusEnum("status").default("invited").notNull(),
    ...timestampColumns()
  },
  (table) => [
    uniqueIndex("accounts_stable_handle_unique").on(table.stableHandle),
    check("accounts_stable_handle_not_blank", sql`btrim(${table.stableHandle}) <> ''`)
  ]
);

export const entitlements = pgTable(
  "entitlements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    memberEnabled: boolean("member_enabled").default(true).notNull(),
    source: entitlementSourceEnum("source").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).defaultNow().notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("entitlements_account_source_unique").on(table.accountId, table.source),
    index("entitlements_active_lookup_idx").on(table.accountId, table.memberEnabled, table.startsAt),
    check("entitlements_valid_window", sql`${table.endsAt} IS NULL OR ${table.endsAt} > ${table.startsAt}`)
  ]
);

export const filterProfiles = pgTable(
  "filter_profiles",
  {
    accountId: uuid("account_id")
      .primaryKey()
      .references(() => accounts.id, { onDelete: "cascade" }),
    displayName: varchar("display_name", { length: 100 }).notNull(),
    avatarUrl: text("avatar_url"),
    invitedAt: timestamp("invited_at", { withTimezone: true }).defaultNow().notNull(),
    active: boolean("active").default(true).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    index("filter_profiles_active_idx").on(table.active, table.invitedAt),
    check(
      "filter_profiles_active_revocation_shape",
      sql`(${table.active} AND ${table.revokedAt} IS NULL) OR (NOT ${table.active})`
    )
  ]
);

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tokenHash: char("token_hash", { length: 64 }).notNull(),
    kind: invitationKindEnum("kind").notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    createdByAccountId: uuid("created_by_account_id").references(() => accounts.id, {
      onDelete: "set null"
    }),
    filterDisplayName: varchar("filter_display_name", { length: 100 }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    consumedByAccountId: uuid("consumed_by_account_id").references(() => accounts.id, {
      onDelete: "set null"
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("invitations_token_hash_unique").on(table.tokenHash),
    index("invitations_account_idx").on(table.accountId, table.createdAt),
    check("invitations_expire_after_creation", sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      "invitations_consumption_shape",
      sql`(${table.consumedAt} IS NULL AND ${table.consumedByAccountId} IS NULL) OR (${table.consumedAt} IS NOT NULL AND ${table.consumedByAccountId} IS NOT NULL)`
    )
  ]
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    tokenHash: char("token_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("sessions_token_hash_unique").on(table.tokenHash),
    index("sessions_account_active_idx").on(table.accountId, table.expiresAt),
    check("sessions_expire_after_creation", sql`${table.expiresAt} > ${table.createdAt}`),
    check("sessions_revoked_after_creation", sql`${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.createdAt}`)
  ]
);

export const domains = pgTable(
  "domains",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: varchar("slug", { length: 64 }).notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    active: boolean("active").default(true).notNull(),
    ...timestampColumns()
  },
  (table) => [
    uniqueIndex("domains_slug_unique").on(table.slug),
    check("domains_slug_not_blank", sql`btrim(${table.slug}) <> ''`)
  ]
);

export const contents = pgTable(
  "contents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    publicId: uuid("public_id").defaultRandom().notNull(),
    outboundUrl: text("outbound_url").notNull(),
    normalizedUrl: text("normalized_url").notNull(),
    canonicalUrl: text("canonical_url").notNull(),
    contentStatus: contentStatusEnum("content_status").default("active").notNull(),
    mergedIntoContentId: uuid("merged_into_content_id").references(
      (): AnyPgColumn => contents.id,
      { onDelete: "restrict" }
    ),
    firstPublicAt: timestamp("first_public_at", { withTimezone: true }),
    visibilityVersion: integer("visibility_version").default(0).notNull(),
    source: varchar("source", { length: 100 }).notNull(),
    contentType: varchar("content_type", { length: 64 }).default("webpage").notNull(),
    title: text("title"),
    author: text("author"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    cachedFaviconAssetKey: text("cached_favicon_asset_key"),
    aiSummary: text("ai_summary"),
    summaryStatus: summaryStatusEnum("summary_status").default("pending").notNull(),
    enrichmentStatus: enrichmentStatusEnum("enrichment_status").default("pending").notNull(),
    publicSafetyStatus: safetyStatusEnum("public_safety_status").default("allowed").notNull(),
    takedownStatus: takedownStatusEnum("takedown_status").default("none").notNull(),
    restrictionReasonCode: varchar("restriction_reason_code", { length: 100 }),
    restrictedAt: timestamp("restricted_at", { withTimezone: true }),
    restrictedByAccountId: uuid("restricted_by_account_id").references(() => accounts.id, {
      onDelete: "set null"
    }),
    ...timestampColumns()
  },
  (table) => [
    uniqueIndex("contents_public_id_unique").on(table.publicId),
    index("contents_public_order_idx").on(table.firstPublicAt),
    check("contents_visibility_version_nonnegative", sql`${table.visibilityVersion} >= 0`),
    check(
      "contents_merge_shape",
      sql`(${table.contentStatus} = 'active' AND ${table.mergedIntoContentId} IS NULL) OR (${table.contentStatus} = 'merged' AND ${table.mergedIntoContentId} IS NOT NULL)`
    ),
    check(
      "contents_restriction_shape",
      sql`(${table.publicSafetyStatus} = 'allowed' AND ${table.takedownStatus} = 'none' AND ${table.restrictedAt} IS NULL AND ${table.restrictionReasonCode} IS NULL) OR (${table.publicSafetyStatus} = 'blocked' OR ${table.takedownStatus} = 'removed')`
    )
  ]
);

export const contentIdentities = pgTable(
  "content_identities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contentId: uuid("content_id")
      .notNull()
      .references(() => contents.id, { onDelete: "cascade" }),
    dedupeKey: text("dedupe_key").notNull(),
    identityKind: contentIdentityKindEnum("identity_kind").default("normalized").notNull(),
    normalizedUrl: text("normalized_url").notNull(),
    sourceAdapter: varchar("source_adapter", { length: 100 }).notNull(),
    adapterVersion: varchar("adapter_version", { length: 64 }).notNull(),
    active: boolean("active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("content_identities_dedupe_key_unique").on(table.dedupeKey),
    index("content_identities_content_idx").on(table.contentId, table.active),
    check("content_identities_dedupe_key_not_blank", sql`btrim(${table.dedupeKey}) <> ''`)
  ]
);

export const inputAttempts = pgTable(
  "input_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    channel: inputChannelEnum("channel").notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    channelMessageId: varchar("channel_message_id", { length: 128 }).notNull(),
    payloadType: inputPayloadTypeEnum("payload_type").notNull(),
    inputHmac: char("input_hmac", { length: 64 }).notNull(),
    parserVersion: varchar("parser_version", { length: 64 }).notNull(),
    candidateCount: smallint("candidate_count").default(0).notNull(),
    safeSelectedUrl: text("safe_selected_url"),
    unsafeCandidateFingerprint: char("unsafe_candidate_fingerprint", { length: 64 }),
    redirectChain: jsonb("redirect_chain").$type<string[]>().default(sql`'[]'::jsonb`).notNull(),
    selectionTokenHash: char("selection_token_hash", { length: 64 }),
    selectionExpiresAt: timestamp("selection_expires_at", { withTimezone: true }),
    selectionConsumedAt: timestamp("selection_consumed_at", { withTimezone: true }),
    sourceAdapter: varchar("source_adapter", { length: 100 }),
    status: inputAttemptStatusEnum("status").default("processing").notNull(),
    errorCode: varchar("error_code", { length: 100 }),
    leaseOwner: varchar("lease_owner", { length: 100 }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    resultContentId: uuid("result_content_id").references(() => contents.id, { onDelete: "set null" }),
    resultCollectionId: uuid("result_collection_id").references(
      (): AnyPgColumn => collections.id,
      { onDelete: "set null" }
    ),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("input_attempts_channel_message_unique").on(
      table.channel,
      table.accountId,
      table.channelMessageId
    ),
    index("input_attempts_account_received_idx").on(table.accountId, table.receivedAt),
    check("input_attempts_candidate_count_range", sql`${table.candidateCount} BETWEEN 0 AND 16`),
    check(
      "input_attempts_selection_shape",
      sql`(${table.selectionTokenHash} IS NULL AND ${table.selectionExpiresAt} IS NULL) OR (${table.selectionTokenHash} IS NOT NULL AND ${table.selectionExpiresAt} IS NOT NULL)`
    ),
    check(
      "input_attempts_lease_shape",
      sql`(${table.leaseOwner} IS NULL AND ${table.leaseExpiresAt} IS NULL) OR (${table.leaseOwner} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)`
    )
  ]
);

export const inputCandidates = pgTable(
  "input_candidates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    inputAttemptId: uuid("input_attempt_id")
      .notNull()
      .references(() => inputAttempts.id, { onDelete: "cascade" }),
    ordinal: smallint("ordinal").notNull(),
    urlFingerprint: char("url_fingerprint", { length: 64 }).notNull(),
    displayHost: varchar("display_host", { length: 255 }).notNull(),
    sourceAdapter: varchar("source_adapter", { length: 100 }),
    confidence: smallint("confidence").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("input_candidates_attempt_ordinal_unique").on(table.inputAttemptId, table.ordinal),
    check("input_candidates_ordinal_range", sql`${table.ordinal} BETWEEN 0 AND 15`),
    check("input_candidates_confidence_range", sql`${table.confidence} BETWEEN 0 AND 100`)
  ]
);

export const pendingCandidateSets = pgTable(
  "pending_candidate_sets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    inputAttemptId: uuid("input_attempt_id")
      .notNull()
      .references(() => inputAttempts.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    tokenHash: char("token_hash", { length: 64 }).notNull(),
    encryptedPayload: text("encrypted_payload").notNull(),
    candidateCount: smallint("candidate_count").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("pending_candidate_sets_attempt_unique").on(table.inputAttemptId),
    uniqueIndex("pending_candidate_sets_token_hash_unique").on(table.tokenHash),
    index("pending_candidate_sets_expiry_idx").on(table.expiresAt),
    check("pending_candidate_sets_candidate_count_range", sql`${table.candidateCount} BETWEEN 2 AND 16`),
    check("pending_candidate_sets_expire_after_creation", sql`${table.expiresAt} > ${table.createdAt}`)
  ]
);

export const contentLinks = pgTable(
  "content_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contentId: uuid("content_id")
      .notNull()
      .references(() => contents.id, { onDelete: "cascade" }),
    inputAttemptId: uuid("input_attempt_id")
      .notNull()
      .references(() => inputAttempts.id, { onDelete: "cascade" }),
    safeSelectedUrl: text("safe_selected_url").notNull(),
    resolvedUrl: text("resolved_url").notNull(),
    normalizedUrl: text("normalized_url").notNull(),
    redirectChain: jsonb("redirect_chain").$type<string[]>().default(sql`'[]'::jsonb`).notNull(),
    sourceAdapter: varchar("source_adapter", { length: 100 }).notNull(),
    adapterVersion: varchar("adapter_version", { length: 64 }).notNull(),
    observedCanonicalUrl: text("observed_canonical_url"),
    canonicalTrustStatus: canonicalTrustStatusEnum("canonical_trust_status").default("unknown").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).defaultNow().notNull(),
    resolutionStatus: linkResolutionStatusEnum("resolution_status").default("resolved").notNull(),
    safetyStatus: safetyStatusEnum("safety_status").default("allowed").notNull()
  },
  (table) => [
    index("content_links_content_idx").on(table.contentId, table.observedAt),
    index("content_links_attempt_idx").on(table.inputAttemptId)
  ]
);

export const contentAliases = pgTable(
  "content_aliases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    aliasContentId: uuid("alias_content_id")
      .notNull()
      .references(() => contents.id, { onDelete: "cascade" }),
    primaryContentId: uuid("primary_content_id")
      .notNull()
      .references(() => contents.id, { onDelete: "restrict" }),
    aliasDedupeKey: text("alias_dedupe_key").notNull(),
    ruleVersion: varchar("rule_version", { length: 64 }).notNull(),
    reasonCode: varchar("reason_code", { length: 100 }).notNull(),
    active: boolean("active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    disabledAt: timestamp("disabled_at", { withTimezone: true })
  },
  (table) => [
    uniqueIndex("content_aliases_alias_content_unique").on(table.aliasContentId),
    uniqueIndex("content_aliases_dedupe_key_unique").on(table.aliasDedupeKey),
    index("content_aliases_primary_idx").on(table.primaryContentId, table.active),
    check("content_aliases_distinct_contents", sql`${table.aliasContentId} <> ${table.primaryContentId}`),
    check(
      "content_aliases_active_shape",
      sql`(${table.active} AND ${table.disabledAt} IS NULL) OR (NOT ${table.active} AND ${table.disabledAt} IS NOT NULL)`
    )
  ]
);

export const collections = pgTable(
  "collections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    contentId: uuid("content_id")
      .notNull()
      .references(() => contents.id, { onDelete: "cascade" }),
    domainId: uuid("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "restrict" }),
    visibility: collectionVisibilityEnum("visibility").notNull(),
    collectedAt: timestamp("collected_at", { withTimezone: true }).defaultNow().notNull(),
    publicSince: timestamp("public_since", { withTimezone: true }),
    sourceChannel: inputChannelEnum("source_channel").notNull(),
    collectionStatus: collectionStatusEnum("collection_status").default("active").notNull(),
    filterRevokedAt: timestamp("filter_revoked_at", { withTimezone: true }),
    moderationStatus: moderationStatusEnum("moderation_status").default("clear").notNull(),
    ...timestampColumns()
  },
  (table) => {
    const ownerPredicate = sql`${table.accountId} = NULLIF(current_setting('app.account_id', true), '')::uuid`;
    return [
      uniqueIndex("collections_account_content_unique").on(table.accountId, table.contentId),
      index("collections_public_lookup_idx").on(
        table.contentId,
        table.collectionStatus,
        table.visibility,
        table.moderationStatus
      ),
      index("collections_account_collected_idx").on(table.accountId, table.collectedAt),
      check(
        "collections_visibility_public_since_shape",
        sql`(${table.visibility} = 'private' AND ${table.publicSince} IS NULL) OR (${table.visibility} = 'public' AND ${table.publicSince} IS NOT NULL)`
      ),
      pgPolicy("collections_owner_access", {
        as: "permissive",
        for: "all",
        to: "attention_web_runtime",
        using: ownerPredicate,
        withCheck: ownerPredicate
      })
    ];
  }
).enableRLS();

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    queue: varchar("queue", { length: 100 }).default("default").notNull(),
    taskType: varchar("task_type", { length: 100 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
    status: jobStatusEnum("status").default("pending").notNull(),
    idempotencyKey: text("idempotency_key"),
    attempts: smallint("attempts").default(0).notNull(),
    maxAttempts: smallint("max_attempts").default(8).notNull(),
    availableAt: timestamp("available_at", { withTimezone: true }).defaultNow().notNull(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: varchar("locked_by", { length: 100 }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastErrorCode: varchar("last_error_code", { length: 100 }),
    ...timestampColumns()
  },
  (table) => [
    uniqueIndex("jobs_idempotency_key_unique").on(table.idempotencyKey),
    index("jobs_available_idx").on(table.queue, table.status, table.availableAt),
    check("jobs_attempts_range", sql`${table.attempts} >= 0 AND ${table.attempts} <= ${table.maxAttempts}`),
    check("jobs_max_attempts_positive", sql`${table.maxAttempts} > 0`),
    check(
      "jobs_lock_shape",
      sql`(${table.lockedAt} IS NULL AND ${table.lockedBy} IS NULL) OR (${table.lockedAt} IS NOT NULL AND ${table.lockedBy} IS NOT NULL)`
    )
  ]
);

export const collectionEvents = pgTable(
  "collection_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    contentId: uuid("content_id")
      .notNull()
      .references(() => contents.id, { onDelete: "cascade" }),
    eventType: varchar("event_type", { length: 100 }).notNull(),
    previousState: jsonb("previous_state").$type<Record<string, unknown>>(),
    nextState: jsonb("next_state").$type<Record<string, unknown>>().notNull(),
    actorAccountId: uuid("actor_account_id").references(() => accounts.id, { onDelete: "set null" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [index("collection_events_collection_time_idx").on(table.collectionId, table.occurredAt)]
);

export const eventLedger = pgTable(
  "event_ledger",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventType: varchar("event_type", { length: 100 }).notNull(),
    contentId: uuid("content_id").references(() => contents.id, { onDelete: "set null" }),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "set null" }),
    anonymousSessionId: varchar("anonymous_session_id", { length: 128 }),
    requestId: varchar("request_id", { length: 128 }),
    dedupeKey: text("dedupe_key"),
    scope: eventScopeEnum("scope").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("event_ledger_dedupe_key_unique").on(table.dedupeKey),
    index("event_ledger_content_time_idx").on(table.contentId, table.occurredAt),
    index("event_ledger_account_time_idx").on(table.accountId, table.occurredAt)
  ]
);

export const publicContentsCurrent = pgView("public_contents_current", {
  id: uuid("id").notNull(),
  publicId: uuid("public_id").notNull(),
  outboundUrl: text("outbound_url").notNull(),
  normalizedUrl: text("normalized_url").notNull(),
  canonicalUrl: text("canonical_url").notNull(),
  firstPublicAt: timestamp("first_public_at", { withTimezone: true }).notNull(),
  visibilityVersion: integer("visibility_version").notNull(),
  source: varchar("source", { length: 100 }).notNull(),
  contentType: varchar("content_type", { length: 64 }).notNull(),
  title: text("title"),
  author: text("author"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  cachedFaviconAssetKey: text("cached_favicon_asset_key"),
  aiSummary: text("ai_summary"),
  summaryStatus: summaryStatusEnum("summary_status").notNull(),
  enrichmentStatus: enrichmentStatusEnum("enrichment_status").notNull(),
  publicCollectionCount: integer("public_collection_count").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
})
  .with({ securityBarrier: true })
  .as(sql`
    SELECT
      c.id,
      c.public_id,
      c.outbound_url,
      c.normalized_url,
      c.canonical_url,
      c.first_public_at,
      c.visibility_version,
      c.source,
      c.content_type,
      c.title,
      c.author,
      c.published_at,
      c.cached_favicon_asset_key,
      c.ai_summary,
      c.summary_status,
      c.enrichment_status,
      count(col.id)::integer AS public_collection_count,
      c.created_at,
      c.updated_at
    FROM contents c
    JOIN collections col ON col.content_id = c.id
    JOIN filter_profiles fp ON fp.account_id = col.account_id
    JOIN accounts a ON a.id = col.account_id
    JOIN domains d ON d.id = col.domain_id
    WHERE c.content_status = 'active'
      AND c.public_safety_status = 'allowed'
      AND c.takedown_status = 'none'
      AND c.first_public_at IS NOT NULL
      AND col.collection_status = 'active'
      AND col.visibility = 'public'
      AND col.public_since IS NOT NULL
      AND col.filter_revoked_at IS NULL
      AND col.moderation_status = 'clear'
      AND fp.active = true
      AND fp.revoked_at IS NULL
      AND a.status = 'active'
      AND d.active = true
    GROUP BY c.id
  `);

export const publicContentAttributionsCurrent = pgView(
  "public_content_attributions_current",
  {
    avatarUrl: text("avatar_url"),
    contentId: uuid("content_id").notNull(),
    displayName: varchar("display_name", { length: 100 }).notNull(),
    stableHandle: varchar("stable_handle", { length: 64 }).notNull()
  }
)
  .with({ securityBarrier: true })
  .as(sql`
    SELECT
      col.content_id,
      a.stable_handle,
      fp.display_name,
      fp.avatar_url
    FROM collections col
    JOIN contents c ON c.id = col.content_id
    JOIN filter_profiles fp ON fp.account_id = col.account_id
    JOIN accounts a ON a.id = col.account_id
    JOIN domains d ON d.id = col.domain_id
    WHERE c.content_status = 'active'
      AND c.public_safety_status = 'allowed'
      AND c.takedown_status = 'none'
      AND c.first_public_at IS NOT NULL
      AND col.collection_status = 'active'
      AND col.visibility = 'public'
      AND col.public_since IS NOT NULL
      AND col.filter_revoked_at IS NULL
      AND col.moderation_status = 'clear'
      AND fp.active = true
      AND fp.revoked_at IS NULL
      AND a.status = 'active'
      AND d.active = true
  `);

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type Content = typeof contents.$inferSelect;
export type Collection = typeof collections.$inferSelect;
