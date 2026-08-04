CREATE TYPE "public"."consumer_referral_status" AS ENUM('active', 'redeemed', 'invalidated');--> statement-breakpoint
CREATE TYPE "public"."filter_annual_code_status" AS ENUM('active', 'redeemed', 'invalidated');--> statement-breakpoint
CREATE TYPE "public"."growth_billing_event_type" AS ENUM('paid_subscription_bound', 'renewal_settled', 'renewal_refunded', 'renewal_chargeback');--> statement-breakpoint
CREATE TYPE "public"."growth_token_kind" AS ENUM('consumer_referral', 'filter_annual');--> statement-breakpoint
CREATE TYPE "public"."points_entry_type" AS ENUM('earn', 'reversal', 'reserve', 'release', 'consume');--> statement-breakpoint
CREATE TYPE "public"."points_reservation_status" AS ENUM('reserved', 'released', 'consumed');--> statement-breakpoint
CREATE TABLE "consumer_referrals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inviter_account_id" uuid NOT NULL,
	"token_hash" char(64) NOT NULL,
	"status" "consumer_referral_status" DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"invitee_account_id" uuid,
	"registered_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"invalidated_reason" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consumer_referrals_expire_after_creation" CHECK ("consumer_referrals"."expires_at" > "consumer_referrals"."created_at"),
	CONSTRAINT "consumer_referrals_distinct_accounts" CHECK ("consumer_referrals"."invitee_account_id" IS NULL OR "consumer_referrals"."invitee_account_id" <> "consumer_referrals"."inviter_account_id"),
	CONSTRAINT "consumer_referrals_state_shape" CHECK (("consumer_referrals"."status" = 'active' AND "consumer_referrals"."invitee_account_id" IS NULL AND "consumer_referrals"."registered_at" IS NULL AND "consumer_referrals"."invalidated_at" IS NULL AND "consumer_referrals"."invalidated_reason" IS NULL) OR ("consumer_referrals"."status" = 'redeemed' AND "consumer_referrals"."invitee_account_id" IS NOT NULL AND "consumer_referrals"."registered_at" IS NOT NULL AND "consumer_referrals"."invalidated_at" IS NULL AND "consumer_referrals"."invalidated_reason" IS NULL) OR ("consumer_referrals"."status" = 'invalidated' AND "consumer_referrals"."invitee_account_id" IS NULL AND "consumer_referrals"."registered_at" IS NULL AND "consumer_referrals"."invalidated_at" IS NOT NULL AND "consumer_referrals"."invalidated_reason" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "consumer_referrals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "filter_annual_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issuer_filter_account_id" uuid NOT NULL,
	"token_hash" char(64) NOT NULL,
	"issuance_year" smallint NOT NULL,
	"status" "filter_annual_code_status" DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed_by_account_id" uuid,
	"redeemed_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"invalidated_reason" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "filter_annual_codes_year_range" CHECK ("filter_annual_codes"."issuance_year" BETWEEN 2020 AND 9999),
	CONSTRAINT "filter_annual_codes_expire_after_creation" CHECK ("filter_annual_codes"."expires_at" > "filter_annual_codes"."created_at"),
	CONSTRAINT "filter_annual_codes_distinct_accounts" CHECK ("filter_annual_codes"."redeemed_by_account_id" IS NULL OR "filter_annual_codes"."redeemed_by_account_id" <> "filter_annual_codes"."issuer_filter_account_id"),
	CONSTRAINT "filter_annual_codes_state_shape" CHECK (("filter_annual_codes"."status" = 'active' AND "filter_annual_codes"."redeemed_by_account_id" IS NULL AND "filter_annual_codes"."redeemed_at" IS NULL AND "filter_annual_codes"."invalidated_at" IS NULL AND "filter_annual_codes"."invalidated_reason" IS NULL) OR ("filter_annual_codes"."status" = 'redeemed' AND "filter_annual_codes"."redeemed_by_account_id" IS NOT NULL AND "filter_annual_codes"."redeemed_at" IS NOT NULL AND "filter_annual_codes"."invalidated_at" IS NULL AND "filter_annual_codes"."invalidated_reason" IS NULL) OR ("filter_annual_codes"."status" = 'invalidated' AND "filter_annual_codes"."redeemed_by_account_id" IS NULL AND "filter_annual_codes"."redeemed_at" IS NULL AND "filter_annual_codes"."invalidated_at" IS NOT NULL AND "filter_annual_codes"."invalidated_reason" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "filter_annual_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "growth_billing_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(64) NOT NULL,
	"provider_event_id" varchar(255) NOT NULL,
	"event_type" "growth_billing_event_type" NOT NULL,
	"account_id" uuid NOT NULL,
	"subscription_id" uuid,
	"referral_id" uuid,
	"original_event_id" uuid,
	"currency" char(3),
	"cash_amount_minor" bigint,
	"points_amount_minor" bigint DEFAULT 0 NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "growth_billing_events_provider_not_blank" CHECK (btrim("growth_billing_events"."provider") <> ''),
	CONSTRAINT "growth_billing_events_currency_shape" CHECK ("growth_billing_events"."currency" IS NULL OR "growth_billing_events"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "growth_billing_events_amounts_nonnegative" CHECK (("growth_billing_events"."cash_amount_minor" IS NULL OR "growth_billing_events"."cash_amount_minor" > 0) AND "growth_billing_events"."points_amount_minor" >= 0),
	CONSTRAINT "growth_billing_events_event_shape" CHECK (("growth_billing_events"."event_type" = 'paid_subscription_bound' AND "growth_billing_events"."subscription_id" IS NOT NULL AND "growth_billing_events"."original_event_id" IS NULL AND "growth_billing_events"."referral_id" IS NULL AND "growth_billing_events"."currency" IS NULL AND "growth_billing_events"."cash_amount_minor" IS NULL AND "growth_billing_events"."points_amount_minor" = 0) OR ("growth_billing_events"."event_type" = 'renewal_settled' AND "growth_billing_events"."subscription_id" IS NOT NULL AND "growth_billing_events"."original_event_id" IS NULL AND "growth_billing_events"."currency" IS NOT NULL AND "growth_billing_events"."cash_amount_minor" IS NOT NULL) OR ("growth_billing_events"."event_type" IN ('renewal_refunded', 'renewal_chargeback') AND "growth_billing_events"."subscription_id" IS NOT NULL AND "growth_billing_events"."original_event_id" IS NOT NULL AND "growth_billing_events"."currency" IS NOT NULL AND "growth_billing_events"."cash_amount_minor" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "growth_billing_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "growth_token_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_kind" "growth_token_kind" NOT NULL,
	"token_hash" char(64) NOT NULL,
	"account_id" uuid,
	"requester_fingerprint" char(64),
	"success" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "growth_token_attempts_actor_present" CHECK ("growth_token_attempts"."account_id" IS NOT NULL OR "growth_token_attempts"."requester_fingerprint" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "growth_token_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "points_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"available_minor" bigint DEFAULT 0 NOT NULL,
	"reserved_minor" bigint DEFAULT 0 NOT NULL,
	"clawback_minor" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "points_balances_currency_shape" CHECK ("points_balances"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "points_balances_nonnegative" CHECK ("points_balances"."available_minor" >= 0 AND "points_balances"."reserved_minor" >= 0 AND "points_balances"."clawback_minor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "points_balances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "points_ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"entry_type" "points_entry_type" NOT NULL,
	"amount_minor" bigint NOT NULL,
	"available_delta_minor" bigint NOT NULL,
	"reserved_delta_minor" bigint NOT NULL,
	"clawback_delta_minor" bigint NOT NULL,
	"available_after_minor" bigint NOT NULL,
	"reserved_after_minor" bigint NOT NULL,
	"clawback_after_minor" bigint NOT NULL,
	"billing_event_id" uuid,
	"reservation_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "points_ledger_entries_currency_shape" CHECK ("points_ledger_entries"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "points_ledger_entries_amount_positive" CHECK ("points_ledger_entries"."amount_minor" > 0),
	CONSTRAINT "points_ledger_entries_balances_nonnegative" CHECK ("points_ledger_entries"."available_after_minor" >= 0 AND "points_ledger_entries"."reserved_after_minor" >= 0 AND "points_ledger_entries"."clawback_after_minor" >= 0),
	CONSTRAINT "points_ledger_entries_shape" CHECK (("points_ledger_entries"."entry_type" = 'earn' AND "points_ledger_entries"."available_delta_minor" >= 0 AND "points_ledger_entries"."reserved_delta_minor" = 0 AND "points_ledger_entries"."clawback_delta_minor" <= 0 AND "points_ledger_entries"."available_delta_minor" - "points_ledger_entries"."clawback_delta_minor" = "points_ledger_entries"."amount_minor" AND "points_ledger_entries"."billing_event_id" IS NOT NULL AND "points_ledger_entries"."reservation_id" IS NULL) OR ("points_ledger_entries"."entry_type" = 'reversal' AND "points_ledger_entries"."available_delta_minor" <= 0 AND "points_ledger_entries"."reserved_delta_minor" = 0 AND "points_ledger_entries"."clawback_delta_minor" >= 0 AND -"points_ledger_entries"."available_delta_minor" + "points_ledger_entries"."clawback_delta_minor" = "points_ledger_entries"."amount_minor" AND "points_ledger_entries"."billing_event_id" IS NOT NULL AND "points_ledger_entries"."reservation_id" IS NULL) OR ("points_ledger_entries"."entry_type" = 'reserve' AND "points_ledger_entries"."available_delta_minor" = -"points_ledger_entries"."amount_minor" AND "points_ledger_entries"."reserved_delta_minor" = "points_ledger_entries"."amount_minor" AND "points_ledger_entries"."clawback_delta_minor" = 0 AND "points_ledger_entries"."billing_event_id" IS NULL AND "points_ledger_entries"."reservation_id" IS NOT NULL) OR ("points_ledger_entries"."entry_type" = 'release' AND "points_ledger_entries"."available_delta_minor" = "points_ledger_entries"."amount_minor" AND "points_ledger_entries"."reserved_delta_minor" = -"points_ledger_entries"."amount_minor" AND "points_ledger_entries"."clawback_delta_minor" = 0 AND "points_ledger_entries"."billing_event_id" IS NULL AND "points_ledger_entries"."reservation_id" IS NOT NULL) OR ("points_ledger_entries"."entry_type" = 'consume' AND "points_ledger_entries"."available_delta_minor" = 0 AND "points_ledger_entries"."reserved_delta_minor" = -"points_ledger_entries"."amount_minor" AND "points_ledger_entries"."clawback_delta_minor" = 0 AND "points_ledger_entries"."billing_event_id" IS NULL AND "points_ledger_entries"."reservation_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "points_ledger_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "points_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"amount_minor" bigint NOT NULL,
	"idempotency_key" varchar(255) NOT NULL,
	"status" "points_reservation_status" DEFAULT 'reserved' NOT NULL,
	"released_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "points_reservations_currency_shape" CHECK ("points_reservations"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "points_reservations_amount_positive" CHECK ("points_reservations"."amount_minor" > 0),
	CONSTRAINT "points_reservations_key_not_blank" CHECK (btrim("points_reservations"."idempotency_key") <> ''),
	CONSTRAINT "points_reservations_state_shape" CHECK (("points_reservations"."status" = 'reserved' AND "points_reservations"."released_at" IS NULL AND "points_reservations"."consumed_at" IS NULL) OR ("points_reservations"."status" = 'released' AND "points_reservations"."released_at" IS NOT NULL AND "points_reservations"."consumed_at" IS NULL) OR ("points_reservations"."status" = 'consumed' AND "points_reservations"."released_at" IS NULL AND "points_reservations"."consumed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "points_reservations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "direct_trial_consumed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "direct_trial_source_event_key" varchar(320);--> statement-breakpoint
ALTER TABLE "login_challenges" ADD COLUMN "consumer_referral_id" uuid;--> statement-breakpoint
UPDATE "accounts" AS a
SET
  "direct_trial_consumed_at" = existing."created_at",
  "direct_trial_source_event_key" = 'legacy:' || existing."id"::text
FROM (
  SELECT DISTINCT ON ("account_id") "account_id", "id", "created_at"
  FROM "membership_grants"
  WHERE "kind" = 'direct_trial'
  ORDER BY "account_id", "created_at", "id"
) AS existing
WHERE a."id" = existing."account_id"
  AND a."direct_trial_consumed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "consumer_referrals" ADD CONSTRAINT "consumer_referrals_inviter_account_id_accounts_id_fk" FOREIGN KEY ("inviter_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consumer_referrals" ADD CONSTRAINT "consumer_referrals_invitee_account_id_accounts_id_fk" FOREIGN KEY ("invitee_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filter_annual_codes" ADD CONSTRAINT "filter_annual_codes_issuer_filter_account_id_accounts_id_fk" FOREIGN KEY ("issuer_filter_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filter_annual_codes" ADD CONSTRAINT "filter_annual_codes_redeemed_by_account_id_accounts_id_fk" FOREIGN KEY ("redeemed_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_billing_events" ADD CONSTRAINT "growth_billing_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_billing_events" ADD CONSTRAINT "growth_billing_events_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_billing_events" ADD CONSTRAINT "growth_billing_events_referral_id_consumer_referrals_id_fk" FOREIGN KEY ("referral_id") REFERENCES "public"."consumer_referrals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_billing_events" ADD CONSTRAINT "growth_billing_events_original_event_id_growth_billing_events_id_fk" FOREIGN KEY ("original_event_id") REFERENCES "public"."growth_billing_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_token_attempts" ADD CONSTRAINT "growth_token_attempts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "points_balances" ADD CONSTRAINT "points_balances_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "points_ledger_entries" ADD CONSTRAINT "points_ledger_entries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "points_ledger_entries" ADD CONSTRAINT "points_ledger_entries_billing_event_id_growth_billing_events_id_fk" FOREIGN KEY ("billing_event_id") REFERENCES "public"."growth_billing_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "points_ledger_entries" ADD CONSTRAINT "points_ledger_entries_reservation_id_points_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."points_reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "points_reservations" ADD CONSTRAINT "points_reservations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "consumer_referrals_token_hash_unique" ON "consumer_referrals" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "consumer_referrals_active_inviter_unique" ON "consumer_referrals" USING btree ("inviter_account_id") WHERE "consumer_referrals"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "consumer_referrals_successful_inviter_unique" ON "consumer_referrals" USING btree ("inviter_account_id") WHERE "consumer_referrals"."status" = 'redeemed';--> statement-breakpoint
CREATE UNIQUE INDEX "consumer_referrals_successful_invitee_unique" ON "consumer_referrals" USING btree ("invitee_account_id") WHERE "consumer_referrals"."status" = 'redeemed';--> statement-breakpoint
CREATE INDEX "consumer_referrals_inviter_created_idx" ON "consumer_referrals" USING btree ("inviter_account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "filter_annual_codes_token_hash_unique" ON "filter_annual_codes" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "filter_annual_codes_issuer_year_idx" ON "filter_annual_codes" USING btree ("issuer_filter_account_id","issuance_year","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "growth_billing_events_provider_event_unique" ON "growth_billing_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "growth_billing_events_original_idx" ON "growth_billing_events" USING btree ("original_event_id","created_at");--> statement-breakpoint
CREATE INDEX "growth_billing_events_account_time_idx" ON "growth_billing_events" USING btree ("account_id","occurred_at");--> statement-breakpoint
CREATE INDEX "growth_token_attempts_account_created_idx" ON "growth_token_attempts" USING btree ("account_id","token_kind","created_at");--> statement-breakpoint
CREATE INDEX "growth_token_attempts_fingerprint_created_idx" ON "growth_token_attempts" USING btree ("requester_fingerprint","token_kind","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "points_balances_account_currency_unique" ON "points_balances" USING btree ("account_id","currency");--> statement-breakpoint
CREATE UNIQUE INDEX "points_ledger_entries_billing_event_unique" ON "points_ledger_entries" USING btree ("billing_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "points_ledger_entries_reservation_type_unique" ON "points_ledger_entries" USING btree ("reservation_id","entry_type");--> statement-breakpoint
CREATE INDEX "points_ledger_entries_account_time_idx" ON "points_ledger_entries" USING btree ("account_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "points_reservations_account_idempotency_unique" ON "points_reservations" USING btree ("account_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "points_reservations_account_status_idx" ON "points_reservations" USING btree ("account_id","status");--> statement-breakpoint
ALTER TABLE "login_challenges" ADD CONSTRAINT "login_challenges_consumer_referral_id_consumer_referrals_id_fk" FOREIGN KEY ("consumer_referral_id") REFERENCES "public"."consumer_referrals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_direct_trial_source_event_unique" ON "accounts" USING btree ("direct_trial_source_event_key");--> statement-breakpoint
CREATE INDEX "login_challenges_consumer_referral_idx" ON "login_challenges" USING btree ("consumer_referral_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "membership_grants_direct_trial_account_unique" ON "membership_grants" USING btree ("account_id") WHERE "membership_grants"."kind" = 'direct_trial';--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_direct_trial_consumption_shape" CHECK (("accounts"."direct_trial_consumed_at" IS NULL AND "accounts"."direct_trial_source_event_key" IS NULL) OR ("accounts"."direct_trial_consumed_at" IS NOT NULL AND "accounts"."direct_trial_source_event_key" IS NOT NULL));--> statement-breakpoint
CREATE POLICY "consumer_referrals_web_read" ON "consumer_referrals" AS PERMISSIVE FOR SELECT TO "attention_web_runtime" USING ("consumer_referrals"."inviter_account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid OR "consumer_referrals"."invitee_account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid OR "consumer_referrals"."token_hash" = NULLIF(current_setting('app.consumer_referral_token_hash', true), '') OR "consumer_referrals"."id"::text = NULLIF(current_setting('app.consumer_referral_id', true), ''));--> statement-breakpoint
CREATE POLICY "consumer_referrals_web_insert" ON "consumer_referrals" AS PERMISSIVE FOR INSERT TO "attention_web_runtime" WITH CHECK ("consumer_referrals"."inviter_account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "consumer_referrals_web_invalidate" ON "consumer_referrals" AS PERMISSIVE FOR UPDATE TO "attention_web_runtime" USING ("consumer_referrals"."inviter_account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid AND "consumer_referrals"."status" = 'active') WITH CHECK ("consumer_referrals"."inviter_account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid AND "consumer_referrals"."status" = 'invalidated' AND "consumer_referrals"."invitee_account_id" IS NULL AND "consumer_referrals"."registered_at" IS NULL);--> statement-breakpoint
CREATE POLICY "consumer_referrals_web_redeem" ON "consumer_referrals" AS PERMISSIVE FOR UPDATE TO "attention_web_runtime" USING ("consumer_referrals"."id"::text = NULLIF(current_setting('app.consumer_referral_id', true), '') AND "consumer_referrals"."status" = 'active') WITH CHECK ("consumer_referrals"."id"::text = NULLIF(current_setting('app.consumer_referral_id', true), '') AND "consumer_referrals"."status" = 'redeemed' AND "consumer_referrals"."invitee_account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "consumer_referrals_worker_read" ON "consumer_referrals" AS PERMISSIVE FOR SELECT TO "attention_worker_runtime" USING (true);--> statement-breakpoint
CREATE POLICY "filter_annual_codes_web_read" ON "filter_annual_codes" AS PERMISSIVE FOR SELECT TO "attention_web_runtime" USING ("filter_annual_codes"."issuer_filter_account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid OR "filter_annual_codes"."redeemed_by_account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid OR "filter_annual_codes"."token_hash" = NULLIF(current_setting('app.filter_annual_token_hash', true), ''));--> statement-breakpoint
CREATE POLICY "filter_annual_codes_web_insert" ON "filter_annual_codes" AS PERMISSIVE FOR INSERT TO "attention_web_runtime" WITH CHECK ("filter_annual_codes"."issuer_filter_account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "filter_annual_codes_web_redeem" ON "filter_annual_codes" AS PERMISSIVE FOR UPDATE TO "attention_web_runtime" USING ("filter_annual_codes"."token_hash" = NULLIF(current_setting('app.filter_annual_token_hash', true), '') AND "filter_annual_codes"."status" = 'active') WITH CHECK ("filter_annual_codes"."token_hash" = NULLIF(current_setting('app.filter_annual_token_hash', true), '') AND "filter_annual_codes"."status" = 'redeemed' AND "filter_annual_codes"."redeemed_by_account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "growth_billing_events_web_owner_access" ON "growth_billing_events" AS PERMISSIVE FOR ALL TO "attention_web_runtime" USING ("growth_billing_events"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK ("growth_billing_events"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "growth_billing_events_worker_access" ON "growth_billing_events" AS PERMISSIVE FOR ALL TO "attention_worker_runtime" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "growth_token_attempts_web_read_account" ON "growth_token_attempts" AS PERMISSIVE FOR SELECT TO "attention_web_runtime" USING ("growth_token_attempts"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "growth_token_attempts_web_read_fingerprint" ON "growth_token_attempts" AS PERMISSIVE FOR SELECT TO "attention_web_runtime" USING ("growth_token_attempts"."account_id" IS NULL AND "growth_token_attempts"."requester_fingerprint" = NULLIF(current_setting('app.growth_requester_fingerprint', true), ''));--> statement-breakpoint
CREATE POLICY "growth_token_attempts_web_insert" ON "growth_token_attempts" AS PERMISSIVE FOR INSERT TO "attention_web_runtime" WITH CHECK (("growth_token_attempts"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid AND "growth_token_attempts"."requester_fingerprint" IS NULL) OR ("growth_token_attempts"."account_id" IS NULL AND "growth_token_attempts"."requester_fingerprint" = NULLIF(current_setting('app.growth_requester_fingerprint', true), '')));--> statement-breakpoint
CREATE POLICY "growth_token_attempts_web_mark_success" ON "growth_token_attempts" AS PERMISSIVE FOR UPDATE TO "attention_web_runtime" USING ("growth_token_attempts"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid AND "growth_token_attempts"."token_kind" = 'filter_annual') WITH CHECK ("growth_token_attempts"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid AND "growth_token_attempts"."token_kind" = 'filter_annual' AND "growth_token_attempts"."success");--> statement-breakpoint
CREATE POLICY "points_balances_web_owner_access" ON "points_balances" AS PERMISSIVE FOR ALL TO "attention_web_runtime" USING ("points_balances"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK ("points_balances"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "points_balances_worker_access" ON "points_balances" AS PERMISSIVE FOR ALL TO "attention_worker_runtime" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "points_ledger_entries_web_read" ON "points_ledger_entries" AS PERMISSIVE FOR SELECT TO "attention_web_runtime" USING ("points_ledger_entries"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "points_ledger_entries_web_insert" ON "points_ledger_entries" AS PERMISSIVE FOR INSERT TO "attention_web_runtime" WITH CHECK ("points_ledger_entries"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "points_ledger_entries_worker_access" ON "points_ledger_entries" AS PERMISSIVE FOR ALL TO "attention_worker_runtime" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "points_reservations_web_owner_access" ON "points_reservations" AS PERMISSIVE FOR ALL TO "attention_web_runtime" USING ("points_reservations"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK ("points_reservations"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "points_reservations_worker_access" ON "points_reservations" AS PERMISSIVE FOR ALL TO "attention_worker_runtime" USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE
  consumer_referrals,
  filter_annual_codes,
  growth_token_attempts
TO attention_web_runtime;--> statement-breakpoint
GRANT UPDATE (status, invitee_account_id, registered_at, invalidated_at, invalidated_reason, updated_at)
ON TABLE consumer_referrals TO attention_web_runtime;--> statement-breakpoint
GRANT UPDATE (status, redeemed_by_account_id, redeemed_at, updated_at)
ON TABLE filter_annual_codes TO attention_web_runtime;--> statement-breakpoint
GRANT UPDATE (success)
ON TABLE growth_token_attempts TO attention_web_runtime;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE
  points_balances,
  points_reservations
TO attention_web_runtime;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE
  growth_billing_events,
  points_ledger_entries
TO attention_web_runtime;--> statement-breakpoint
GRANT SELECT ON TABLE consumer_referrals TO attention_worker_runtime;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE
  growth_billing_events,
  points_ledger_entries
TO attention_worker_runtime;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE
  points_balances,
  points_reservations
TO attention_worker_runtime;--> statement-breakpoint
GRANT INSERT ON TABLE membership_grants TO attention_worker_runtime;--> statement-breakpoint
GRANT UPDATE (direct_trial_consumed_at, direct_trial_source_event_key, updated_at)
ON TABLE accounts TO attention_worker_runtime;
