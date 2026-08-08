ALTER TYPE "public"."entitlement_source" ADD VALUE 'signup' BEFORE 'invite';

-- Registration is the baseline Member entitlement. Backfill active accounts
-- created before this policy change without touching invitation/filter grants.
INSERT INTO "public"."entitlements" (
  "account_id",
  "member_enabled",
  "source",
  "starts_at",
  "ends_at",
  "created_at",
  "updated_at"
)
SELECT
  "accounts"."id",
  true,
  'signup',
  "accounts"."created_at",
  NULL,
  "accounts"."created_at",
  "accounts"."updated_at"
FROM "public"."accounts"
WHERE "accounts"."status" = 'active'
ON CONFLICT ("account_id", "source") DO NOTHING;
