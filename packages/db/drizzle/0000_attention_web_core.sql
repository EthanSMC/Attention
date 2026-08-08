CREATE TYPE "public"."account_status" AS ENUM('invited', 'active', 'suspended', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."canonical_trust_status" AS ENUM('unknown', 'trusted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."collection_status" AS ENUM('active', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."collection_visibility" AS ENUM('public', 'private');--> statement-breakpoint
CREATE TYPE "public"."content_identity_kind" AS ENUM('normalized', 'canonical');--> statement-breakpoint
CREATE TYPE "public"."content_status" AS ENUM('active', 'merged');--> statement-breakpoint
CREATE TYPE "public"."enrichment_status" AS ENUM('pending', 'processing', 'partial', 'complete', 'failed');--> statement-breakpoint
CREATE TYPE "public"."entitlement_source" AS ENUM('signup', 'invite', 'admin_grant', 'filter_grant');--> statement-breakpoint
CREATE TYPE "public"."event_scope" AS ENUM('public', 'private', 'system');--> statement-breakpoint
CREATE TYPE "public"."input_attempt_status" AS ENUM('processing', 'accepted', 'already_collected', 'merged_with_existing_content', 'ambiguous', 'resolution_pending', 'invalid', 'unsafe', 'failed');--> statement-breakpoint
CREATE TYPE "public"."input_channel" AS ENUM('web', 'wechat');--> statement-breakpoint
CREATE TYPE "public"."input_payload_type" AS ENUM('text', 'link_card', 'url');--> statement-breakpoint
CREATE TYPE "public"."invitation_kind" AS ENUM('member', 'filter');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."link_resolution_status" AS ENUM('pending', 'resolved', 'failed');--> statement-breakpoint
CREATE TYPE "public"."moderation_status" AS ENUM('clear', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."safety_status" AS ENUM('allowed', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."summary_status" AS ENUM('pending', 'ready', 'unavailable', 'hidden', 'failed');--> statement-breakpoint
CREATE TYPE "public"."takedown_status" AS ENUM('none', 'removed');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stable_handle" varchar(64) NOT NULL,
	"status" "account_status" DEFAULT 'invited' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_stable_handle_not_blank" CHECK (btrim("accounts"."stable_handle") <> '')
);
--> statement-breakpoint
CREATE TABLE "collection_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"content_id" uuid NOT NULL,
	"event_type" varchar(100) NOT NULL,
	"previous_state" jsonb,
	"next_state" jsonb NOT NULL,
	"actor_account_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"content_id" uuid NOT NULL,
	"domain_id" uuid NOT NULL,
	"visibility" "collection_visibility" NOT NULL,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"public_since" timestamp with time zone,
	"source_channel" "input_channel" NOT NULL,
	"collection_status" "collection_status" DEFAULT 'active' NOT NULL,
	"filter_revoked_at" timestamp with time zone,
	"moderation_status" "moderation_status" DEFAULT 'clear' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collections_visibility_public_since_shape" CHECK (("collections"."visibility" = 'private' AND "collections"."public_since" IS NULL) OR ("collections"."visibility" = 'public' AND "collections"."public_since" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "collections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "content_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alias_content_id" uuid NOT NULL,
	"primary_content_id" uuid NOT NULL,
	"alias_dedupe_key" text NOT NULL,
	"rule_version" varchar(64) NOT NULL,
	"reason_code" varchar(100) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "content_aliases_distinct_contents" CHECK ("content_aliases"."alias_content_id" <> "content_aliases"."primary_content_id"),
	CONSTRAINT "content_aliases_active_shape" CHECK (("content_aliases"."active" AND "content_aliases"."disabled_at" IS NULL) OR (NOT "content_aliases"."active" AND "content_aliases"."disabled_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "content_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_id" uuid NOT NULL,
	"dedupe_key" text NOT NULL,
	"identity_kind" "content_identity_kind" DEFAULT 'normalized' NOT NULL,
	"normalized_url" text NOT NULL,
	"source_adapter" varchar(100) NOT NULL,
	"adapter_version" varchar(64) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_identities_dedupe_key_not_blank" CHECK (btrim("content_identities"."dedupe_key") <> '')
);
--> statement-breakpoint
CREATE TABLE "content_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_id" uuid NOT NULL,
	"input_attempt_id" uuid NOT NULL,
	"safe_selected_url" text NOT NULL,
	"resolved_url" text NOT NULL,
	"normalized_url" text NOT NULL,
	"redirect_chain" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_adapter" varchar(100) NOT NULL,
	"adapter_version" varchar(64) NOT NULL,
	"observed_canonical_url" text,
	"canonical_trust_status" "canonical_trust_status" DEFAULT 'unknown' NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolution_status" "link_resolution_status" DEFAULT 'resolved' NOT NULL,
	"safety_status" "safety_status" DEFAULT 'allowed' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"outbound_url" text NOT NULL,
	"normalized_url" text NOT NULL,
	"canonical_url" text NOT NULL,
	"content_status" "content_status" DEFAULT 'active' NOT NULL,
	"merged_into_content_id" uuid,
	"first_public_at" timestamp with time zone,
	"visibility_version" integer DEFAULT 0 NOT NULL,
	"source" varchar(100) NOT NULL,
	"content_type" varchar(64) DEFAULT 'webpage' NOT NULL,
	"title" text,
	"author" text,
	"published_at" timestamp with time zone,
	"cached_favicon_asset_key" text,
	"ai_summary" text,
	"summary_status" "summary_status" DEFAULT 'pending' NOT NULL,
	"enrichment_status" "enrichment_status" DEFAULT 'pending' NOT NULL,
	"public_safety_status" "safety_status" DEFAULT 'allowed' NOT NULL,
	"takedown_status" "takedown_status" DEFAULT 'none' NOT NULL,
	"restriction_reason_code" varchar(100),
	"restricted_at" timestamp with time zone,
	"restricted_by_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contents_visibility_version_nonnegative" CHECK ("contents"."visibility_version" >= 0),
	CONSTRAINT "contents_merge_shape" CHECK (("contents"."content_status" = 'active' AND "contents"."merged_into_content_id" IS NULL) OR ("contents"."content_status" = 'merged' AND "contents"."merged_into_content_id" IS NOT NULL)),
	CONSTRAINT "contents_restriction_shape" CHECK (("contents"."public_safety_status" = 'allowed' AND "contents"."takedown_status" = 'none' AND "contents"."restricted_at" IS NULL AND "contents"."restriction_reason_code" IS NULL) OR ("contents"."public_safety_status" = 'blocked' OR "contents"."takedown_status" = 'removed'))
);
--> statement-breakpoint
CREATE TABLE "domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(64) NOT NULL,
	"name" varchar(100) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domains_slug_not_blank" CHECK (btrim("domains"."slug") <> '')
);
--> statement-breakpoint
CREATE TABLE "entitlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"member_enabled" boolean DEFAULT true NOT NULL,
	"source" "entitlement_source" NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entitlements_valid_window" CHECK ("entitlements"."ends_at" IS NULL OR "entitlements"."ends_at" > "entitlements"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "event_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" varchar(100) NOT NULL,
	"content_id" uuid,
	"account_id" uuid,
	"anonymous_session_id" varchar(128),
	"request_id" varchar(128),
	"dedupe_key" text,
	"scope" "event_scope" NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "filter_profiles" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"display_name" varchar(100) NOT NULL,
	"avatar_url" text,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"revoked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "filter_profiles_active_revocation_shape" CHECK (("filter_profiles"."active" AND "filter_profiles"."revoked_at" IS NULL) OR (NOT "filter_profiles"."active"))
);
--> statement-breakpoint
CREATE TABLE "input_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" "input_channel" NOT NULL,
	"account_id" uuid NOT NULL,
	"channel_message_id" varchar(128) NOT NULL,
	"payload_type" "input_payload_type" NOT NULL,
	"input_hmac" char(64) NOT NULL,
	"parser_version" varchar(64) NOT NULL,
	"candidate_count" smallint DEFAULT 0 NOT NULL,
	"safe_selected_url" text,
	"unsafe_candidate_fingerprint" char(64),
	"redirect_chain" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"selection_token_hash" char(64),
	"selection_expires_at" timestamp with time zone,
	"selection_consumed_at" timestamp with time zone,
	"source_adapter" varchar(100),
	"status" "input_attempt_status" DEFAULT 'processing' NOT NULL,
	"error_code" varchar(100),
	"lease_owner" varchar(100),
	"lease_expires_at" timestamp with time zone,
	"result_content_id" uuid,
	"result_collection_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "input_attempts_candidate_count_range" CHECK ("input_attempts"."candidate_count" BETWEEN 0 AND 16),
	CONSTRAINT "input_attempts_selection_shape" CHECK (("input_attempts"."selection_token_hash" IS NULL AND "input_attempts"."selection_expires_at" IS NULL) OR ("input_attempts"."selection_token_hash" IS NOT NULL AND "input_attempts"."selection_expires_at" IS NOT NULL)),
	CONSTRAINT "input_attempts_lease_shape" CHECK (("input_attempts"."lease_owner" IS NULL AND "input_attempts"."lease_expires_at" IS NULL) OR ("input_attempts"."lease_owner" IS NOT NULL AND "input_attempts"."lease_expires_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "input_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"input_attempt_id" uuid NOT NULL,
	"ordinal" smallint NOT NULL,
	"url_fingerprint" char(64) NOT NULL,
	"display_host" varchar(255) NOT NULL,
	"source_adapter" varchar(100),
	"confidence" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "input_candidates_ordinal_range" CHECK ("input_candidates"."ordinal" BETWEEN 0 AND 15),
	CONSTRAINT "input_candidates_confidence_range" CHECK ("input_candidates"."confidence" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" char(64) NOT NULL,
	"kind" "invitation_kind" NOT NULL,
	"account_id" uuid NOT NULL,
	"created_by_account_id" uuid,
	"filter_display_name" varchar(100),
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_by_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_expire_after_creation" CHECK ("invitations"."expires_at" > "invitations"."created_at"),
	CONSTRAINT "invitations_consumption_shape" CHECK (("invitations"."consumed_at" IS NULL AND "invitations"."consumed_by_account_id" IS NULL) OR ("invitations"."consumed_at" IS NOT NULL AND "invitations"."consumed_by_account_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"queue" varchar(100) DEFAULT 'default' NOT NULL,
	"task_type" varchar(100) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"idempotency_key" text,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"max_attempts" smallint DEFAULT 8 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" varchar(100),
	"completed_at" timestamp with time zone,
	"last_error_code" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_attempts_range" CHECK ("jobs"."attempts" >= 0 AND "jobs"."attempts" <= "jobs"."max_attempts"),
	CONSTRAINT "jobs_max_attempts_positive" CHECK ("jobs"."max_attempts" > 0),
	CONSTRAINT "jobs_lock_shape" CHECK (("jobs"."locked_at" IS NULL AND "jobs"."locked_by" IS NULL) OR ("jobs"."locked_at" IS NOT NULL AND "jobs"."locked_by" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "pending_candidate_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"input_attempt_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"token_hash" char(64) NOT NULL,
	"encrypted_payload" text NOT NULL,
	"candidate_count" smallint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pending_candidate_sets_candidate_count_range" CHECK ("pending_candidate_sets"."candidate_count" BETWEEN 2 AND 16),
	CONSTRAINT "pending_candidate_sets_expire_after_creation" CHECK ("pending_candidate_sets"."expires_at" > "pending_candidate_sets"."created_at")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"token_hash" char(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_expire_after_creation" CHECK ("sessions"."expires_at" > "sessions"."created_at"),
	CONSTRAINT "sessions_revoked_after_creation" CHECK ("sessions"."revoked_at" IS NULL OR "sessions"."revoked_at" >= "sessions"."created_at")
);
--> statement-breakpoint
ALTER TABLE "collection_events" ADD CONSTRAINT "collection_events_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_events" ADD CONSTRAINT "collection_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_events" ADD CONSTRAINT "collection_events_content_id_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."contents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_events" ADD CONSTRAINT "collection_events_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_content_id_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."contents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_aliases" ADD CONSTRAINT "content_aliases_alias_content_id_contents_id_fk" FOREIGN KEY ("alias_content_id") REFERENCES "public"."contents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_aliases" ADD CONSTRAINT "content_aliases_primary_content_id_contents_id_fk" FOREIGN KEY ("primary_content_id") REFERENCES "public"."contents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_identities" ADD CONSTRAINT "content_identities_content_id_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."contents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_links" ADD CONSTRAINT "content_links_content_id_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."contents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_links" ADD CONSTRAINT "content_links_input_attempt_id_input_attempts_id_fk" FOREIGN KEY ("input_attempt_id") REFERENCES "public"."input_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contents" ADD CONSTRAINT "contents_merged_into_content_id_contents_id_fk" FOREIGN KEY ("merged_into_content_id") REFERENCES "public"."contents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contents" ADD CONSTRAINT "contents_restricted_by_account_id_accounts_id_fk" FOREIGN KEY ("restricted_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_ledger" ADD CONSTRAINT "event_ledger_content_id_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."contents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_ledger" ADD CONSTRAINT "event_ledger_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filter_profiles" ADD CONSTRAINT "filter_profiles_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "input_attempts" ADD CONSTRAINT "input_attempts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "input_attempts" ADD CONSTRAINT "input_attempts_result_content_id_contents_id_fk" FOREIGN KEY ("result_content_id") REFERENCES "public"."contents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "input_attempts" ADD CONSTRAINT "input_attempts_result_collection_id_collections_id_fk" FOREIGN KEY ("result_collection_id") REFERENCES "public"."collections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "input_candidates" ADD CONSTRAINT "input_candidates_input_attempt_id_input_attempts_id_fk" FOREIGN KEY ("input_attempt_id") REFERENCES "public"."input_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_created_by_account_id_accounts_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_consumed_by_account_id_accounts_id_fk" FOREIGN KEY ("consumed_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_candidate_sets" ADD CONSTRAINT "pending_candidate_sets_input_attempt_id_input_attempts_id_fk" FOREIGN KEY ("input_attempt_id") REFERENCES "public"."input_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_candidate_sets" ADD CONSTRAINT "pending_candidate_sets_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_stable_handle_unique" ON "accounts" USING btree ("stable_handle");--> statement-breakpoint
CREATE INDEX "collection_events_collection_time_idx" ON "collection_events" USING btree ("collection_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "collections_account_content_unique" ON "collections" USING btree ("account_id","content_id");--> statement-breakpoint
CREATE INDEX "collections_public_lookup_idx" ON "collections" USING btree ("content_id","collection_status","visibility","moderation_status");--> statement-breakpoint
CREATE INDEX "collections_account_collected_idx" ON "collections" USING btree ("account_id","collected_at");--> statement-breakpoint
CREATE UNIQUE INDEX "content_aliases_alias_content_unique" ON "content_aliases" USING btree ("alias_content_id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_aliases_dedupe_key_unique" ON "content_aliases" USING btree ("alias_dedupe_key");--> statement-breakpoint
CREATE INDEX "content_aliases_primary_idx" ON "content_aliases" USING btree ("primary_content_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "content_identities_dedupe_key_unique" ON "content_identities" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "content_identities_content_idx" ON "content_identities" USING btree ("content_id","active");--> statement-breakpoint
CREATE INDEX "content_links_content_idx" ON "content_links" USING btree ("content_id","observed_at");--> statement-breakpoint
CREATE INDEX "content_links_attempt_idx" ON "content_links" USING btree ("input_attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contents_public_id_unique" ON "contents" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "contents_public_order_idx" ON "contents" USING btree ("first_public_at");--> statement-breakpoint
CREATE UNIQUE INDEX "domains_slug_unique" ON "domains" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "entitlements_account_source_unique" ON "entitlements" USING btree ("account_id","source");--> statement-breakpoint
CREATE INDEX "entitlements_active_lookup_idx" ON "entitlements" USING btree ("account_id","member_enabled","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "event_ledger_dedupe_key_unique" ON "event_ledger" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "event_ledger_content_time_idx" ON "event_ledger" USING btree ("content_id","occurred_at");--> statement-breakpoint
CREATE INDEX "event_ledger_account_time_idx" ON "event_ledger" USING btree ("account_id","occurred_at");--> statement-breakpoint
CREATE INDEX "filter_profiles_active_idx" ON "filter_profiles" USING btree ("active","invited_at");--> statement-breakpoint
CREATE UNIQUE INDEX "input_attempts_channel_message_unique" ON "input_attempts" USING btree ("channel","account_id","channel_message_id");--> statement-breakpoint
CREATE INDEX "input_attempts_account_received_idx" ON "input_attempts" USING btree ("account_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "input_candidates_attempt_ordinal_unique" ON "input_candidates" USING btree ("input_attempt_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_token_hash_unique" ON "invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "invitations_account_idx" ON "invitations" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_idempotency_key_unique" ON "jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "jobs_available_idx" ON "jobs" USING btree ("queue","status","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pending_candidate_sets_attempt_unique" ON "pending_candidate_sets" USING btree ("input_attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pending_candidate_sets_token_hash_unique" ON "pending_candidate_sets" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "pending_candidate_sets_expiry_idx" ON "pending_candidate_sets" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_unique" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_account_active_idx" ON "sessions" USING btree ("account_id","expires_at");--> statement-breakpoint
CREATE VIEW "public"."public_contents_current" WITH (security_barrier = true) AS (
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
  );--> statement-breakpoint
CREATE POLICY "collections_owner_access" ON "collections" AS PERMISSIVE FOR ALL TO public USING ("collections"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK ("collections"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid);--> statement-breakpoint
INSERT INTO "domains" ("id", "slug", "name", "active")
VALUES ('00000000-0000-4000-8000-000000000001', 'ai', 'AI', true)
ON CONFLICT ("slug") DO NOTHING;
