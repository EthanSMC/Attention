import { sql } from "drizzle-orm";
import {
  AGENT_INTEGRATION_IDS,
  CHANNEL_BINDING_STATUSES,
  CHANNEL_OWNER_KINDS,
  INSTALLATION_STATUSES,
  LOCAL_CHANNEL_PROVIDERS,
  type RuntimeCapabilities,
  type RuntimeCheckpointReport
} from "@attention/contracts";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  char,
  check,
  date,
  foreignKey,
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
  unique,
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
export const signupSourceEnum = pgEnum("signup_source", ["direct", "consumer_referral"]);
export const entitlementSourceEnum = pgEnum("entitlement_source", [
  "signup",
  "invite",
  "admin_grant",
  "filter_grant"
]);
export const membershipGrantKindEnum = pgEnum("membership_grant_kind", [
  "filter_grant",
  "direct_trial",
  "consumer_invitee_quarter",
  "consumer_inviter_quarter",
  "filter_annual_redemption",
  "admin_grant"
]);
export const membershipGrantStatusEnum = pgEnum("membership_grant_status", [
  "scheduled",
  "active",
  "revoked",
  "expired"
]);
export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "trialing",
  "active",
  "past_due",
  "cancelled",
  "expired"
]);
export const consumerReferralStatusEnum = pgEnum("consumer_referral_status", [
  "active",
  "redeemed",
  "invalidated"
]);
export const filterAnnualCodeStatusEnum = pgEnum("filter_annual_code_status", [
  "active",
  "redeemed",
  "invalidated"
]);
export const growthTokenKindEnum = pgEnum("growth_token_kind", [
  "consumer_referral",
  "filter_annual"
]);
export const growthBillingEventTypeEnum = pgEnum("growth_billing_event_type", [
  "paid_subscription_bound",
  "renewal_settled",
  "renewal_refunded",
  "renewal_chargeback"
]);
export const pointsEntryTypeEnum = pgEnum("points_entry_type", [
  "earn",
  "reversal",
  "reserve",
  "release",
  "consume"
]);
export const pointsReservationStatusEnum = pgEnum("points_reservation_status", [
  "reserved",
  "released",
  "consumed"
]);
export const oauthCredentialStatusEnum = pgEnum("oauth_credential_status", [
  "active",
  "revoked"
]);
export const oauthConnectionKindEnum = pgEnum("oauth_connection_kind", [
  "mcp",
  "runtime"
]);
export const apiCredentialStatusEnum = pgEnum("api_credential_status", [
  "active",
  "revoked"
]);
export const agentIntegrationIdEnum = pgEnum(
  "agent_integration_id",
  AGENT_INTEGRATION_IDS
);
export const channelOwnerKindEnum = pgEnum(
  "channel_owner_kind",
  CHANNEL_OWNER_KINDS
);
export const installationStatusEnum = pgEnum(
  "installation_status",
  INSTALLATION_STATUSES
);
export const localChannelProviderEnum = pgEnum(
  "local_channel_provider",
  LOCAL_CHANNEL_PROVIDERS
);
export const externalChannelBindingStatusEnum = pgEnum(
  "external_channel_binding_status",
  CHANNEL_BINDING_STATUSES
);
export const channelProviderEnum = pgEnum("channel_provider", [
  "wechat",
  "wecom",
  "douyin",
  "xiaohongshu"
]);
export const bindIntentStatusEnum = pgEnum("bind_intent_status", [
  "pending",
  "confirmed",
  "consumed",
  "expired",
  "cancelled",
  "conflict"
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
export const communityModerationStatusEnum = pgEnum("community_moderation_status", [
  "clear",
  "pending_review",
  "hidden"
]);
export const contentReporterKindEnum = pgEnum("content_reporter_kind", [
  "consumer",
  "filter"
]);
export const moderationCaseStatusEnum = pgEnum("moderation_case_status", [
  "open",
  "resolved",
  "requires_admin"
]);
export const moderationDecisionEnum = pgEnum("moderation_decision", ["public", "hidden"]);
export const moderationCaseResolutionEnum = pgEnum("moderation_case_resolution", [
  "public",
  "hidden",
  "requires_admin"
]);
export const jobStatusEnum = pgEnum("job_status", [
  "pending",
  "running",
  "completed",
  "failed"
]);
export const digestDeliveryStatusEnum = pgEnum("digest_delivery_status", [
  "pending",
  "sending",
  "sent",
  "skipped",
  "failed"
]);
export const eventScopeEnum = pgEnum("event_scope", ["public", "private", "system"]);

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    primaryEmail: varchar("primary_email", { length: 320 }),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    passwordHash: text("password_hash"),
    stableHandle: varchar("stable_handle", { length: 64 }).notNull(),
    attentionId: varchar("attention_id", { length: 20 }),
    attentionIdChangedAt: timestamp("attention_id_changed_at", { withTimezone: true }),
    displayName: varchar("display_name", { length: 100 }).default("用户").notNull(),
    avatarUrl: text("avatar_url"),
    signupSource: signupSourceEnum("signup_source").default("direct").notNull(),
    directTrialConsumedAt: timestamp("direct_trial_consumed_at", { withTimezone: true }),
    directTrialSourceEventKey: varchar("direct_trial_source_event_key", { length: 320 }),
    termsAcceptedAt: timestamp("terms_accepted_at", { withTimezone: true }),
    termsVersion: varchar("terms_version", { length: 32 }),
    privacyVersion: varchar("privacy_version", { length: 32 }),
    status: accountStatusEnum("status").default("active").notNull(),
    ...timestampColumns()
  },
  (table) => [
    uniqueIndex("accounts_primary_email_unique").on(table.primaryEmail),
    uniqueIndex("accounts_stable_handle_unique").on(table.stableHandle),
    uniqueIndex("accounts_attention_id_unique")
      .on(table.attentionId)
      .where(sql`${table.attentionId} IS NOT NULL`),
    uniqueIndex("accounts_direct_trial_source_event_unique").on(
      table.directTrialSourceEventKey
    ),
    check(
      "accounts_email_verification_shape",
      sql`${table.primaryEmail} IS NULL OR ${table.emailVerifiedAt} IS NOT NULL`
    ),
    check("accounts_stable_handle_not_blank", sql`btrim(${table.stableHandle}) <> ''`),
    check(
      "accounts_attention_id_format",
      sql`${table.attentionId} IS NULL OR ${table.attentionId} ~ '^[a-z][a-z0-9_-]{5,19}$'`,
    ),
    check(
      "accounts_attention_id_change_shape",
      sql`(${table.attentionId} IS NULL AND ${table.attentionIdChangedAt} IS NULL) OR (${table.attentionId} IS NOT NULL AND ${table.attentionIdChangedAt} IS NOT NULL)`,
    ),
    check(
      "accounts_direct_trial_consumption_shape",
      sql`(${table.directTrialConsumedAt} IS NULL AND ${table.directTrialSourceEventKey} IS NULL) OR (${table.directTrialConsumedAt} IS NOT NULL AND ${table.directTrialSourceEventKey} IS NOT NULL)`
    )
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

export const consumerReferrals = pgTable(
  "consumer_referrals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    inviterAccountId: uuid("inviter_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    tokenHash: char("token_hash", { length: 64 }).notNull(),
    status: consumerReferralStatusEnum("status").default("active").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    inviteeAccountId: uuid("invitee_account_id").references(() => accounts.id, {
      onDelete: "restrict"
    }),
    registeredAt: timestamp("registered_at", { withTimezone: true }),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidatedReason: varchar("invalidated_reason", { length: 64 }),
    ...timestampColumns()
  },
  (table) => {
    const actorAccountId = sql`NULLIF(current_setting('app.account_id', true), '')::uuid`;
    const tokenPredicate = sql`${table.tokenHash} = NULLIF(current_setting('app.consumer_referral_token_hash', true), '')`;
    const intentPredicate = sql`${table.id}::text = NULLIF(current_setting('app.consumer_referral_id', true), '')`;
    const participantPredicate = sql`${table.inviterAccountId} = ${actorAccountId} OR ${table.inviteeAccountId} = ${actorAccountId}`;
    return [
      uniqueIndex("consumer_referrals_token_hash_unique").on(table.tokenHash),
      uniqueIndex("consumer_referrals_active_inviter_unique")
        .on(table.inviterAccountId)
        .where(sql`${table.status} = 'active'`),
      index("consumer_referrals_successful_inviter_idx")
        .on(table.inviterAccountId)
        .where(sql`${table.status} = 'redeemed'`),
      uniqueIndex("consumer_referrals_successful_invitee_unique")
        .on(table.inviteeAccountId)
        .where(sql`${table.status} = 'redeemed'`),
      index("consumer_referrals_inviter_created_idx").on(
        table.inviterAccountId,
        table.createdAt
      ),
      check("consumer_referrals_expire_after_creation", sql`${table.expiresAt} > ${table.createdAt}`),
      check(
        "consumer_referrals_distinct_accounts",
        sql`${table.inviteeAccountId} IS NULL OR ${table.inviteeAccountId} <> ${table.inviterAccountId}`
      ),
      check(
        "consumer_referrals_state_shape",
        sql`(${table.status} = 'active' AND ${table.inviteeAccountId} IS NULL AND ${table.registeredAt} IS NULL AND ${table.invalidatedAt} IS NULL AND ${table.invalidatedReason} IS NULL) OR (${table.status} = 'redeemed' AND ${table.inviteeAccountId} IS NOT NULL AND ${table.registeredAt} IS NOT NULL AND ${table.invalidatedAt} IS NULL AND ${table.invalidatedReason} IS NULL) OR (${table.status} = 'invalidated' AND ${table.inviteeAccountId} IS NULL AND ${table.registeredAt} IS NULL AND ${table.invalidatedAt} IS NOT NULL AND ${table.invalidatedReason} IS NOT NULL)`
      ),
      pgPolicy("consumer_referrals_web_read", {
        as: "permissive",
        for: "select",
        to: "attention_web_runtime",
        using: sql`${participantPredicate} OR ${tokenPredicate} OR ${intentPredicate}`
      }),
      pgPolicy("consumer_referrals_web_insert", {
        as: "permissive",
        for: "insert",
        to: "attention_web_runtime",
        withCheck: sql`${table.inviterAccountId} = ${actorAccountId}`
      }),
      pgPolicy("consumer_referrals_web_invalidate", {
        as: "permissive",
        for: "update",
        to: "attention_web_runtime",
        using: sql`${table.inviterAccountId} = ${actorAccountId} AND ${table.status} = 'active'`,
        withCheck: sql`${table.inviterAccountId} = ${actorAccountId} AND ${table.status} = 'invalidated' AND ${table.inviteeAccountId} IS NULL AND ${table.registeredAt} IS NULL`
      }),
      pgPolicy("consumer_referrals_web_redeem", {
        as: "permissive",
        for: "update",
        to: "attention_web_runtime",
        using: sql`${intentPredicate} AND ${table.status} = 'active'`,
        withCheck: sql`${intentPredicate} AND ${table.status} = 'redeemed' AND ${table.inviteeAccountId} = ${actorAccountId}`
      }),
      pgPolicy("consumer_referrals_worker_read", {
        as: "permissive",
        for: "select",
        to: "attention_worker_runtime",
        using: sql`true`
      })
    ];
  }
).enableRLS();

export const filterAnnualCodes = pgTable(
  "filter_annual_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    issuerFilterAccountId: uuid("issuer_filter_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    tokenHash: char("token_hash", { length: 64 }).notNull(),
    issuanceYear: smallint("issuance_year").notNull(),
    status: filterAnnualCodeStatusEnum("status").default("active").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    redeemedByAccountId: uuid("redeemed_by_account_id").references(() => accounts.id, {
      onDelete: "restrict"
    }),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidatedReason: varchar("invalidated_reason", { length: 64 }),
    ...timestampColumns()
  },
  (table) => {
    const actorAccountId = sql`NULLIF(current_setting('app.account_id', true), '')::uuid`;
    const tokenPredicate = sql`${table.tokenHash} = NULLIF(current_setting('app.filter_annual_token_hash', true), '')`;
    const ownerPredicate = sql`${table.issuerFilterAccountId} = ${actorAccountId} OR ${table.redeemedByAccountId} = ${actorAccountId}`;
    return [
      uniqueIndex("filter_annual_codes_token_hash_unique").on(table.tokenHash),
      index("filter_annual_codes_issuer_year_idx").on(
        table.issuerFilterAccountId,
        table.issuanceYear,
        table.createdAt
      ),
      check("filter_annual_codes_year_range", sql`${table.issuanceYear} BETWEEN 2020 AND 9999`),
      check("filter_annual_codes_expire_after_creation", sql`${table.expiresAt} > ${table.createdAt}`),
      check(
        "filter_annual_codes_distinct_accounts",
        sql`${table.redeemedByAccountId} IS NULL OR ${table.redeemedByAccountId} <> ${table.issuerFilterAccountId}`
      ),
      check(
        "filter_annual_codes_state_shape",
        sql`(${table.status} = 'active' AND ${table.redeemedByAccountId} IS NULL AND ${table.redeemedAt} IS NULL AND ${table.invalidatedAt} IS NULL AND ${table.invalidatedReason} IS NULL) OR (${table.status} = 'redeemed' AND ${table.redeemedByAccountId} IS NOT NULL AND ${table.redeemedAt} IS NOT NULL AND ${table.invalidatedAt} IS NULL AND ${table.invalidatedReason} IS NULL) OR (${table.status} = 'invalidated' AND ${table.redeemedByAccountId} IS NULL AND ${table.redeemedAt} IS NULL AND ${table.invalidatedAt} IS NOT NULL AND ${table.invalidatedReason} IS NOT NULL)`
      ),
      pgPolicy("filter_annual_codes_web_read", {
        as: "permissive",
        for: "select",
        to: "attention_web_runtime",
        using: sql`${ownerPredicate} OR ${tokenPredicate}`
      }),
      pgPolicy("filter_annual_codes_web_insert", {
        as: "permissive",
        for: "insert",
        to: "attention_web_runtime",
        withCheck: sql`${table.issuerFilterAccountId} = ${actorAccountId}`
      }),
      pgPolicy("filter_annual_codes_web_redeem", {
        as: "permissive",
        for: "update",
        to: "attention_web_runtime",
        using: sql`${tokenPredicate} AND ${table.status} = 'active'`,
        withCheck: sql`${tokenPredicate} AND ${table.status} = 'redeemed' AND ${table.redeemedByAccountId} = ${actorAccountId}`
      })
    ];
  }
).enableRLS();

export const growthTokenAttempts = pgTable(
  "growth_token_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tokenKind: growthTokenKindEnum("token_kind").notNull(),
    tokenHash: char("token_hash", { length: 64 }).notNull(),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "cascade" }),
    requesterFingerprint: char("requester_fingerprint", { length: 64 }),
    success: boolean("success").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => {
    const actorAccountId = sql`NULLIF(current_setting('app.account_id', true), '')::uuid`;
    const requesterFingerprint = sql`NULLIF(current_setting('app.growth_requester_fingerprint', true), '')`;
    return [
      index("growth_token_attempts_account_created_idx").on(
        table.accountId,
        table.tokenKind,
        table.createdAt
      ),
      index("growth_token_attempts_fingerprint_created_idx").on(
        table.requesterFingerprint,
        table.tokenKind,
        table.createdAt
      ),
      check(
        "growth_token_attempts_actor_present",
        sql`${table.accountId} IS NOT NULL OR ${table.requesterFingerprint} IS NOT NULL`
      ),
      pgPolicy("growth_token_attempts_web_read_account", {
        as: "permissive",
        for: "select",
        to: "attention_web_runtime",
        using: sql`${table.accountId} = ${actorAccountId}`
      }),
      pgPolicy("growth_token_attempts_web_read_fingerprint", {
        as: "permissive",
        for: "select",
        to: "attention_web_runtime",
        using: sql`${table.accountId} IS NULL AND ${table.requesterFingerprint} = ${requesterFingerprint}`
      }),
      pgPolicy("growth_token_attempts_web_insert", {
        as: "permissive",
        for: "insert",
        to: "attention_web_runtime",
        withCheck: sql`(${table.accountId} = ${actorAccountId} AND ${table.requesterFingerprint} IS NULL) OR (${table.accountId} IS NULL AND ${table.requesterFingerprint} = ${requesterFingerprint})`
      }),
      pgPolicy("growth_token_attempts_web_mark_success", {
        as: "permissive",
        for: "update",
        to: "attention_web_runtime",
        using: sql`${table.accountId} = ${actorAccountId} AND ${table.tokenKind} = 'filter_annual'`,
        withCheck: sql`${table.accountId} = ${actorAccountId} AND ${table.tokenKind} = 'filter_annual' AND ${table.success}`
      })
    ];
  }
).enableRLS();

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

export const loginChallenges = pgTable(
  "login_challenges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: varchar("email", { length: 320 }).notNull(),
    codeHash: char("code_hash", { length: 64 }).notNull(),
    requesterFingerprint: char("requester_fingerprint", { length: 64 }),
    consumerReferralId: uuid("consumer_referral_id").references(() => consumerReferrals.id, {
      onDelete: "restrict"
    }),
    returnTo: text("return_to").default("/ai").notNull(),
    failedAttempts: smallint("failed_attempts").default(0).notNull(),
    maxAttempts: smallint("max_attempts").default(5).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    index("login_challenges_email_created_idx").on(table.email, table.createdAt),
    index("login_challenges_fingerprint_created_idx").on(
      table.requesterFingerprint,
      table.createdAt
    ),
    index("login_challenges_consumer_referral_idx").on(
      table.consumerReferralId,
      table.createdAt
    ),
    check(
      "login_challenges_attempts_range",
      sql`${table.failedAttempts} >= 0 AND ${table.failedAttempts} <= ${table.maxAttempts}`
    ),
    check("login_challenges_max_attempts_positive", sql`${table.maxAttempts} > 0`),
    check("login_challenges_expire_after_creation", sql`${table.expiresAt} > ${table.createdAt}`)
  ]
);

export const passwordLoginAttempts = pgTable(
  "password_login_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: varchar("email", { length: 320 }).notNull(),
    requesterFingerprint: char("requester_fingerprint", { length: 64 }),
    success: boolean("success").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    index("password_login_attempts_email_created_idx").on(table.email, table.createdAt),
    index("password_login_attempts_fingerprint_created_idx").on(
      table.requesterFingerprint,
      table.createdAt
    )
  ]
);

export const membershipGrants = pgTable(
  "membership_grants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    kind: membershipGrantKindEnum("kind").notNull(),
    sourceId: varchar("source_id", { length: 255 }).notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    status: membershipGrantStatusEnum("status").default("scheduled").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revocationReason: varchar("revocation_reason", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("membership_grants_kind_source_unique").on(table.kind, table.sourceId),
    uniqueIndex("membership_grants_direct_trial_account_unique")
      .on(table.accountId)
      .where(sql`${table.kind} = 'direct_trial'`),
    index("membership_grants_account_window_idx").on(
      table.accountId,
      table.status,
      table.startsAt,
      table.endsAt
    ),
    check("membership_grants_valid_window", sql`${table.endsAt} > ${table.startsAt}`),
    check(
      "membership_grants_revocation_shape",
      sql`(${table.status} = 'revoked' AND ${table.revokedAt} IS NOT NULL) OR (${table.status} <> 'revoked')`
    )
  ]
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 64 }).notNull(),
    providerCustomerId: varchar("provider_customer_id", { length: 255 }),
    providerSubscriptionId: varchar("provider_subscription_id", { length: 255 }),
    status: subscriptionStatusEnum("status").notNull(),
    introEligible: boolean("intro_eligible").default(true).notNull(),
    firstChargeAt: timestamp("first_charge_at", { withTimezone: true }),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }).notNull(),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }).notNull(),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false).notNull(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    ...timestampColumns()
  },
  (table) => [
    uniqueIndex("subscriptions_provider_subscription_unique").on(
      table.provider,
      table.providerSubscriptionId
    ),
    index("subscriptions_account_status_idx").on(table.accountId, table.status),
    check(
      "subscriptions_valid_period",
      sql`${table.currentPeriodEnd} > ${table.currentPeriodStart}`
    )
  ]
);

export const growthBillingEvents = pgTable(
  "growth_billing_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: varchar("provider", { length: 64 }).notNull(),
    providerEventId: varchar("provider_event_id", { length: 255 }).notNull(),
    eventType: growthBillingEventTypeEnum("event_type").notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, {
      onDelete: "restrict"
    }),
    referralId: uuid("referral_id").references(() => consumerReferrals.id, {
      onDelete: "restrict"
    }),
    originalEventId: uuid("original_event_id").references(
      (): AnyPgColumn => growthBillingEvents.id,
      { onDelete: "restrict" }
    ),
    currency: char("currency", { length: 3 }),
    cashAmountMinor: bigint("cash_amount_minor", { mode: "number" }),
    pointsAmountMinor: bigint("points_amount_minor", { mode: "number" }).default(0).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => {
    const ownerPredicate = sql`${table.accountId} = NULLIF(current_setting('app.account_id', true), '')::uuid`;
    return [
      uniqueIndex("growth_billing_events_provider_event_unique").on(
        table.provider,
        table.providerEventId
      ),
      index("growth_billing_events_original_idx").on(table.originalEventId, table.createdAt),
      index("growth_billing_events_account_time_idx").on(table.accountId, table.occurredAt),
      check("growth_billing_events_provider_not_blank", sql`btrim(${table.provider}) <> ''`),
      check(
        "growth_billing_events_currency_shape",
        sql`${table.currency} IS NULL OR ${table.currency} ~ '^[A-Z]{3}$'`
      ),
      check(
        "growth_billing_events_amounts_nonnegative",
        sql`(${table.cashAmountMinor} IS NULL OR ${table.cashAmountMinor} > 0) AND ${table.pointsAmountMinor} >= 0`
      ),
      check(
        "growth_billing_events_event_shape",
        sql`(${table.eventType} = 'paid_subscription_bound' AND ${table.subscriptionId} IS NOT NULL AND ${table.originalEventId} IS NULL AND ${table.referralId} IS NULL AND ${table.currency} IS NULL AND ${table.cashAmountMinor} IS NULL AND ${table.pointsAmountMinor} = 0) OR (${table.eventType} = 'renewal_settled' AND ${table.subscriptionId} IS NOT NULL AND ${table.originalEventId} IS NULL AND ${table.currency} IS NOT NULL AND ${table.cashAmountMinor} IS NOT NULL) OR (${table.eventType} IN ('renewal_refunded', 'renewal_chargeback') AND ${table.subscriptionId} IS NOT NULL AND ${table.originalEventId} IS NOT NULL AND ${table.currency} IS NOT NULL AND ${table.cashAmountMinor} IS NOT NULL)`
      ),
      pgPolicy("growth_billing_events_web_owner_access", {
        as: "permissive",
        for: "all",
        to: "attention_web_runtime",
        using: ownerPredicate,
        withCheck: ownerPredicate
      }),
      pgPolicy("growth_billing_events_worker_access", {
        as: "permissive",
        for: "all",
        to: "attention_worker_runtime",
        using: sql`true`,
        withCheck: sql`true`
      })
    ];
  }
).enableRLS();

export const pointsBalances = pgTable(
  "points_balances",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    currency: char("currency", { length: 3 }).notNull(),
    availableMinor: bigint("available_minor", { mode: "number" }).default(0).notNull(),
    reservedMinor: bigint("reserved_minor", { mode: "number" }).default(0).notNull(),
    clawbackMinor: bigint("clawback_minor", { mode: "number" }).default(0).notNull(),
    ...timestampColumns()
  },
  (table) => {
    const ownerPredicate = sql`${table.accountId} = NULLIF(current_setting('app.account_id', true), '')::uuid`;
    return [
      uniqueIndex("points_balances_account_currency_unique").on(
        table.accountId,
        table.currency
      ),
      check("points_balances_currency_shape", sql`${table.currency} ~ '^[A-Z]{3}$'`),
      check(
        "points_balances_nonnegative",
        sql`${table.availableMinor} >= 0 AND ${table.reservedMinor} >= 0 AND ${table.clawbackMinor} >= 0`
      ),
      pgPolicy("points_balances_web_owner_access", {
        as: "permissive",
        for: "all",
        to: "attention_web_runtime",
        using: ownerPredicate,
        withCheck: ownerPredicate
      }),
      pgPolicy("points_balances_worker_access", {
        as: "permissive",
        for: "all",
        to: "attention_worker_runtime",
        using: sql`true`,
        withCheck: sql`true`
      })
    ];
  }
).enableRLS();

export const pointsReservations = pgTable(
  "points_reservations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    currency: char("currency", { length: 3 }).notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
    status: pointsReservationStatusEnum("status").default("reserved").notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    ...timestampColumns()
  },
  (table) => {
    const ownerPredicate = sql`${table.accountId} = NULLIF(current_setting('app.account_id', true), '')::uuid`;
    return [
      uniqueIndex("points_reservations_account_idempotency_unique").on(
        table.accountId,
        table.idempotencyKey
      ),
      index("points_reservations_account_status_idx").on(table.accountId, table.status),
      check("points_reservations_currency_shape", sql`${table.currency} ~ '^[A-Z]{3}$'`),
      check("points_reservations_amount_positive", sql`${table.amountMinor} > 0`),
      check("points_reservations_key_not_blank", sql`btrim(${table.idempotencyKey}) <> ''`),
      check(
        "points_reservations_state_shape",
        sql`(${table.status} = 'reserved' AND ${table.releasedAt} IS NULL AND ${table.consumedAt} IS NULL) OR (${table.status} = 'released' AND ${table.releasedAt} IS NOT NULL AND ${table.consumedAt} IS NULL) OR (${table.status} = 'consumed' AND ${table.releasedAt} IS NULL AND ${table.consumedAt} IS NOT NULL)`
      ),
      pgPolicy("points_reservations_web_owner_access", {
        as: "permissive",
        for: "all",
        to: "attention_web_runtime",
        using: ownerPredicate,
        withCheck: ownerPredicate
      }),
      pgPolicy("points_reservations_worker_access", {
        as: "permissive",
        for: "all",
        to: "attention_worker_runtime",
        using: sql`true`,
        withCheck: sql`true`
      })
    ];
  }
).enableRLS();

export const pointsLedgerEntries = pgTable(
  "points_ledger_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    currency: char("currency", { length: 3 }).notNull(),
    entryType: pointsEntryTypeEnum("entry_type").notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    availableDeltaMinor: bigint("available_delta_minor", { mode: "number" }).notNull(),
    reservedDeltaMinor: bigint("reserved_delta_minor", { mode: "number" }).notNull(),
    clawbackDeltaMinor: bigint("clawback_delta_minor", { mode: "number" }).notNull(),
    availableAfterMinor: bigint("available_after_minor", { mode: "number" }).notNull(),
    reservedAfterMinor: bigint("reserved_after_minor", { mode: "number" }).notNull(),
    clawbackAfterMinor: bigint("clawback_after_minor", { mode: "number" }).notNull(),
    billingEventId: uuid("billing_event_id").references(() => growthBillingEvents.id, {
      onDelete: "restrict"
    }),
    reservationId: uuid("reservation_id").references(() => pointsReservations.id, {
      onDelete: "restrict"
    }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => {
    const ownerPredicate = sql`${table.accountId} = NULLIF(current_setting('app.account_id', true), '')::uuid`;
    return [
      uniqueIndex("points_ledger_entries_billing_event_unique").on(table.billingEventId),
      uniqueIndex("points_ledger_entries_reservation_type_unique").on(
        table.reservationId,
        table.entryType
      ),
      index("points_ledger_entries_account_time_idx").on(
        table.accountId,
        table.occurredAt
      ),
      check("points_ledger_entries_currency_shape", sql`${table.currency} ~ '^[A-Z]{3}$'`),
      check("points_ledger_entries_amount_positive", sql`${table.amountMinor} > 0`),
      check(
        "points_ledger_entries_balances_nonnegative",
        sql`${table.availableAfterMinor} >= 0 AND ${table.reservedAfterMinor} >= 0 AND ${table.clawbackAfterMinor} >= 0`
      ),
      check(
        "points_ledger_entries_shape",
        sql`(${table.entryType} = 'earn' AND ${table.availableDeltaMinor} >= 0 AND ${table.reservedDeltaMinor} = 0 AND ${table.clawbackDeltaMinor} <= 0 AND ${table.availableDeltaMinor} - ${table.clawbackDeltaMinor} = ${table.amountMinor} AND ${table.billingEventId} IS NOT NULL AND ${table.reservationId} IS NULL) OR (${table.entryType} = 'reversal' AND ${table.availableDeltaMinor} <= 0 AND ${table.reservedDeltaMinor} = 0 AND ${table.clawbackDeltaMinor} >= 0 AND -${table.availableDeltaMinor} + ${table.clawbackDeltaMinor} = ${table.amountMinor} AND ${table.billingEventId} IS NOT NULL AND ${table.reservationId} IS NULL) OR (${table.entryType} = 'reserve' AND ${table.availableDeltaMinor} = -${table.amountMinor} AND ${table.reservedDeltaMinor} = ${table.amountMinor} AND ${table.clawbackDeltaMinor} = 0 AND ${table.billingEventId} IS NULL AND ${table.reservationId} IS NOT NULL) OR (${table.entryType} = 'release' AND ${table.availableDeltaMinor} = ${table.amountMinor} AND ${table.reservedDeltaMinor} = -${table.amountMinor} AND ${table.clawbackDeltaMinor} = 0 AND ${table.billingEventId} IS NULL AND ${table.reservationId} IS NOT NULL) OR (${table.entryType} = 'consume' AND ${table.availableDeltaMinor} = 0 AND ${table.reservedDeltaMinor} = -${table.amountMinor} AND ${table.clawbackDeltaMinor} = 0 AND ${table.billingEventId} IS NULL AND ${table.reservationId} IS NOT NULL)`
      ),
      pgPolicy("points_ledger_entries_web_read", {
        as: "permissive",
        for: "select",
        to: "attention_web_runtime",
        using: ownerPredicate
      }),
      pgPolicy("points_ledger_entries_web_insert", {
        as: "permissive",
        for: "insert",
        to: "attention_web_runtime",
        withCheck: ownerPredicate
      }),
      pgPolicy("points_ledger_entries_worker_access", {
        as: "permissive",
        for: "all",
        to: "attention_worker_runtime",
        using: sql`true`,
        withCheck: sql`true`
      })
    ];
  }
).enableRLS();

export const oauthClients = pgTable(
  "oauth_clients",
  {
    clientId: varchar("client_id", { length: 128 }).primaryKey(),
    name: varchar("name", { length: 100 }).notNull(),
    redirectUris: jsonb("redirect_uris").$type<string[]>().notNull(),
    allowedScopes: jsonb("allowed_scopes").$type<string[]>().notNull(),
    registrationFingerprint: char("registration_fingerprint", { length: 64 }),
    firstParty: boolean("first_party").default(false).notNull(),
    active: boolean("active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    index("oauth_clients_created_idx").on(table.createdAt),
    index("oauth_clients_registration_created_idx").on(
      table.registrationFingerprint,
      table.createdAt
    ),
    check("oauth_clients_name_not_blank", sql`btrim(${table.name}) <> ''`)
  ]
);

export const oauthConnections = pgTable(
  "oauth_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    clientId: varchar("client_id", { length: 128 })
      .notNull()
      .references(() => oauthClients.clientId),
    audience: varchar("audience", { length: 128 }).notNull(),
    kind: oauthConnectionKindEnum("kind").notNull(),
    label: varchar("label", { length: 80 }).notNull(),
    normalizedLabel: varchar("normalized_label", { length: 80 }).notNull(),
    deviceName: varchar("device_name", { length: 80 }),
    installationKeyHash: char("installation_key_hash", { length: 64 }),
    lastAuthorizedAt: timestamp("last_authorized_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("oauth_connections_active_name_unique")
      .on(table.accountId, table.audience, table.normalizedLabel)
      .where(sql`${table.revokedAt} IS NULL`)
  ]
);

export const oauthAuthorizationCodes = pgTable(
  "oauth_authorization_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    codeHash: char("code_hash", { length: 64 }).notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    clientId: varchar("client_id", { length: 128 })
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").references(() => oauthConnections.id),
    connectionLabel: varchar("connection_label", { length: 80 }),
    normalizedConnectionLabel: varchar("normalized_connection_label", { length: 80 }),
    replacementConnectionId: uuid("replacement_connection_id").references(
      () => oauthConnections.id
    ),
    redirectUri: text("redirect_uri").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    audience: varchar("audience", { length: 128 }).notNull(),
    codeChallenge: varchar("code_challenge", { length: 128 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("oauth_authorization_codes_hash_unique").on(table.codeHash),
    index("oauth_authorization_codes_account_idx").on(table.accountId, table.createdAt),
    check(
      "oauth_authorization_codes_expire_after_creation",
      sql`${table.expiresAt} > ${table.createdAt}`
    ),
    check(
      "oauth_authorization_codes_connection_intent_check",
      sql`(
        ${table.connectionLabel} IS NULL
        AND ${table.normalizedConnectionLabel} IS NULL
        AND ${table.replacementConnectionId} IS NULL
      ) OR (
        ${table.connectionId} IS NULL
        AND ${table.connectionLabel} IS NOT NULL
        AND ${table.normalizedConnectionLabel} IS NOT NULL
      )`
    ),
    check(
      "oauth_authorization_codes_connection_label_not_blank",
      sql`${table.connectionLabel} IS NULL OR char_length(${table.connectionLabel}) > 0`
    ),
    check(
      "oauth_authorization_codes_normalized_label_not_blank",
      sql`${table.normalizedConnectionLabel} IS NULL OR char_length(${table.normalizedConnectionLabel}) > 0`
    )
  ]
);

export const oauthAccessTokens = pgTable(
  "oauth_access_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tokenHash: char("token_hash", { length: 64 }).notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    clientId: varchar("client_id", { length: 128 })
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").references(() => oauthConnections.id),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    audience: varchar("audience", { length: 128 }).notNull(),
    status: oauthCredentialStatusEnum("status").default("active").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("oauth_access_tokens_hash_unique").on(table.tokenHash),
    index("oauth_access_tokens_account_idx").on(table.accountId, table.status, table.expiresAt),
    check("oauth_access_tokens_expire_after_creation", sql`${table.expiresAt} > ${table.createdAt}`)
  ]
);

export const oauthRefreshTokens = pgTable(
  "oauth_refresh_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tokenHash: char("token_hash", { length: 64 }).notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    clientId: varchar("client_id", { length: 128 })
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").references(() => oauthConnections.id),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    audience: varchar("audience", { length: 128 }).notNull(),
    status: oauthCredentialStatusEnum("status").default("active").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("oauth_refresh_tokens_hash_unique").on(table.tokenHash),
    index("oauth_refresh_tokens_account_idx").on(table.accountId, table.status, table.expiresAt),
    check("oauth_refresh_tokens_expire_after_creation", sql`${table.expiresAt} > ${table.createdAt}`)
  ]
);

export const apiCredentials = pgTable(
  "api_credentials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(),
    keyPrefix: varchar("key_prefix", { length: 24 }).notNull(),
    keyHash: char("key_hash", { length: 64 }).notNull(),
    keyVersion: smallint("key_version").default(1).notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    clientId: varchar("client_id", { length: 128 }),
    status: apiCredentialStatusEnum("status").default("active").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("api_credentials_key_hash_unique").on(table.keyHash),
    index("api_credentials_account_status_idx").on(table.accountId, table.status),
    check("api_credentials_name_not_blank", sql`btrim(${table.name}) <> ''`)
  ]
);

export const mcpRateLimitBuckets = pgTable(
  "mcp_rate_limit_buckets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    credentialId: uuid("credential_id").notNull(),
    clientKey: varchar("client_key", { length: 128 }).notNull(),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
    requestCount: integer("request_count").default(1).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("mcp_rate_limit_bucket_unique").on(
      table.accountId,
      table.credentialId,
      table.clientKey,
      table.windowStartedAt,
    ),
    index("mcp_rate_limit_account_window_idx").on(
      table.accountId,
      table.windowStartedAt,
    ),
    check(
      "mcp_rate_limit_request_count_positive",
      sql`${table.requestCount} > 0`,
    ),
    check(
      "mcp_rate_limit_client_key_not_blank",
      sql`btrim(${table.clientKey}) <> ''`,
    ),
    pgPolicy("mcp_rate_limit_bucket_owner_access", {
      as: "permissive",
      for: "all",
      to: "attention_web_runtime",
      using: sql`${table.accountId} = NULLIF(current_setting('app.account_id', true), '')::uuid`,
      withCheck: sql`${table.accountId} = NULLIF(current_setting('app.account_id', true), '')::uuid`,
    }),
  ],
).enableRLS();

export const agentInstallations = pgTable(
  "agent_installations",
  {
    id: uuid("id").primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    oauthClientId: varchar("oauth_client_id", { length: 128 })
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "restrict" }),
    agentIntegrationId: agentIntegrationIdEnum("agent_integration_id").notNull(),
    ownerKind: channelOwnerKindEnum("owner_kind").notNull(),
    deviceName: varchar("device_name", { length: 100 }).notNull(),
    adapterVersion: varchar("adapter_version", { length: 64 }).notNull(),
    skillVersion: varchar("skill_version", { length: 64 }).notNull(),
    toolContractVersion: varchar("tool_contract_version", { length: 64 }).notNull(),
    capabilities: jsonb("capabilities").$type<RuntimeCapabilities>().notNull(),
    runtimeCheckpoint: jsonb("runtime_checkpoint").$type<RuntimeCheckpointReport>(),
    status: installationStatusEnum("status").default("registered").notNull(),
    registeredAt: timestamp("registered_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => {
    const ownerPredicate = sql`${table.accountId} = NULLIF(current_setting('app.account_id', true), '')::uuid`;
    return [
      unique("agent_installations_id_account_unique").on(table.id, table.accountId),
      uniqueIndex("agent_installations_oauth_client_unique").on(table.oauthClientId),
      index("agent_installations_account_status_idx").on(table.accountId, table.status),
      index("agent_installations_status_last_seen_idx").on(table.status, table.lastSeenAt),
      check("agent_installations_device_name_not_blank", sql`btrim(${table.deviceName}) <> ''`),
      check(
        "agent_installations_versions_not_blank",
        sql`btrim(${table.adapterVersion}) <> '' AND btrim(${table.skillVersion}) <> '' AND btrim(${table.toolContractVersion}) <> ''`
      ),
      check(
        "agent_installations_owner_kind_matches_agent",
        sql`(${table.agentIntegrationId} IN ('openclaw', 'hermes', 'workbuddy') AND ${table.ownerKind} = 'native') OR (${table.agentIntegrationId} IN ('codex', 'claude-code') AND ${table.ownerKind} = 'bridge')`
      ),
      check(
        "agent_installations_capabilities_shape",
        sql`jsonb_typeof(${table.capabilities}) = 'object' AND ${table.capabilities} ?& ARRAY['heartbeat_mode', 'pairing_verification', 'restricted_profile'] AND ${table.capabilities} - ARRAY['heartbeat_mode', 'pairing_verification', 'restricted_profile'] = '{}'::jsonb AND ${table.capabilities}->>'heartbeat_mode' IN ('runtime', 'event_driven') AND ${table.capabilities}->'pairing_verification' = 'true'::jsonb AND jsonb_typeof(${table.capabilities}->'restricted_profile') = 'boolean' AND (${table.ownerKind} <> 'bridge' OR ${table.capabilities}->'restricted_profile' = 'true'::jsonb)`
      ),
      check(
        "agent_installations_runtime_checkpoint_shape",
        sql`${table.runtimeCheckpoint} IS NULL OR (jsonb_typeof(${table.runtimeCheckpoint}) = 'object' AND NOT (${table.runtimeCheckpoint} ?| ARRAY['token', 'thread_id', 'message', 'url', 'reply']))`
      ),
      check(
        "agent_installations_terminal_status_shape",
        sql`(${table.status} = 'disconnected' AND ${table.disconnectedAt} IS NOT NULL AND ${table.revokedAt} IS NULL) OR (${table.status} = 'revoked' AND ${table.revokedAt} IS NOT NULL) OR (${table.status} NOT IN ('disconnected', 'revoked') AND ${table.disconnectedAt} IS NULL AND ${table.revokedAt} IS NULL)`
      ),
      check(
        "agent_installations_timestamp_order",
        sql`(${table.lastSeenAt} IS NULL OR ${table.lastSeenAt} >= ${table.registeredAt}) AND (${table.disconnectedAt} IS NULL OR ${table.disconnectedAt} >= ${table.registeredAt}) AND (${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.registeredAt})`
      ),
      pgPolicy("agent_installations_owner_access", {
        as: "permissive",
        for: "all",
        to: "attention_web_runtime",
        using: ownerPredicate,
        withCheck: ownerPredicate
      })
    ];
  }
).enableRLS();

export const externalChannelBindings = pgTable(
  "external_channel_bindings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    installationId: uuid("installation_id").notNull(),
    provider: localChannelProviderEnum("provider").notNull(),
    channelAccountFingerprint: char("channel_account_fingerprint", { length: 64 }).notNull(),
    pairedPeerFingerprint: char("paired_peer_fingerprint", { length: 64 }),
    status: externalChannelBindingStatusEnum("status").default("reported").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => {
    const ownerPredicate = sql`${table.accountId} = NULLIF(current_setting('app.account_id', true), '')::uuid`;
    return [
      unique("external_channel_bindings_id_account_unique").on(table.id, table.accountId),
      foreignKey({
        name: "external_channel_bindings_installation_account_fk",
        columns: [table.installationId, table.accountId],
        foreignColumns: [agentInstallations.id, agentInstallations.accountId]
      }).onDelete("cascade"),
      uniqueIndex("external_channel_bindings_active_owner_unique")
        .on(table.provider, table.channelAccountFingerprint)
        .where(sql`${table.status} IN ('reported', 'verified', 'healthy', 'stale')`),
      index("external_channel_bindings_account_status_idx").on(table.accountId, table.status),
      index("external_channel_bindings_installation_status_idx").on(
        table.installationId,
        table.status
      ),
      index("external_channel_bindings_status_last_seen_idx").on(
        table.status,
        table.lastSeenAt
      ),
      check(
        "external_channel_bindings_channel_fingerprint_format",
        sql`${table.channelAccountFingerprint} ~ '^[0-9a-f]{64}$'`
      ),
      check(
        "external_channel_bindings_peer_fingerprint_format",
        sql`${table.pairedPeerFingerprint} IS NULL OR ${table.pairedPeerFingerprint} ~ '^[0-9a-f]{64}$'`
      ),
      check(
        "external_channel_bindings_verification_shape",
        sql`(${table.status} = 'reported' AND ${table.verifiedAt} IS NULL AND ${table.pairedPeerFingerprint} IS NULL) OR (${table.status} IN ('verified', 'healthy', 'stale') AND ${table.verifiedAt} IS NOT NULL AND ${table.pairedPeerFingerprint} IS NOT NULL) OR (${table.status} IN ('disconnected', 'revoked'))`
      ),
      check(
        "external_channel_bindings_terminal_status_shape",
        sql`(${table.status} = 'disconnected' AND ${table.disconnectedAt} IS NOT NULL AND ${table.revokedAt} IS NULL) OR (${table.status} = 'revoked' AND ${table.revokedAt} IS NOT NULL) OR (${table.status} NOT IN ('disconnected', 'revoked') AND ${table.disconnectedAt} IS NULL AND ${table.revokedAt} IS NULL)`
      ),
      check(
        "external_channel_bindings_timestamp_order",
        sql`(${table.verifiedAt} IS NULL OR ${table.verifiedAt} >= ${table.createdAt}) AND (${table.lastSeenAt} IS NULL OR ${table.lastSeenAt} >= ${table.createdAt}) AND (${table.disconnectedAt} IS NULL OR ${table.disconnectedAt} >= ${table.createdAt}) AND (${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.createdAt})`
      ),
      pgPolicy("external_channel_bindings_owner_access", {
        as: "permissive",
        for: "all",
        to: "attention_web_runtime",
        using: ownerPredicate,
        withCheck: ownerPredicate
      })
    ];
  }
).enableRLS();

export const externalChannelBindingChallenges = pgTable(
  "external_channel_binding_challenges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    bindingId: uuid("binding_id").notNull(),
    pairingCodeHash: char("pairing_code_hash", { length: 64 }).notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true })
  },
  (table) => {
    const ownerPredicate = sql`${table.accountId} = NULLIF(current_setting('app.account_id', true), '')::uuid`;
    return [
      foreignKey({
        name: "external_channel_binding_challenges_binding_account_fk",
        columns: [table.bindingId, table.accountId],
        foreignColumns: [externalChannelBindings.id, externalChannelBindings.accountId]
      }).onDelete("cascade"),
      uniqueIndex("external_channel_binding_challenges_code_hash_unique").on(
        table.pairingCodeHash
      ),
      index("external_channel_binding_challenges_binding_expiry_idx").on(
        table.bindingId,
        table.expiresAt
      ),
      index("external_channel_binding_challenges_expiry_idx").on(table.expiresAt),
      check(
        "external_channel_binding_challenges_code_hash_format",
        sql`${table.pairingCodeHash} ~ '^[0-9a-f]{64}$'`
      ),
      check(
        "external_channel_binding_challenges_valid_window",
        sql`${table.expiresAt} > ${table.issuedAt} AND ${table.expiresAt} <= ${table.issuedAt} + interval '15 minutes'`
      ),
      check(
        "external_channel_binding_challenges_terminal_shape",
        sql`NOT (${table.consumedAt} IS NOT NULL AND ${table.revokedAt} IS NOT NULL) AND (${table.consumedAt} IS NULL OR (${table.consumedAt} >= ${table.issuedAt} AND ${table.consumedAt} < ${table.expiresAt})) AND (${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.issuedAt})`
      ),
      pgPolicy("external_channel_binding_challenges_owner_access", {
        as: "permissive",
        for: "all",
        to: "attention_web_runtime",
        using: ownerPredicate,
        withCheck: ownerPredicate
      })
    ];
  }
).enableRLS();

export const channelIdentities = pgTable(
  "channel_identities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: channelProviderEnum("provider").notNull(),
    appId: varchar("app_id", { length: 128 }).notNull(),
    subjectIdHash: char("subject_id_hash", { length: 64 }).notNull(),
    unionSubjectIdHash: char("union_subject_id_hash", { length: 64 }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    boundAt: timestamp("bound_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("channel_identities_provider_subject_unique").on(
      table.provider,
      table.appId,
      table.subjectIdHash
    ),
    index("channel_identities_account_idx").on(table.accountId, table.revokedAt)
  ]
);

export const channelPendingRequests = pgTable(
  "channel_pending_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: channelProviderEnum("provider").notNull(),
    appId: varchar("app_id", { length: 128 }).notNull(),
    subjectIdHash: char("subject_id_hash", { length: 64 }).notNull(),
    channelMessageId: varchar("channel_message_id", { length: 255 }).notNull(),
    encryptedPayload: text("encrypted_payload").notNull(),
    encryptedResult: text("encrypted_result"),
    processingErrorCode: varchar("processing_error_code", { length: 100 }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("channel_pending_requests_message_unique").on(
      table.provider,
      table.appId,
      table.channelMessageId
    ),
    index("channel_pending_requests_expiry_idx").on(table.expiresAt),
    check(
      "channel_pending_requests_expire_after_creation",
      sql`${table.expiresAt} > ${table.createdAt}`
    )
  ]
);

export const bindIntents = pgTable(
  "bind_intents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tokenHash: char("token_hash", { length: 64 }).notNull(),
    provider: channelProviderEnum("provider").notNull(),
    appId: varchar("app_id", { length: 128 }).notNull(),
    subjectIdHash: char("subject_id_hash", { length: 64 }).notNull(),
    pendingRequestId: uuid("pending_request_id").references(() => channelPendingRequests.id, {
      onDelete: "set null"
    }),
    status: bindIntentStatusEnum("status").default("pending").notNull(),
    confirmedAccountId: uuid("confirmed_account_id").references(() => accounts.id, {
      onDelete: "set null"
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("bind_intents_token_hash_unique").on(table.tokenHash),
    index("bind_intents_pending_request_idx").on(table.pendingRequestId),
    check("bind_intents_expire_after_creation", sql`${table.expiresAt} > ${table.createdAt}`)
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
    aiTags: jsonb("ai_tags").$type<string[]>().default(sql`'[]'::jsonb`).notNull(),
    summaryStatus: summaryStatusEnum("summary_status").default("pending").notNull(),
    enrichmentStatus: enrichmentStatusEnum("enrichment_status").default("pending").notNull(),
    publicSafetyStatus: safetyStatusEnum("public_safety_status").default("allowed").notNull(),
    takedownStatus: takedownStatusEnum("takedown_status").default("none").notNull(),
    communityModerationStatus: communityModerationStatusEnum("community_moderation_status")
      .default("clear")
      .notNull(),
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
      }),
      pgPolicy("collections_worker_read", {
        as: "permissive",
        for: "select",
        to: "attention_worker_runtime",
        using: sql`true`
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

export const accountDigestPreferences = pgTable(
  "account_digest_preferences",
  {
    accountId: uuid("account_id")
      .primaryKey()
      .references(() => accounts.id, { onDelete: "cascade" }),
    timezone: varchar("timezone", { length: 64 }).default("Asia/Shanghai").notNull(),
    sendWindowStartMinute: smallint("send_window_start_minute").default(480).notNull(),
    sendWindowMinutes: smallint("send_window_minutes").default(60).notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    ...timestampColumns()
  },
  (table) => {
    const ownerPredicate = sql`${table.accountId} = NULLIF(current_setting('app.account_id', true), '')::uuid`;
    return [
      check("account_digest_preferences_timezone_not_blank", sql`btrim(${table.timezone}) <> ''`),
      check(
        "account_digest_preferences_window_start_range",
        sql`${table.sendWindowStartMinute} BETWEEN 0 AND 1439`
      ),
      check(
        "account_digest_preferences_window_minutes_range",
        sql`${table.sendWindowMinutes} BETWEEN 15 AND 240`
      ),
      check(
        "account_digest_preferences_window_same_day",
        sql`${table.sendWindowStartMinute} + ${table.sendWindowMinutes} <= 1440`
      ),
      pgPolicy("account_digest_preferences_owner_access", {
        as: "permissive",
        for: "all",
        to: "attention_web_runtime",
        using: ownerPredicate,
        withCheck: ownerPredicate
      }),
      pgPolicy("account_digest_preferences_worker_read", {
        as: "permissive",
        for: "select",
        to: "attention_worker_runtime",
        using: sql`true`
      })
    ];
  }
).enableRLS();

export const domainDigestSubscriptions = pgTable(
  "domain_digest_subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    domainId: uuid("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "restrict" }),
    active: boolean("active").default(true).notNull(),
    ...timestampColumns()
  },
  (table) => {
    const ownerPredicate = sql`${table.accountId} = NULLIF(current_setting('app.account_id', true), '')::uuid`;
    return [
      uniqueIndex("domain_digest_subscriptions_account_domain_unique").on(
        table.accountId,
        table.domainId
      ),
      index("domain_digest_subscriptions_due_idx").on(table.active, table.domainId),
      pgPolicy("domain_digest_subscriptions_owner_access", {
        as: "permissive",
        for: "all",
        to: "attention_web_runtime",
        using: ownerPredicate,
        withCheck: ownerPredicate
      }),
      pgPolicy("domain_digest_subscriptions_worker_read", {
        as: "permissive",
        for: "select",
        to: "attention_worker_runtime",
        using: sql`true`
      })
    ];
  }
).enableRLS();

export const digestEmailDeliveries = pgTable(
  "digest_email_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    domainId: uuid("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "restrict" }),
    localDate: date("local_date", { mode: "string" }).notNull(),
    timezone: varchar("timezone", { length: 64 }).notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    recipientEmail: varchar("recipient_email", { length: 320 }).notNull(),
    status: digestDeliveryStatusEnum("status").default("pending").notNull(),
    attempts: smallint("attempts").default(0).notNull(),
    maxAttempts: smallint("max_attempts").default(8).notNull(),
    availableAt: timestamp("available_at", { withTimezone: true }).defaultNow().notNull(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: varchar("locked_by", { length: 100 }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    providerMessageId: varchar("provider_message_id", { length: 255 }),
    skippedReason: varchar("skipped_reason", { length: 100 }),
    lastErrorCode: varchar("last_error_code", { length: 100 }),
    ...timestampColumns()
  },
  (table) => [
    uniqueIndex("digest_email_deliveries_account_domain_date_unique").on(
      table.accountId,
      table.domainId,
      table.localDate
    ),
    index("digest_email_deliveries_available_idx").on(table.status, table.availableAt),
    check("digest_email_deliveries_window_order", sql`${table.windowEnd} > ${table.windowStart}`),
    check("digest_email_deliveries_attempts_range", sql`${table.attempts} >= 0 AND ${table.attempts} <= ${table.maxAttempts}`),
    check("digest_email_deliveries_max_attempts_positive", sql`${table.maxAttempts} > 0`),
    check(
      "digest_email_deliveries_lock_shape",
      sql`(${table.lockedAt} IS NULL AND ${table.lockedBy} IS NULL) OR (${table.lockedAt} IS NOT NULL AND ${table.lockedBy} IS NOT NULL)`
    ),
    check(
      "digest_email_deliveries_sent_shape",
      sql`(${table.status} = 'sent' AND ${table.sentAt} IS NOT NULL) OR (${table.status} <> 'sent' AND ${table.sentAt} IS NULL)`
    ),
    pgPolicy("digest_email_deliveries_worker_access", {
      as: "permissive",
      for: "all",
      to: "attention_worker_runtime",
      using: sql`true`,
      withCheck: sql`true`
    })
  ]
).enableRLS();

export const digestEmailDeliveryItems = pgTable(
  "digest_email_delivery_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    deliveryId: uuid("delivery_id")
      .notNull()
      .references(() => digestEmailDeliveries.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    domainId: uuid("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "restrict" }),
    contentId: uuid("content_id")
      .notNull()
      .references(() => contents.id, { onDelete: "restrict" }),
    visibilityVersion: integer("visibility_version").notNull(),
    ordinal: smallint("ordinal").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("digest_email_delivery_items_delivery_content_unique").on(
      table.deliveryId,
      table.contentId
    ),
    uniqueIndex("digest_email_delivery_items_account_content_unique").on(
      table.accountId,
      table.contentId
    ),
    index("digest_email_delivery_items_delivery_order_idx").on(table.deliveryId, table.ordinal),
    check("digest_email_delivery_items_visibility_version_nonnegative", sql`${table.visibilityVersion} >= 0`),
    check("digest_email_delivery_items_ordinal_nonnegative", sql`${table.ordinal} >= 0`),
    pgPolicy("digest_email_delivery_items_worker_access", {
      as: "permissive",
      for: "all",
      to: "attention_worker_runtime",
      using: sql`true`,
      withCheck: sql`true`
    })
  ]
).enableRLS();

export const contentReports = pgTable(
  "content_reports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contentId: uuid("content_id")
      .notNull()
      .references(() => contents.id, { onDelete: "restrict" }),
    reporterAccountId: uuid("reporter_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    reporterKind: contentReporterKindEnum("reporter_kind").notNull(),
    reasonCode: varchar("reason_code", { length: 64 }).notNull(),
    details: text("details"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => {
    const ownerPredicate = sql`${table.reporterAccountId} = NULLIF(current_setting('app.account_id', true), '')::uuid`;
    return [
      uniqueIndex("content_reports_content_reporter_unique").on(
        table.contentId,
        table.reporterAccountId
      ),
      index("content_reports_content_created_idx").on(table.contentId, table.createdAt),
      index("content_reports_reporter_created_idx").on(
        table.reporterAccountId,
        table.createdAt,
      ),
      check("content_reports_reason_not_blank", sql`btrim(${table.reasonCode}) <> ''`),
      check(
        "content_reports_details_length",
        sql`${table.details} IS NULL OR char_length(${table.details}) <= 2000`
      ),
      pgPolicy("content_reports_web_read", {
        as: "permissive",
        for: "select",
        to: "attention_web_runtime",
        using: sql`true`
      }),
      pgPolicy("content_reports_web_insert", {
        as: "permissive",
        for: "insert",
        to: "attention_web_runtime",
        withCheck: ownerPredicate
      })
    ];
  }
).enableRLS();

export const moderationCases = pgTable(
  "moderation_cases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contentId: uuid("content_id")
      .notNull()
      .references(() => contents.id, { onDelete: "restrict" }),
    openedByReportId: uuid("opened_by_report_id")
      .notNull()
      .references(() => contentReports.id, { onDelete: "restrict" }),
    status: moderationCaseStatusEnum("status").default("open").notNull(),
    resolution: moderationCaseResolutionEnum("resolution"),
    openedAt: timestamp("opened_at", { withTimezone: true }).defaultNow().notNull(),
    votingEndsAt: timestamp("voting_ends_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    consumerReportCountAtOpen: smallint("consumer_report_count_at_open").notNull(),
    hasFilterReportAtOpen: boolean("has_filter_report_at_open").notNull(),
    eligibleFilterCountAtResolution: smallint("eligible_filter_count_at_resolution"),
    publicVotesAtResolution: smallint("public_votes_at_resolution"),
    hiddenVotesAtResolution: smallint("hidden_votes_at_resolution"),
    visibilityVersionAtOpen: integer("visibility_version_at_open").notNull(),
    visibilityVersionAtResolution: integer("visibility_version_at_resolution"),
    ...timestampColumns()
  },
  (table) => [
    uniqueIndex("moderation_cases_active_content_unique")
      .on(table.contentId)
      .where(sql`${table.status} IN ('open', 'requires_admin')`),
    index("moderation_cases_opening_report_time_idx").on(
      table.openedByReportId,
      table.openedAt,
    ),
    index("moderation_cases_status_deadline_idx").on(table.status, table.votingEndsAt),
    check(
      "moderation_cases_voting_window_minimum",
      sql`${table.votingEndsAt} >= ${table.openedAt} + interval '24 hours'`
    ),
    check(
      "moderation_cases_open_counts_nonnegative",
      sql`${table.consumerReportCountAtOpen} >= 0 AND ${table.visibilityVersionAtOpen} >= 0`
    ),
    check(
      "moderation_cases_resolution_counts_nonnegative",
      sql`(${table.eligibleFilterCountAtResolution} IS NULL OR ${table.eligibleFilterCountAtResolution} >= 0) AND (${table.publicVotesAtResolution} IS NULL OR ${table.publicVotesAtResolution} >= 0) AND (${table.hiddenVotesAtResolution} IS NULL OR ${table.hiddenVotesAtResolution} >= 0) AND (${table.visibilityVersionAtResolution} IS NULL OR ${table.visibilityVersionAtResolution} >= 0)`
    ),
    check(
      "moderation_cases_resolution_shape",
      sql`(${table.status} = 'open' AND ${table.resolution} IS NULL AND ${table.resolvedAt} IS NULL AND ${table.eligibleFilterCountAtResolution} IS NULL AND ${table.publicVotesAtResolution} IS NULL AND ${table.hiddenVotesAtResolution} IS NULL AND ${table.visibilityVersionAtResolution} IS NULL) OR (${table.status} = 'resolved' AND ${table.resolution} IN ('public', 'hidden') AND ${table.resolvedAt} IS NOT NULL AND ${table.eligibleFilterCountAtResolution} IS NOT NULL AND ${table.publicVotesAtResolution} IS NOT NULL AND ${table.hiddenVotesAtResolution} IS NOT NULL AND ${table.visibilityVersionAtResolution} IS NOT NULL) OR (${table.status} = 'requires_admin' AND ${table.resolution} = 'requires_admin' AND ${table.resolvedAt} IS NOT NULL AND ${table.eligibleFilterCountAtResolution} IS NOT NULL AND ${table.publicVotesAtResolution} IS NOT NULL AND ${table.hiddenVotesAtResolution} IS NOT NULL AND ${table.visibilityVersionAtResolution} IS NOT NULL)`
    ),
    pgPolicy("moderation_cases_web_access", {
      as: "permissive",
      for: "all",
      to: "attention_web_runtime",
      using: sql`true`,
      withCheck: sql`true`
    }),
    pgPolicy("moderation_cases_worker_access", {
      as: "permissive",
      for: "all",
      to: "attention_worker_runtime",
      using: sql`true`,
      withCheck: sql`true`
    })
  ]
).enableRLS();

export const moderationVotes = pgTable(
  "moderation_votes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => moderationCases.id, { onDelete: "restrict" }),
    filterAccountId: uuid("filter_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    decision: moderationDecisionEnum("decision").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => {
    const ownerPredicate = sql`${table.filterAccountId} = NULLIF(current_setting('app.account_id', true), '')::uuid`;
    return [
      uniqueIndex("moderation_votes_case_filter_unique").on(
        table.caseId,
        table.filterAccountId
      ),
      index("moderation_votes_case_created_idx").on(table.caseId, table.createdAt),
      pgPolicy("moderation_votes_web_read", {
        as: "permissive",
        for: "select",
        to: "attention_web_runtime",
        using: sql`true`
      }),
      pgPolicy("moderation_votes_web_insert", {
        as: "permissive",
        for: "insert",
        to: "attention_web_runtime",
        withCheck: ownerPredicate
      }),
      pgPolicy("moderation_votes_worker_read", {
        as: "permissive",
        for: "select",
        to: "attention_worker_runtime",
        using: sql`true`
      })
    ];
  }
).enableRLS();

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
    index("event_ledger_account_time_idx").on(table.accountId, table.occurredAt),
    pgPolicy("event_ledger_web_tool_audit_insert", {
      as: "permissive",
      for: "insert",
      to: "attention_web_runtime",
      withCheck: sql`${table.accountId} = NULLIF(current_setting('app.account_id', true), '')::uuid AND ${table.eventType} = 'agent.tool_call.v1' AND ${table.scope} = 'private' AND ${table.contentId} IS NULL AND ${table.anonymousSessionId} IS NULL AND ${table.requestId} IS NOT NULL AND ${table.dedupeKey} IS NULL`
    }),
    pgPolicy("event_ledger_web_mcp_retrieval_insert", {
      as: "permissive",
      for: "insert",
      to: "attention_web_runtime",
      withCheck: sql`${table.accountId} = NULLIF(current_setting('app.account_id', true), '')::uuid AND ${table.eventType} = 'mcp_retrieval' AND ${table.scope} = 'public' AND ${table.contentId} IS NOT NULL AND ${table.anonymousSessionId} IS NULL AND ${table.requestId} IS NOT NULL AND ${table.dedupeKey} IS NOT NULL AND EXISTS (SELECT 1 FROM public_contents_current AS visible_content WHERE visible_content.id = ${table.contentId})`
    }),
    pgPolicy("event_ledger_web_runtime_lifecycle_insert", {
      as: "permissive",
      for: "insert",
      to: "attention_web_runtime",
      withCheck: sql`${table.accountId} = NULLIF(current_setting('app.account_id', true), '')::uuid AND ${table.eventType} IN ('agent.installation.registered.v1', 'agent.installation.heartbeat.v1', 'agent.installation.revoked.v1', 'channel.binding.reported.v1', 'channel.binding.verified.v1', 'channel.binding.activity.v1', 'channel.binding.disconnected.v1') AND ${table.scope} = 'private' AND ${table.contentId} IS NULL AND ${table.anonymousSessionId} IS NULL AND ${table.requestId} IS NOT NULL`
    }),
    pgPolicy("event_ledger_web_runtime_lifecycle_replay_read", {
      as: "permissive",
      for: "select",
      to: "attention_web_runtime",
      using: sql`${table.accountId} = NULLIF(current_setting('app.account_id', true), '')::uuid AND ${table.eventType} IN ('agent.installation.registered.v1', 'agent.installation.heartbeat.v1', 'agent.installation.revoked.v1', 'channel.binding.reported.v1', 'channel.binding.verified.v1', 'channel.binding.activity.v1', 'channel.binding.disconnected.v1') AND ${table.scope} = 'private' AND ${table.contentId} IS NULL AND ${table.anonymousSessionId} IS NULL AND ${table.requestId} IS NOT NULL AND ${table.dedupeKey} IS NOT NULL`
    })
  ]
).enableRLS();

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
  aiTags: jsonb("ai_tags").$type<string[]>().notNull(),
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
      c.ai_tags,
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
      AND c.community_moderation_status = 'clear'
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
    stableHandle: varchar("stable_handle", { length: 64 }).notNull(),
    attentionId: varchar("attention_id", { length: 20 })
  }
)
  .with({ securityBarrier: true })
  .as(sql`
    SELECT
      col.content_id,
      a.stable_handle,
      fp.display_name,
      fp.avatar_url,
      a.attention_id
    FROM collections col
    JOIN public_contents_current pc ON pc.id = col.content_id
    JOIN filter_profiles fp ON fp.account_id = col.account_id
    JOIN accounts a ON a.id = col.account_id
    JOIN domains d ON d.id = col.domain_id
    WHERE col.collection_status = 'active'
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
