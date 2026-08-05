CREATE TYPE "public"."community_moderation_status" AS ENUM('clear', 'pending_review', 'hidden');--> statement-breakpoint
CREATE TYPE "public"."content_reporter_kind" AS ENUM('consumer', 'filter');--> statement-breakpoint
CREATE TYPE "public"."moderation_case_resolution" AS ENUM('public', 'hidden', 'requires_admin');--> statement-breakpoint
CREATE TYPE "public"."moderation_case_status" AS ENUM('open', 'resolved', 'requires_admin');--> statement-breakpoint
CREATE TYPE "public"."moderation_decision" AS ENUM('public', 'hidden');--> statement-breakpoint
CREATE TABLE "content_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_id" uuid NOT NULL,
	"reporter_account_id" uuid NOT NULL,
	"reporter_kind" "content_reporter_kind" NOT NULL,
	"reason_code" varchar(64) NOT NULL,
	"details" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_reports_reason_not_blank" CHECK (btrim("content_reports"."reason_code") <> ''),
	CONSTRAINT "content_reports_details_length" CHECK ("content_reports"."details" IS NULL OR char_length("content_reports"."details") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "content_reports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "moderation_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_id" uuid NOT NULL,
	"opened_by_report_id" uuid NOT NULL,
	"status" "moderation_case_status" DEFAULT 'open' NOT NULL,
	"resolution" "moderation_case_resolution",
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voting_ends_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"consumer_report_count_at_open" smallint NOT NULL,
	"has_filter_report_at_open" boolean NOT NULL,
	"eligible_filter_count_at_resolution" smallint,
	"public_votes_at_resolution" smallint,
	"hidden_votes_at_resolution" smallint,
	"visibility_version_at_open" integer NOT NULL,
	"visibility_version_at_resolution" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_cases_voting_window_minimum" CHECK ("moderation_cases"."voting_ends_at" >= "moderation_cases"."opened_at" + interval '24 hours'),
	CONSTRAINT "moderation_cases_open_counts_nonnegative" CHECK ("moderation_cases"."consumer_report_count_at_open" >= 0 AND "moderation_cases"."visibility_version_at_open" >= 0),
	CONSTRAINT "moderation_cases_resolution_counts_nonnegative" CHECK (("moderation_cases"."eligible_filter_count_at_resolution" IS NULL OR "moderation_cases"."eligible_filter_count_at_resolution" >= 0) AND ("moderation_cases"."public_votes_at_resolution" IS NULL OR "moderation_cases"."public_votes_at_resolution" >= 0) AND ("moderation_cases"."hidden_votes_at_resolution" IS NULL OR "moderation_cases"."hidden_votes_at_resolution" >= 0) AND ("moderation_cases"."visibility_version_at_resolution" IS NULL OR "moderation_cases"."visibility_version_at_resolution" >= 0)),
	CONSTRAINT "moderation_cases_resolution_shape" CHECK (("moderation_cases"."status" = 'open' AND "moderation_cases"."resolution" IS NULL AND "moderation_cases"."resolved_at" IS NULL AND "moderation_cases"."eligible_filter_count_at_resolution" IS NULL AND "moderation_cases"."public_votes_at_resolution" IS NULL AND "moderation_cases"."hidden_votes_at_resolution" IS NULL AND "moderation_cases"."visibility_version_at_resolution" IS NULL) OR ("moderation_cases"."status" = 'resolved' AND "moderation_cases"."resolution" IN ('public', 'hidden') AND "moderation_cases"."resolved_at" IS NOT NULL AND "moderation_cases"."eligible_filter_count_at_resolution" IS NOT NULL AND "moderation_cases"."public_votes_at_resolution" IS NOT NULL AND "moderation_cases"."hidden_votes_at_resolution" IS NOT NULL AND "moderation_cases"."visibility_version_at_resolution" IS NOT NULL) OR ("moderation_cases"."status" = 'requires_admin' AND "moderation_cases"."resolution" = 'requires_admin' AND "moderation_cases"."resolved_at" IS NOT NULL AND "moderation_cases"."eligible_filter_count_at_resolution" IS NOT NULL AND "moderation_cases"."public_votes_at_resolution" IS NOT NULL AND "moderation_cases"."hidden_votes_at_resolution" IS NOT NULL AND "moderation_cases"."visibility_version_at_resolution" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "moderation_cases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "moderation_votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"filter_account_id" uuid NOT NULL,
	"decision" "moderation_decision" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "moderation_votes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP VIEW "public"."public_content_attributions_current";--> statement-breakpoint
DROP VIEW "public"."public_contents_current";--> statement-breakpoint
ALTER TABLE "contents" ADD COLUMN "community_moderation_status" "community_moderation_status" DEFAULT 'clear' NOT NULL;--> statement-breakpoint
ALTER TABLE "content_reports" ADD CONSTRAINT "content_reports_content_id_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."contents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_reports" ADD CONSTRAINT "content_reports_reporter_account_id_accounts_id_fk" FOREIGN KEY ("reporter_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_cases" ADD CONSTRAINT "moderation_cases_content_id_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."contents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_cases" ADD CONSTRAINT "moderation_cases_opened_by_report_id_content_reports_id_fk" FOREIGN KEY ("opened_by_report_id") REFERENCES "public"."content_reports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_votes" ADD CONSTRAINT "moderation_votes_case_id_moderation_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."moderation_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_votes" ADD CONSTRAINT "moderation_votes_filter_account_id_accounts_id_fk" FOREIGN KEY ("filter_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "content_reports_content_reporter_unique" ON "content_reports" USING btree ("content_id","reporter_account_id");--> statement-breakpoint
CREATE INDEX "content_reports_content_created_idx" ON "content_reports" USING btree ("content_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "moderation_cases_active_content_unique" ON "moderation_cases" USING btree ("content_id") WHERE "moderation_cases"."status" IN ('open', 'requires_admin');--> statement-breakpoint
CREATE INDEX "moderation_cases_status_deadline_idx" ON "moderation_cases" USING btree ("status","voting_ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "moderation_votes_case_filter_unique" ON "moderation_votes" USING btree ("case_id","filter_account_id");--> statement-breakpoint
CREATE INDEX "moderation_votes_case_created_idx" ON "moderation_votes" USING btree ("case_id","created_at");--> statement-breakpoint
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
  );--> statement-breakpoint
CREATE VIEW "public"."public_content_attributions_current" WITH (security_barrier = true) AS (
    SELECT
      col.content_id,
      a.stable_handle,
      fp.display_name,
      fp.avatar_url
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
  );--> statement-breakpoint
CREATE POLICY "content_reports_web_read" ON "content_reports" AS PERMISSIVE FOR SELECT TO "attention_web_runtime" USING (true);--> statement-breakpoint
CREATE POLICY "content_reports_web_insert" ON "content_reports" AS PERMISSIVE FOR INSERT TO "attention_web_runtime" WITH CHECK ("content_reports"."reporter_account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "moderation_cases_web_access" ON "moderation_cases" AS PERMISSIVE FOR ALL TO "attention_web_runtime" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "moderation_cases_worker_access" ON "moderation_cases" AS PERMISSIVE FOR ALL TO "attention_worker_runtime" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "moderation_votes_web_read" ON "moderation_votes" AS PERMISSIVE FOR SELECT TO "attention_web_runtime" USING (true);--> statement-breakpoint
CREATE POLICY "moderation_votes_web_insert" ON "moderation_votes" AS PERMISSIVE FOR INSERT TO "attention_web_runtime" WITH CHECK ("moderation_votes"."filter_account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "moderation_votes_worker_read" ON "moderation_votes" AS PERMISSIVE FOR SELECT TO "attention_worker_runtime" USING (true);--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE content_reports TO attention_web_runtime;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE moderation_cases TO attention_web_runtime;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE moderation_votes TO attention_web_runtime;--> statement-breakpoint
GRANT SELECT, UPDATE ON TABLE moderation_cases TO attention_worker_runtime;--> statement-breakpoint
GRANT SELECT ON TABLE moderation_votes TO attention_worker_runtime;--> statement-breakpoint
GRANT SELECT ON TABLE
  public_contents_current,
  public_content_attributions_current
TO attention_web_runtime;--> statement-breakpoint
GRANT SELECT ON TABLE public_contents_current TO attention_worker_runtime;
