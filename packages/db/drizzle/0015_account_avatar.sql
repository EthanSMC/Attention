ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "avatar_url" text;
--> statement-breakpoint
UPDATE "accounts" AS account
SET "avatar_url" = profile."avatar_url"
FROM "filter_profiles" AS profile
WHERE profile."account_id" = account."id"
  AND account."avatar_url" IS NULL
  AND profile."avatar_url" IS NOT NULL;
