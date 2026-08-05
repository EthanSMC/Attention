CREATE TYPE "public"."digest_delivery_status" AS ENUM('pending', 'sending', 'sent', 'skipped', 'failed');--> statement-breakpoint
CREATE TABLE "account_digest_preferences" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"timezone" varchar(64) DEFAULT 'Asia/Shanghai' NOT NULL,
	"send_window_start_minute" smallint DEFAULT 480 NOT NULL,
	"send_window_minutes" smallint DEFAULT 60 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_digest_preferences_timezone_not_blank" CHECK (btrim("account_digest_preferences"."timezone") <> ''),
	CONSTRAINT "account_digest_preferences_window_start_range" CHECK ("account_digest_preferences"."send_window_start_minute" BETWEEN 0 AND 1439),
	CONSTRAINT "account_digest_preferences_window_minutes_range" CHECK ("account_digest_preferences"."send_window_minutes" BETWEEN 15 AND 240),
	CONSTRAINT "account_digest_preferences_window_same_day" CHECK ("account_digest_preferences"."send_window_start_minute" + "account_digest_preferences"."send_window_minutes" <= 1440)
);
--> statement-breakpoint
ALTER TABLE "account_digest_preferences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "digest_email_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"domain_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"timezone" varchar(64) NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"recipient_email" varchar(320) NOT NULL,
	"status" "digest_delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"max_attempts" smallint DEFAULT 8 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" varchar(100),
	"sent_at" timestamp with time zone,
	"provider_message_id" varchar(255),
	"skipped_reason" varchar(100),
	"last_error_code" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "digest_email_deliveries_window_order" CHECK ("digest_email_deliveries"."window_end" > "digest_email_deliveries"."window_start"),
	CONSTRAINT "digest_email_deliveries_attempts_range" CHECK ("digest_email_deliveries"."attempts" >= 0 AND "digest_email_deliveries"."attempts" <= "digest_email_deliveries"."max_attempts"),
	CONSTRAINT "digest_email_deliveries_max_attempts_positive" CHECK ("digest_email_deliveries"."max_attempts" > 0),
	CONSTRAINT "digest_email_deliveries_lock_shape" CHECK (("digest_email_deliveries"."locked_at" IS NULL AND "digest_email_deliveries"."locked_by" IS NULL) OR ("digest_email_deliveries"."locked_at" IS NOT NULL AND "digest_email_deliveries"."locked_by" IS NOT NULL)),
	CONSTRAINT "digest_email_deliveries_sent_shape" CHECK (("digest_email_deliveries"."status" = 'sent' AND "digest_email_deliveries"."sent_at" IS NOT NULL) OR ("digest_email_deliveries"."status" <> 'sent' AND "digest_email_deliveries"."sent_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "digest_email_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "digest_email_delivery_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"domain_id" uuid NOT NULL,
	"content_id" uuid NOT NULL,
	"visibility_version" integer NOT NULL,
	"ordinal" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "digest_email_delivery_items_visibility_version_nonnegative" CHECK ("digest_email_delivery_items"."visibility_version" >= 0),
	CONSTRAINT "digest_email_delivery_items_ordinal_nonnegative" CHECK ("digest_email_delivery_items"."ordinal" >= 0)
);
--> statement-breakpoint
ALTER TABLE "digest_email_delivery_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "domain_digest_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"domain_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "domain_digest_subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "account_digest_preferences" ADD CONSTRAINT "account_digest_preferences_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_email_deliveries" ADD CONSTRAINT "digest_email_deliveries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_email_deliveries" ADD CONSTRAINT "digest_email_deliveries_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_email_delivery_items" ADD CONSTRAINT "digest_email_delivery_items_delivery_id_digest_email_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."digest_email_deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_email_delivery_items" ADD CONSTRAINT "digest_email_delivery_items_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_email_delivery_items" ADD CONSTRAINT "digest_email_delivery_items_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_email_delivery_items" ADD CONSTRAINT "digest_email_delivery_items_content_id_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."contents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_digest_subscriptions" ADD CONSTRAINT "domain_digest_subscriptions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_digest_subscriptions" ADD CONSTRAINT "domain_digest_subscriptions_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "digest_email_deliveries_account_domain_date_unique" ON "digest_email_deliveries" USING btree ("account_id","domain_id","local_date");--> statement-breakpoint
CREATE INDEX "digest_email_deliveries_available_idx" ON "digest_email_deliveries" USING btree ("status","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "digest_email_delivery_items_delivery_content_unique" ON "digest_email_delivery_items" USING btree ("delivery_id","content_id");--> statement-breakpoint
CREATE UNIQUE INDEX "digest_email_delivery_items_account_content_unique" ON "digest_email_delivery_items" USING btree ("account_id","content_id");--> statement-breakpoint
CREATE INDEX "digest_email_delivery_items_delivery_order_idx" ON "digest_email_delivery_items" USING btree ("delivery_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "domain_digest_subscriptions_account_domain_unique" ON "domain_digest_subscriptions" USING btree ("account_id","domain_id");--> statement-breakpoint
CREATE INDEX "domain_digest_subscriptions_due_idx" ON "domain_digest_subscriptions" USING btree ("active","domain_id");--> statement-breakpoint
CREATE POLICY "account_digest_preferences_owner_access" ON "account_digest_preferences" AS PERMISSIVE FOR ALL TO "attention_web_runtime" USING ("account_digest_preferences"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK ("account_digest_preferences"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "account_digest_preferences_worker_read" ON "account_digest_preferences" AS PERMISSIVE FOR SELECT TO "attention_worker_runtime" USING (true);--> statement-breakpoint
CREATE POLICY "digest_email_deliveries_worker_access" ON "digest_email_deliveries" AS PERMISSIVE FOR ALL TO "attention_worker_runtime" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "digest_email_delivery_items_worker_access" ON "digest_email_delivery_items" AS PERMISSIVE FOR ALL TO "attention_worker_runtime" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "domain_digest_subscriptions_owner_access" ON "domain_digest_subscriptions" AS PERMISSIVE FOR ALL TO "attention_web_runtime" USING ("domain_digest_subscriptions"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK ("domain_digest_subscriptions"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "domain_digest_subscriptions_worker_read" ON "domain_digest_subscriptions" AS PERMISSIVE FOR SELECT TO "attention_worker_runtime" USING (true);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  account_digest_preferences,
  domain_digest_subscriptions
TO attention_web_runtime;--> statement-breakpoint
GRANT SELECT ON TABLE
  accounts,
  domains,
  contents,
  collections,
  filter_profiles,
  entitlements,
  membership_grants,
  subscriptions,
  public_contents_current,
  account_digest_preferences,
  domain_digest_subscriptions
TO attention_worker_runtime;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  digest_email_deliveries,
  digest_email_delivery_items
TO attention_worker_runtime;
