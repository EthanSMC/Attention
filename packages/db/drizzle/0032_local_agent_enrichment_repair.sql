-- Restore only locally-enrichable legacy failures. Moderated, inactive, and
-- already summarized Content remains untouched, and no jobs are replayed.
UPDATE "public"."contents"
SET
  "summary_status" = 'pending',
  "updated_at" = now()
WHERE "content_status" = 'active'
  AND "public_safety_status" = 'allowed'
  AND "takedown_status" = 'none'
  AND "community_moderation_status" = 'clear'
  AND "ai_summary" IS NULL
  AND "summary_status" IN ('unavailable', 'failed');
