ALTER TABLE "oauth_authorization_codes" DROP CONSTRAINT "oauth_authorization_codes_connection_intent_check";--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_connections_active_runtime_installation_unique" ON "oauth_connections" USING btree ("account_id","audience","kind","installation_key_hash") WHERE "oauth_connections"."audience" = 'attention-channel-runtime' AND "oauth_connections"."kind" = 'runtime' AND "oauth_connections"."installation_key_hash" IS NOT NULL AND "oauth_connections"."revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_connection_intent_check" CHECK ((
        "oauth_authorization_codes"."connection_label" IS NULL
        AND "oauth_authorization_codes"."normalized_connection_label" IS NULL
        AND "oauth_authorization_codes"."replacement_connection_id" IS NULL
      ) OR (
        "oauth_authorization_codes"."connection_label" IS NOT NULL
        AND "oauth_authorization_codes"."normalized_connection_label" IS NOT NULL
        AND (
          "oauth_authorization_codes"."connection_id" IS NULL
          OR "oauth_authorization_codes"."replacement_connection_id" IS NULL
        )
      ));--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "oauth_connections" TO "attention_web_runtime";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "oauth_authorization_codes" TO "attention_web_runtime";
