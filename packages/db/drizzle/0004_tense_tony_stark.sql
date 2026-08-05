ALTER TABLE "channel_pending_requests" ADD COLUMN "encrypted_result" text;--> statement-breakpoint
ALTER TABLE "channel_pending_requests" ADD COLUMN "processing_error_code" varchar(100);--> statement-breakpoint
ALTER TABLE "channel_pending_requests" ADD COLUMN "processed_at" timestamp with time zone;