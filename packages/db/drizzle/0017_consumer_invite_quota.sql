DROP INDEX IF EXISTS "consumer_referrals_successful_inviter_unique";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consumer_referrals_successful_inviter_idx"
  ON "consumer_referrals" USING btree ("inviter_account_id")
  WHERE "status" = 'redeemed';
