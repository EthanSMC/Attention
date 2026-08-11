ALTER TABLE "oauth_authorization_codes" ADD COLUMN "connection_label" varchar(80);--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD COLUMN "normalized_connection_label" varchar(80);--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD COLUMN "replacement_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_replacement_connection_id_oauth_connections_id_fk" FOREIGN KEY ("replacement_connection_id") REFERENCES "public"."oauth_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_connection_intent_check" CHECK ((
        "oauth_authorization_codes"."connection_label" IS NULL
        AND "oauth_authorization_codes"."normalized_connection_label" IS NULL
        AND "oauth_authorization_codes"."replacement_connection_id" IS NULL
      ) OR (
        "oauth_authorization_codes"."connection_id" IS NULL
        AND "oauth_authorization_codes"."connection_label" IS NOT NULL
        AND "oauth_authorization_codes"."normalized_connection_label" IS NOT NULL
      ));--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_connection_label_not_blank" CHECK ("oauth_authorization_codes"."connection_label" IS NULL OR char_length("oauth_authorization_codes"."connection_label") > 0);--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_normalized_label_not_blank" CHECK ("oauth_authorization_codes"."normalized_connection_label" IS NULL OR char_length("oauth_authorization_codes"."normalized_connection_label") > 0);