CREATE TABLE "mcp_rate_limit_buckets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"client_key" varchar(128) NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"request_count" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_rate_limit_request_count_positive" CHECK ("mcp_rate_limit_buckets"."request_count" > 0),
	CONSTRAINT "mcp_rate_limit_client_key_not_blank" CHECK (btrim("mcp_rate_limit_buckets"."client_key") <> '')
);
--> statement-breakpoint
ALTER TABLE "mcp_rate_limit_buckets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mcp_rate_limit_buckets" ADD CONSTRAINT "mcp_rate_limit_buckets_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_rate_limit_bucket_unique" ON "mcp_rate_limit_buckets" USING btree ("account_id","credential_id","client_key","window_started_at");--> statement-breakpoint
CREATE INDEX "mcp_rate_limit_account_window_idx" ON "mcp_rate_limit_buckets" USING btree ("account_id","window_started_at");--> statement-breakpoint
CREATE POLICY "mcp_rate_limit_bucket_owner_access" ON "mcp_rate_limit_buckets" AS PERMISSIVE FOR ALL TO "attention_web_runtime" USING ("mcp_rate_limit_buckets"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK ("mcp_rate_limit_buckets"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mcp_rate_limit_buckets TO attention_web_runtime;
