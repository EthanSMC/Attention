CREATE TABLE "website_agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"request_fingerprint" char(64) NOT NULL,
	"budget_date" date NOT NULL,
	"reserved_cost_microusd" integer NOT NULL,
	"outcome" varchar(16) DEFAULT 'reserved' NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "website_agent_reservation_positive" CHECK ("website_agent_runs"."reserved_cost_microusd" BETWEEN 1 AND 100000000),
	CONSTRAINT "website_agent_fingerprint_shape" CHECK ("website_agent_runs"."request_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "website_agent_outcome_shape" CHECK (("website_agent_runs"."outcome" = 'reserved' AND "website_agent_runs"."finished_at" IS NULL) OR ("website_agent_runs"."outcome" IN ('completed', 'failed', 'cancelled') AND "website_agent_runs"."finished_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "website_agent_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "website_agent_runs" ADD CONSTRAINT "website_agent_runs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "website_agent_operation_unique" ON "website_agent_runs" USING btree ("account_id","operation_id");--> statement-breakpoint
CREATE INDEX "website_agent_account_budget_idx" ON "website_agent_runs" USING btree ("account_id","budget_date");--> statement-breakpoint
CREATE POLICY "website_agent_run_owner_access" ON "website_agent_runs" AS PERMISSIVE FOR ALL TO "attention_web_runtime" USING ("website_agent_runs"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK ("website_agent_runs"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.website_agent_runs TO attention_web_runtime;
