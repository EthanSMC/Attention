CREATE TABLE "website_agent_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"encrypted_state" text NOT NULL,
	"active_run_id" uuid,
	"active_run_deadline" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "website_agent_session_owner_unique" UNIQUE("account_id","id"),
	CONSTRAINT "website_agent_session_revision" CHECK ("website_agent_sessions"."revision" >= 0),
	CONSTRAINT "website_agent_session_ciphertext" CHECK (octet_length("website_agent_sessions"."encrypted_state") BETWEEN 50 AND 1048576),
	CONSTRAINT "website_agent_session_run_shape" CHECK (("website_agent_sessions"."active_run_id" IS NULL AND "website_agent_sessions"."active_run_deadline" IS NULL) OR ("website_agent_sessions"."active_run_id" IS NOT NULL AND "website_agent_sessions"."active_run_deadline" IS NOT NULL AND "website_agent_sessions"."closed_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "website_agent_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "website_agent_runs" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "website_agent_sessions" ADD CONSTRAINT "website_agent_sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "website_agent_session_owner_updated_idx" ON "website_agent_sessions" USING btree ("account_id","updated_at");--> statement-breakpoint
ALTER TABLE "website_agent_runs" ADD CONSTRAINT "website_agent_run_session_owner_fk" FOREIGN KEY ("account_id","session_id") REFERENCES "public"."website_agent_sessions"("account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "website_agent_session_owner_access" ON "website_agent_sessions" AS PERMISSIVE FOR ALL TO "attention_web_runtime" USING ("website_agent_sessions"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK ("website_agent_sessions"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.website_agent_sessions TO attention_web_runtime;
