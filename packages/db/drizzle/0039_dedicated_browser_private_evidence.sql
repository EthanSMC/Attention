CREATE TABLE "browser_read_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"collection_id" uuid NOT NULL,
	"grant_hash" char(64) NOT NULL,
	"credential_id" uuid NOT NULL,
	"credential_kind" varchar(8) NOT NULL,
	"source_revision" char(64) NOT NULL,
	"source_url" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_read_grants_kind" CHECK ("browser_read_grants"."credential_kind" IN ('oauth', 'pat')),
	CONSTRAINT "browser_read_grants_hash_shape" CHECK ("browser_read_grants"."grant_hash" ~ '^[a-f0-9]{64}$' AND "browser_read_grants"."source_revision" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "browser_read_grants_lifetime" CHECK ("browser_read_grants"."expires_at" > "browser_read_grants"."created_at" AND "browser_read_grants"."expires_at" <= "browser_read_grants"."created_at" + interval '30 minutes')
);
--> statement-breakpoint
ALTER TABLE "browser_read_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "collection_private_enrichments" (
	"collection_id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"source_revision" char(64) NOT NULL,
	"evidence_sha256" char(64) NOT NULL,
	"source_url" text NOT NULL,
	"title" varchar(500) NOT NULL,
	"summary" text NOT NULL,
	"tags" jsonb NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_private_enrichments_shape" CHECK (length(btrim("collection_private_enrichments"."title")) > 0 AND length(btrim("collection_private_enrichments"."summary")) BETWEEN 1 AND 2000 AND "collection_private_enrichments"."source_revision" ~ '^[a-f0-9]{64}$' AND "collection_private_enrichments"."evidence_sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "collection_private_enrichments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "browser_read_grants" ADD CONSTRAINT "browser_read_grants_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_read_grants" ADD CONSTRAINT "browser_read_grants_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_private_enrichments" ADD CONSTRAINT "collection_private_enrichments_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_private_enrichments" ADD CONSTRAINT "collection_private_enrichments_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "browser_read_grants_account_unique" ON "browser_read_grants" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "browser_read_grants_hash_unique" ON "browser_read_grants" USING btree ("grant_hash");--> statement-breakpoint
CREATE POLICY "browser_read_grants_owner" ON "browser_read_grants" AS PERMISSIVE FOR ALL TO "attention_web_runtime" USING ("browser_read_grants"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK ("browser_read_grants"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "browser_read_grants_token_read" ON "browser_read_grants" AS PERMISSIVE FOR SELECT TO "attention_web_runtime" USING ("browser_read_grants"."grant_hash" = NULLIF(current_setting('app.browser_grant_hash', true), ''));--> statement-breakpoint
CREATE POLICY "collection_private_enrichments_owner" ON "collection_private_enrichments" AS PERMISSIVE FOR ALL TO "attention_web_runtime" USING ("collection_private_enrichments"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK ("collection_private_enrichments"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.browser_read_grants, public.collection_private_enrichments TO attention_web_runtime;
