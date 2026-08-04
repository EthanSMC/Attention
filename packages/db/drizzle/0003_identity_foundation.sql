CREATE TYPE "public"."api_credential_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."bind_intent_status" AS ENUM('pending', 'confirmed', 'consumed', 'expired', 'cancelled', 'conflict');--> statement-breakpoint
CREATE TYPE "public"."channel_provider" AS ENUM('wechat', 'wecom', 'douyin', 'xiaohongshu');--> statement-breakpoint
CREATE TYPE "public"."membership_grant_kind" AS ENUM('filter_grant', 'direct_trial', 'consumer_invitee_quarter', 'consumer_inviter_quarter', 'filter_annual_redemption', 'admin_grant');--> statement-breakpoint
CREATE TYPE "public"."membership_grant_status" AS ENUM('scheduled', 'active', 'revoked', 'expired');--> statement-breakpoint
CREATE TYPE "public"."oauth_credential_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."signup_source" AS ENUM('direct', 'consumer_referral');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('trialing', 'active', 'past_due', 'cancelled', 'expired');--> statement-breakpoint
CREATE TABLE "api_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"key_prefix" varchar(24) NOT NULL,
	"key_hash" char(64) NOT NULL,
	"key_version" smallint DEFAULT 1 NOT NULL,
	"scopes" jsonb NOT NULL,
	"client_id" varchar(128),
	"status" "api_credential_status" DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_credentials_name_not_blank" CHECK (btrim("api_credentials"."name") <> '')
);
--> statement-breakpoint
CREATE TABLE "bind_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" char(64) NOT NULL,
	"provider" "channel_provider" NOT NULL,
	"app_id" varchar(128) NOT NULL,
	"subject_id_hash" char(64) NOT NULL,
	"pending_request_id" uuid,
	"status" "bind_intent_status" DEFAULT 'pending' NOT NULL,
	"confirmed_account_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bind_intents_expire_after_creation" CHECK ("bind_intents"."expires_at" > "bind_intents"."created_at")
);
--> statement-breakpoint
CREATE TABLE "channel_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "channel_provider" NOT NULL,
	"app_id" varchar(128) NOT NULL,
	"subject_id_hash" char(64) NOT NULL,
	"union_subject_id_hash" char(64),
	"account_id" uuid NOT NULL,
	"bound_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_pending_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "channel_provider" NOT NULL,
	"app_id" varchar(128) NOT NULL,
	"subject_id_hash" char(64) NOT NULL,
	"channel_message_id" varchar(255) NOT NULL,
	"encrypted_payload" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_pending_requests_expire_after_creation" CHECK ("channel_pending_requests"."expires_at" > "channel_pending_requests"."created_at")
);
--> statement-breakpoint
CREATE TABLE "login_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(320) NOT NULL,
	"code_hash" char(64) NOT NULL,
	"requester_fingerprint" char(64),
	"return_to" text DEFAULT '/ai' NOT NULL,
	"failed_attempts" smallint DEFAULT 0 NOT NULL,
	"max_attempts" smallint DEFAULT 5 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "login_challenges_attempts_range" CHECK ("login_challenges"."failed_attempts" >= 0 AND "login_challenges"."failed_attempts" <= "login_challenges"."max_attempts"),
	CONSTRAINT "login_challenges_max_attempts_positive" CHECK ("login_challenges"."max_attempts" > 0),
	CONSTRAINT "login_challenges_expire_after_creation" CHECK ("login_challenges"."expires_at" > "login_challenges"."created_at")
);
--> statement-breakpoint
CREATE TABLE "membership_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" "membership_grant_kind" NOT NULL,
	"source_id" varchar(255) NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" "membership_grant_status" DEFAULT 'scheduled' NOT NULL,
	"revoked_at" timestamp with time zone,
	"revocation_reason" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_grants_valid_window" CHECK ("membership_grants"."ends_at" > "membership_grants"."starts_at"),
	CONSTRAINT "membership_grants_revocation_shape" CHECK (("membership_grants"."status" = 'revoked' AND "membership_grants"."revoked_at" IS NOT NULL) OR ("membership_grants"."status" <> 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "oauth_access_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" char(64) NOT NULL,
	"account_id" uuid NOT NULL,
	"client_id" varchar(128) NOT NULL,
	"scopes" jsonb NOT NULL,
	"audience" varchar(128) NOT NULL,
	"status" "oauth_credential_status" DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_access_tokens_expire_after_creation" CHECK ("oauth_access_tokens"."expires_at" > "oauth_access_tokens"."created_at")
);
--> statement-breakpoint
CREATE TABLE "oauth_authorization_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_hash" char(64) NOT NULL,
	"account_id" uuid NOT NULL,
	"client_id" varchar(128) NOT NULL,
	"redirect_uri" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"audience" varchar(128) NOT NULL,
	"code_challenge" varchar(128) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_authorization_codes_expire_after_creation" CHECK ("oauth_authorization_codes"."expires_at" > "oauth_authorization_codes"."created_at")
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"client_id" varchar(128) PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"redirect_uris" jsonb NOT NULL,
	"allowed_scopes" jsonb NOT NULL,
	"first_party" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_clients_name_not_blank" CHECK (btrim("oauth_clients"."name") <> '')
);
--> statement-breakpoint
CREATE TABLE "oauth_refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" char(64) NOT NULL,
	"account_id" uuid NOT NULL,
	"client_id" varchar(128) NOT NULL,
	"scopes" jsonb NOT NULL,
	"audience" varchar(128) NOT NULL,
	"status" "oauth_credential_status" DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_refresh_tokens_expire_after_creation" CHECK ("oauth_refresh_tokens"."expires_at" > "oauth_refresh_tokens"."created_at")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"provider" varchar(64) NOT NULL,
	"provider_customer_id" varchar(255),
	"provider_subscription_id" varchar(255),
	"status" "subscription_status" NOT NULL,
	"intro_eligible" boolean DEFAULT true NOT NULL,
	"first_charge_at" timestamp with time zone,
	"current_period_start" timestamp with time zone NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_valid_period" CHECK ("subscriptions"."current_period_end" > "subscriptions"."current_period_start")
);
--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "status" SET DEFAULT 'active';--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "primary_email" varchar(320);--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "display_name" varchar(100) DEFAULT '用户' NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "signup_source" "signup_source" DEFAULT 'direct' NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "terms_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "terms_version" varchar(32);--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "privacy_version" varchar(32);--> statement-breakpoint
ALTER TABLE "api_credentials" ADD CONSTRAINT "api_credentials_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bind_intents" ADD CONSTRAINT "bind_intents_pending_request_id_channel_pending_requests_id_fk" FOREIGN KEY ("pending_request_id") REFERENCES "public"."channel_pending_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bind_intents" ADD CONSTRAINT "bind_intents_confirmed_account_id_accounts_id_fk" FOREIGN KEY ("confirmed_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_identities" ADD CONSTRAINT "channel_identities_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_grants" ADD CONSTRAINT "membership_grants_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_credentials_key_hash_unique" ON "api_credentials" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_credentials_account_status_idx" ON "api_credentials" USING btree ("account_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "bind_intents_token_hash_unique" ON "bind_intents" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "bind_intents_pending_request_idx" ON "bind_intents" USING btree ("pending_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_identities_provider_subject_unique" ON "channel_identities" USING btree ("provider","app_id","subject_id_hash");--> statement-breakpoint
CREATE INDEX "channel_identities_account_idx" ON "channel_identities" USING btree ("account_id","revoked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_pending_requests_message_unique" ON "channel_pending_requests" USING btree ("provider","app_id","channel_message_id");--> statement-breakpoint
CREATE INDEX "channel_pending_requests_expiry_idx" ON "channel_pending_requests" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "login_challenges_email_created_idx" ON "login_challenges" USING btree ("email","created_at");--> statement-breakpoint
CREATE INDEX "login_challenges_fingerprint_created_idx" ON "login_challenges" USING btree ("requester_fingerprint","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "membership_grants_kind_source_unique" ON "membership_grants" USING btree ("kind","source_id");--> statement-breakpoint
CREATE INDEX "membership_grants_account_window_idx" ON "membership_grants" USING btree ("account_id","status","starts_at","ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_access_tokens_hash_unique" ON "oauth_access_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "oauth_access_tokens_account_idx" ON "oauth_access_tokens" USING btree ("account_id","status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_authorization_codes_hash_unique" ON "oauth_authorization_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "oauth_authorization_codes_account_idx" ON "oauth_authorization_codes" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_refresh_tokens_hash_unique" ON "oauth_refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "oauth_refresh_tokens_account_idx" ON "oauth_refresh_tokens" USING btree ("account_id","status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_provider_subscription_unique" ON "subscriptions" USING btree ("provider","provider_subscription_id");--> statement-breakpoint
CREATE INDEX "subscriptions_account_status_idx" ON "subscriptions" USING btree ("account_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_primary_email_unique" ON "accounts" USING btree ("primary_email");--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_email_verification_shape" CHECK ("accounts"."primary_email" IS NULL OR "accounts"."email_verified_at" IS NOT NULL);
--> statement-breakpoint
UPDATE "accounts" a
SET "display_name" = COALESCE(
  (SELECT fp."display_name" FROM "filter_profiles" fp WHERE fp."account_id" = a."id"),
  a."stable_handle"
);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE
  login_challenges,
  membership_grants,
  subscriptions,
  oauth_clients,
  oauth_authorization_codes,
  oauth_access_tokens,
  oauth_refresh_tokens,
  api_credentials,
  channel_identities,
  channel_pending_requests,
  bind_intents
TO attention_web_runtime;
