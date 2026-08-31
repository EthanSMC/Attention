CREATE TABLE "admin_entitlement_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_account_id" uuid NOT NULL,
	"target_account_id" uuid NOT NULL,
	"action" varchar(32) NOT NULL,
	"previous_state" jsonb NOT NULL,
	"next_state" jsonb NOT NULL,
	"reason" varchar(500) NOT NULL,
	"source" varchar(64) NOT NULL,
	"request_id" varchar(128) NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_entitlement_audits_action_allowed" CHECK ("admin_entitlement_audits"."action" IN ('set_member', 'set_filter', 'revoke_filter')),
	CONSTRAINT "admin_entitlement_audits_reason_not_blank" CHECK (btrim("admin_entitlement_audits"."reason") <> ''),
	CONSTRAINT "admin_entitlement_audits_source_not_blank" CHECK (btrim("admin_entitlement_audits"."source") <> ''),
	CONSTRAINT "admin_entitlement_audits_request_not_blank" CHECK (btrim("admin_entitlement_audits"."request_id") <> ''),
	CONSTRAINT "admin_entitlement_audits_state_shape" CHECK ((
      jsonb_typeof("admin_entitlement_audits"."previous_state") = 'object'
      AND jsonb_typeof("admin_entitlement_audits"."previous_state"->'isFilter') = 'boolean'
      AND jsonb_typeof("admin_entitlement_audits"."previous_state"->'isMember') = 'boolean'
      AND "admin_entitlement_audits"."previous_state"->>'tier' IN ('free', 'member', 'filter')
      AND (
        ("admin_entitlement_audits"."previous_state"->>'tier' = 'free' AND ("admin_entitlement_audits"."previous_state"->>'isFilter')::boolean = false AND ("admin_entitlement_audits"."previous_state"->>'isMember')::boolean = false)
        OR ("admin_entitlement_audits"."previous_state"->>'tier' = 'member' AND ("admin_entitlement_audits"."previous_state"->>'isFilter')::boolean = false AND ("admin_entitlement_audits"."previous_state"->>'isMember')::boolean = true)
        OR ("admin_entitlement_audits"."previous_state"->>'tier' = 'filter' AND ("admin_entitlement_audits"."previous_state"->>'isFilter')::boolean = true AND ("admin_entitlement_audits"."previous_state"->>'isMember')::boolean = true)
      )
    ) AND (
      jsonb_typeof("admin_entitlement_audits"."next_state") = 'object'
      AND jsonb_typeof("admin_entitlement_audits"."next_state"->'isFilter') = 'boolean'
      AND jsonb_typeof("admin_entitlement_audits"."next_state"->'isMember') = 'boolean'
      AND "admin_entitlement_audits"."next_state"->>'tier' IN ('free', 'member', 'filter')
      AND (
        ("admin_entitlement_audits"."next_state"->>'tier' = 'free' AND ("admin_entitlement_audits"."next_state"->>'isFilter')::boolean = false AND ("admin_entitlement_audits"."next_state"->>'isMember')::boolean = false)
        OR ("admin_entitlement_audits"."next_state"->>'tier' = 'member' AND ("admin_entitlement_audits"."next_state"->>'isFilter')::boolean = false AND ("admin_entitlement_audits"."next_state"->>'isMember')::boolean = true)
        OR ("admin_entitlement_audits"."next_state"->>'tier' = 'filter' AND ("admin_entitlement_audits"."next_state"->>'isFilter')::boolean = true AND ("admin_entitlement_audits"."next_state"->>'isMember')::boolean = true)
      )
    ))
);
--> statement-breakpoint
ALTER TABLE "admin_entitlement_audits" ADD CONSTRAINT "admin_entitlement_audits_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_entitlement_audits" ADD CONSTRAINT "admin_entitlement_audits_target_account_id_accounts_id_fk" FOREIGN KEY ("target_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_entitlement_audits_actor_time_idx" ON "admin_entitlement_audits" USING btree ("actor_account_id","occurred_at");--> statement-breakpoint
CREATE INDEX "admin_entitlement_audits_target_time_idx" ON "admin_entitlement_audits" USING btree ("target_account_id","occurred_at");--> statement-breakpoint
CREATE INDEX "admin_entitlement_audits_request_idx" ON "admin_entitlement_audits" USING btree ("request_id");--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "admin_entitlement_audits" TO "attention_web_runtime";
