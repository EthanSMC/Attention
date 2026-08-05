CREATE TABLE "password_login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(320) NOT NULL,
	"requester_fingerprint" char(64),
	"success" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "password_login_attempts_email_created_idx" ON "password_login_attempts" USING btree ("email","created_at");--> statement-breakpoint
CREATE INDEX "password_login_attempts_fingerprint_created_idx" ON "password_login_attempts" USING btree ("requester_fingerprint","created_at");
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE password_login_attempts TO attention_web_runtime;
--> statement-breakpoint
GRANT SELECT ON TABLE collection_events TO attention_web_runtime;
