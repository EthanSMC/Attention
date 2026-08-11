CREATE TYPE "public"."oauth_connection_kind" AS ENUM('mcp', 'runtime');--> statement-breakpoint
CREATE TABLE "oauth_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"client_id" varchar(128) NOT NULL,
	"audience" varchar(128) NOT NULL,
	"kind" "oauth_connection_kind" NOT NULL,
	"label" varchar(80) NOT NULL,
	"normalized_label" varchar(80) NOT NULL,
	"device_name" varchar(80),
	"installation_key_hash" char(64),
	"last_authorized_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_connections" ADD CONSTRAINT "oauth_connections_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_connections" ADD CONSTRAINT "oauth_connections_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
WITH "oauth_credential_activity" AS (
	SELECT
		"account_id",
		"client_id",
		"audience",
		"created_at",
		NULL::timestamp with time zone AS "last_used_at"
	FROM "oauth_authorization_codes"
	UNION ALL
	SELECT
		"account_id",
		"client_id",
		"audience",
		"created_at",
		"last_used_at"
	FROM "oauth_access_tokens"
	UNION ALL
	SELECT
		"account_id",
		"client_id",
		"audience",
		"created_at",
		NULL::timestamp with time zone AS "last_used_at"
	FROM "oauth_refresh_tokens"
),
"connection_candidates" AS (
	SELECT
		"account_id",
		"client_id",
		"audience",
		MIN("created_at") AS "first_authorized_at",
		MAX("created_at") AS "last_authorized_at",
		MAX("last_used_at") AS "last_used_at"
	FROM "oauth_credential_activity"
	GROUP BY "account_id", "client_id", "audience"
),
"normalized_candidates" AS (
	SELECT
		"connection_candidates".*,
		"oauth_clients"."name" AS "client_name",
		BTRIM(
			REGEXP_REPLACE(
				NORMALIZE("oauth_clients"."name", NFKC),
				'[[:space:]]+',
				' ',
				'g'
			)
		) AS "display_client_name",
		LOWER(
			BTRIM(
				REGEXP_REPLACE(
					NORMALIZE("oauth_clients"."name", NFKC),
					'[[:space:]]+',
					' ',
					'g'
				)
			)
		) AS "normalized_client_name"
	FROM "connection_candidates"
	INNER JOIN "oauth_clients"
		ON "oauth_clients"."client_id" = "connection_candidates"."client_id"
),
"ranked_connections" AS (
	SELECT
		"normalized_candidates".*,
		ROW_NUMBER() OVER (
			PARTITION BY
				"normalized_candidates"."account_id",
				"normalized_candidates"."audience"
			ORDER BY
				"normalized_candidates"."first_authorized_at",
				"normalized_candidates"."normalized_client_name" COLLATE "C",
				"normalized_candidates"."client_id" COLLATE "C"
		) AS "import_rank"
	FROM "normalized_candidates"
),
"labeled_connections" AS (
	SELECT
		"ranked_connections".*,
		' · imported ' || "import_rank"::text AS "import_suffix"
	FROM "ranked_connections"
),
"bounded_labels" AS (
	SELECT
		"labeled_connections".*,
		LEFT(
			"display_client_name",
			GREATEST(0, 80 - CHAR_LENGTH("import_suffix"))
		) || "import_suffix" AS "connection_label"
	FROM "labeled_connections"
)
INSERT INTO "oauth_connections" (
	"account_id",
	"client_id",
	"audience",
	"kind",
	"label",
	"normalized_label",
	"last_authorized_at",
	"last_used_at",
	"created_at",
	"updated_at"
)
SELECT
	"account_id",
	"client_id",
	"audience",
	CASE
		WHEN "audience" = 'attention-channel-runtime' THEN 'runtime'::"oauth_connection_kind"
		ELSE 'mcp'::"oauth_connection_kind"
	END,
	"connection_label",
	LOWER(
		BTRIM(
			REGEXP_REPLACE(
				NORMALIZE("connection_label", NFKC),
				'[[:space:]]+',
				' ',
				'g'
			)
		)
	),
	"last_authorized_at",
	"last_used_at",
	"first_authorized_at",
	"last_authorized_at"
FROM "bounded_labels";--> statement-breakpoint
UPDATE "oauth_authorization_codes" AS "credential"
SET "connection_id" = "connection"."id"
FROM "oauth_connections" AS "connection"
WHERE "connection"."account_id" = "credential"."account_id"
	AND "connection"."client_id" = "credential"."client_id"
	AND "connection"."audience" = "credential"."audience";--> statement-breakpoint
UPDATE "oauth_access_tokens" AS "credential"
SET "connection_id" = "connection"."id"
FROM "oauth_connections" AS "connection"
WHERE "connection"."account_id" = "credential"."account_id"
	AND "connection"."client_id" = "credential"."client_id"
	AND "connection"."audience" = "credential"."audience";--> statement-breakpoint
UPDATE "oauth_refresh_tokens" AS "credential"
SET "connection_id" = "connection"."id"
FROM "oauth_connections" AS "connection"
WHERE "connection"."account_id" = "credential"."account_id"
	AND "connection"."client_id" = "credential"."client_id"
	AND "connection"."audience" = "credential"."audience";--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_connection_id_oauth_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."oauth_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_connection_id_oauth_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."oauth_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_connection_id_oauth_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."oauth_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_connections_active_name_unique" ON "oauth_connections" USING btree ("account_id", "audience", "normalized_label") WHERE "revoked_at" IS NULL;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "oauth_connections" TO "attention_web_runtime";
