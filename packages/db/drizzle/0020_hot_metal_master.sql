CREATE TYPE "public"."agent_integration_id" AS ENUM('openclaw', 'hermes', 'codex', 'claude-code', 'workbuddy');--> statement-breakpoint
CREATE TYPE "public"."channel_owner_kind" AS ENUM('native', 'bridge');--> statement-breakpoint
CREATE TYPE "public"."external_channel_binding_status" AS ENUM('reported', 'verified', 'healthy', 'stale', 'disconnected', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."installation_status" AS ENUM('registered', 'active', 'degraded', 'stale', 'disconnected', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."local_channel_provider" AS ENUM('wechat_ilink', 'workbuddy_wechat');--> statement-breakpoint
CREATE TABLE "agent_installations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"oauth_client_id" varchar(128) NOT NULL,
	"agent_integration_id" "agent_integration_id" NOT NULL,
	"owner_kind" "channel_owner_kind" NOT NULL,
	"device_name" varchar(100) NOT NULL,
	"adapter_version" varchar(64) NOT NULL,
	"skill_version" varchar(64) NOT NULL,
	"tool_contract_version" varchar(64) NOT NULL,
	"capabilities" jsonb NOT NULL,
	"status" "installation_status" DEFAULT 'registered' NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_installations_id_account_unique" UNIQUE("id","account_id"),
	CONSTRAINT "agent_installations_device_name_not_blank" CHECK (btrim("agent_installations"."device_name") <> ''),
	CONSTRAINT "agent_installations_versions_not_blank" CHECK (btrim("agent_installations"."adapter_version") <> '' AND btrim("agent_installations"."skill_version") <> '' AND btrim("agent_installations"."tool_contract_version") <> ''),
	CONSTRAINT "agent_installations_owner_kind_matches_agent" CHECK (("agent_installations"."agent_integration_id" IN ('openclaw', 'hermes', 'workbuddy') AND "agent_installations"."owner_kind" = 'native') OR ("agent_installations"."agent_integration_id" IN ('codex', 'claude-code') AND "agent_installations"."owner_kind" = 'bridge')),
	CONSTRAINT "agent_installations_capabilities_shape" CHECK (jsonb_typeof("agent_installations"."capabilities") = 'object' AND "agent_installations"."capabilities" ?& ARRAY['heartbeat_mode', 'pairing_verification', 'restricted_profile'] AND "agent_installations"."capabilities" - ARRAY['heartbeat_mode', 'pairing_verification', 'restricted_profile'] = '{}'::jsonb AND "agent_installations"."capabilities"->>'heartbeat_mode' IN ('runtime', 'event_driven') AND "agent_installations"."capabilities"->'pairing_verification' = 'true'::jsonb AND jsonb_typeof("agent_installations"."capabilities"->'restricted_profile') = 'boolean' AND ("agent_installations"."owner_kind" <> 'bridge' OR "agent_installations"."capabilities"->'restricted_profile' = 'true'::jsonb)),
	CONSTRAINT "agent_installations_terminal_status_shape" CHECK (("agent_installations"."status" = 'disconnected' AND "agent_installations"."disconnected_at" IS NOT NULL AND "agent_installations"."revoked_at" IS NULL) OR ("agent_installations"."status" = 'revoked' AND "agent_installations"."revoked_at" IS NOT NULL) OR ("agent_installations"."status" NOT IN ('disconnected', 'revoked') AND "agent_installations"."disconnected_at" IS NULL AND "agent_installations"."revoked_at" IS NULL)),
	CONSTRAINT "agent_installations_timestamp_order" CHECK (("agent_installations"."last_seen_at" IS NULL OR "agent_installations"."last_seen_at" >= "agent_installations"."registered_at") AND ("agent_installations"."disconnected_at" IS NULL OR "agent_installations"."disconnected_at" >= "agent_installations"."registered_at") AND ("agent_installations"."revoked_at" IS NULL OR "agent_installations"."revoked_at" >= "agent_installations"."registered_at"))
);
--> statement-breakpoint
ALTER TABLE "agent_installations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "external_channel_binding_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"pairing_code_hash" char(64) NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "external_channel_binding_challenges_code_hash_format" CHECK ("external_channel_binding_challenges"."pairing_code_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "external_channel_binding_challenges_valid_window" CHECK ("external_channel_binding_challenges"."expires_at" > "external_channel_binding_challenges"."issued_at" AND "external_channel_binding_challenges"."expires_at" <= "external_channel_binding_challenges"."issued_at" + interval '15 minutes'),
	CONSTRAINT "external_channel_binding_challenges_terminal_shape" CHECK (NOT ("external_channel_binding_challenges"."consumed_at" IS NOT NULL AND "external_channel_binding_challenges"."revoked_at" IS NOT NULL) AND ("external_channel_binding_challenges"."consumed_at" IS NULL OR ("external_channel_binding_challenges"."consumed_at" >= "external_channel_binding_challenges"."issued_at" AND "external_channel_binding_challenges"."consumed_at" < "external_channel_binding_challenges"."expires_at")) AND ("external_channel_binding_challenges"."revoked_at" IS NULL OR "external_channel_binding_challenges"."revoked_at" >= "external_channel_binding_challenges"."issued_at"))
);
--> statement-breakpoint
ALTER TABLE "external_channel_binding_challenges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "external_channel_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"provider" "local_channel_provider" NOT NULL,
	"channel_account_fingerprint" char(64) NOT NULL,
	"paired_peer_fingerprint" char(64),
	"status" "external_channel_binding_status" DEFAULT 'reported' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_channel_bindings_id_account_unique" UNIQUE("id","account_id"),
	CONSTRAINT "external_channel_bindings_channel_fingerprint_format" CHECK ("external_channel_bindings"."channel_account_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "external_channel_bindings_peer_fingerprint_format" CHECK ("external_channel_bindings"."paired_peer_fingerprint" IS NULL OR "external_channel_bindings"."paired_peer_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "external_channel_bindings_verification_shape" CHECK (("external_channel_bindings"."status" = 'reported' AND "external_channel_bindings"."verified_at" IS NULL AND "external_channel_bindings"."paired_peer_fingerprint" IS NULL) OR ("external_channel_bindings"."status" IN ('verified', 'healthy', 'stale') AND "external_channel_bindings"."verified_at" IS NOT NULL AND "external_channel_bindings"."paired_peer_fingerprint" IS NOT NULL) OR ("external_channel_bindings"."status" IN ('disconnected', 'revoked'))),
	CONSTRAINT "external_channel_bindings_terminal_status_shape" CHECK (("external_channel_bindings"."status" = 'disconnected' AND "external_channel_bindings"."disconnected_at" IS NOT NULL AND "external_channel_bindings"."revoked_at" IS NULL) OR ("external_channel_bindings"."status" = 'revoked' AND "external_channel_bindings"."revoked_at" IS NOT NULL) OR ("external_channel_bindings"."status" NOT IN ('disconnected', 'revoked') AND "external_channel_bindings"."disconnected_at" IS NULL AND "external_channel_bindings"."revoked_at" IS NULL)),
	CONSTRAINT "external_channel_bindings_timestamp_order" CHECK (("external_channel_bindings"."verified_at" IS NULL OR "external_channel_bindings"."verified_at" >= "external_channel_bindings"."created_at") AND ("external_channel_bindings"."last_seen_at" IS NULL OR "external_channel_bindings"."last_seen_at" >= "external_channel_bindings"."created_at") AND ("external_channel_bindings"."disconnected_at" IS NULL OR "external_channel_bindings"."disconnected_at" >= "external_channel_bindings"."created_at") AND ("external_channel_bindings"."revoked_at" IS NULL OR "external_channel_bindings"."revoked_at" >= "external_channel_bindings"."created_at"))
);
--> statement-breakpoint
ALTER TABLE "external_channel_bindings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_installations" ADD CONSTRAINT "agent_installations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_installations" ADD CONSTRAINT "agent_installations_oauth_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_channel_binding_challenges" ADD CONSTRAINT "external_channel_binding_challenges_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_channel_binding_challenges" ADD CONSTRAINT "external_channel_binding_challenges_binding_account_fk" FOREIGN KEY ("binding_id","account_id") REFERENCES "public"."external_channel_bindings"("id","account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_channel_bindings" ADD CONSTRAINT "external_channel_bindings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_channel_bindings" ADD CONSTRAINT "external_channel_bindings_installation_account_fk" FOREIGN KEY ("installation_id","account_id") REFERENCES "public"."agent_installations"("id","account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_installations_oauth_client_unique" ON "agent_installations" USING btree ("oauth_client_id");--> statement-breakpoint
CREATE INDEX "agent_installations_account_status_idx" ON "agent_installations" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX "agent_installations_status_last_seen_idx" ON "agent_installations" USING btree ("status","last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "external_channel_binding_challenges_code_hash_unique" ON "external_channel_binding_challenges" USING btree ("pairing_code_hash");--> statement-breakpoint
CREATE INDEX "external_channel_binding_challenges_binding_expiry_idx" ON "external_channel_binding_challenges" USING btree ("binding_id","expires_at");--> statement-breakpoint
CREATE INDEX "external_channel_binding_challenges_expiry_idx" ON "external_channel_binding_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "external_channel_bindings_active_owner_unique" ON "external_channel_bindings" USING btree ("provider","channel_account_fingerprint") WHERE "external_channel_bindings"."status" IN ('reported', 'verified', 'healthy', 'stale');--> statement-breakpoint
CREATE INDEX "external_channel_bindings_account_status_idx" ON "external_channel_bindings" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX "external_channel_bindings_installation_status_idx" ON "external_channel_bindings" USING btree ("installation_id","status");--> statement-breakpoint
CREATE INDEX "external_channel_bindings_status_last_seen_idx" ON "external_channel_bindings" USING btree ("status","last_seen_at");--> statement-breakpoint
CREATE POLICY "event_ledger_web_runtime_lifecycle_insert" ON "event_ledger" AS PERMISSIVE FOR INSERT TO "attention_web_runtime" WITH CHECK ("event_ledger"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid AND "event_ledger"."event_type" IN ('agent.installation.registered.v1', 'agent.installation.heartbeat.v1', 'agent.installation.revoked.v1', 'channel.binding.reported.v1', 'channel.binding.verified.v1', 'channel.binding.activity.v1', 'channel.binding.disconnected.v1') AND "event_ledger"."scope" = 'private' AND "event_ledger"."content_id" IS NULL AND "event_ledger"."anonymous_session_id" IS NULL AND "event_ledger"."request_id" IS NOT NULL);--> statement-breakpoint
CREATE POLICY "event_ledger_web_runtime_lifecycle_replay_read" ON "event_ledger" AS PERMISSIVE FOR SELECT TO "attention_web_runtime" USING ("event_ledger"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid AND "event_ledger"."event_type" IN ('agent.installation.registered.v1', 'agent.installation.heartbeat.v1', 'agent.installation.revoked.v1', 'channel.binding.reported.v1', 'channel.binding.verified.v1', 'channel.binding.activity.v1', 'channel.binding.disconnected.v1') AND "event_ledger"."scope" = 'private' AND "event_ledger"."content_id" IS NULL AND "event_ledger"."anonymous_session_id" IS NULL AND "event_ledger"."request_id" IS NOT NULL AND "event_ledger"."dedupe_key" IS NOT NULL);--> statement-breakpoint
CREATE POLICY "agent_installations_owner_access" ON "agent_installations" AS PERMISSIVE FOR ALL TO "attention_web_runtime" USING ("agent_installations"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK ("agent_installations"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "external_channel_binding_challenges_owner_access" ON "external_channel_binding_challenges" AS PERMISSIVE FOR ALL TO "attention_web_runtime" USING ("external_channel_binding_challenges"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK ("external_channel_binding_challenges"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "external_channel_bindings_owner_access" ON "external_channel_bindings" AS PERMISSIVE FOR ALL TO "attention_web_runtime" USING ("external_channel_bindings"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK ("external_channel_bindings"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT ON TABLE event_ledger TO attention_web_runtime;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  agent_installations,
  external_channel_bindings,
  external_channel_binding_challenges
TO attention_web_runtime;
