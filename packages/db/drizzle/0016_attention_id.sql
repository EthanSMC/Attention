ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "attention_id" varchar(20);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "attention_id_changed_at" timestamp with time zone;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "accounts_attention_id_unique"
  ON "accounts" USING btree ("attention_id")
  WHERE "attention_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_attention_id_format"
  CHECK ("attention_id" IS NULL OR "attention_id" ~ '^[a-z][a-z0-9_-]{5,19}$');
--> statement-breakpoint
ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_attention_id_change_shape"
  CHECK (
    ("attention_id" IS NULL AND "attention_id_changed_at" IS NULL)
    OR
    ("attention_id" IS NOT NULL AND "attention_id_changed_at" IS NOT NULL)
  );
--> statement-breakpoint
CREATE OR REPLACE VIEW "public"."public_content_attributions_current"
WITH (security_barrier = true) AS (
  SELECT
    col.content_id,
    a.stable_handle,
    fp.display_name,
    fp.avatar_url,
    a.attention_id
  FROM collections col
  JOIN public_contents_current pc ON pc.id = col.content_id
  JOIN filter_profiles fp ON fp.account_id = col.account_id
  JOIN accounts a ON a.id = col.account_id
  JOIN domains d ON d.id = col.domain_id
  WHERE col.collection_status = 'active'
    AND col.visibility = 'public'
    AND col.public_since IS NOT NULL
    AND col.filter_revoked_at IS NULL
    AND col.moderation_status = 'clear'
    AND fp.active = true
    AND fp.revoked_at IS NULL
    AND a.status = 'active'
    AND d.active = true
);
