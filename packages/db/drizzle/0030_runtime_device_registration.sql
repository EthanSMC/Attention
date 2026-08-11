ALTER TABLE "oauth_clients" ADD COLUMN "connection_kind" "oauth_connection_kind";--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "device_name" varchar(80);--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "installation_key_hash" char(64);--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_runtime_identity_shape" CHECK ((
        "oauth_clients"."connection_kind" IS NULL
        AND "oauth_clients"."device_name" IS NULL
        AND "oauth_clients"."installation_key_hash" IS NULL
      ) OR (
        "oauth_clients"."connection_kind" = 'runtime'
        AND "oauth_clients"."device_name" IS NOT NULL
        AND btrim("oauth_clients"."device_name") <> ''
        AND "oauth_clients"."installation_key_hash" ~ '^[0-9a-f]{64}$'
      ));
