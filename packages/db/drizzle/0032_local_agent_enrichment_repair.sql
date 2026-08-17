-- The old summary handler returned unavailable when its provider was absent.
-- That exact path left a cleanly completed summary job; execution failures left
-- a failed job and error code. Rows without this exact history remain terminal.
UPDATE "public"."contents" AS "content"
SET
  "summary_status" = 'pending',
  "updated_at" = now()
WHERE "content_status" = 'active'
  AND "public_safety_status" = 'allowed'
  AND "takedown_status" = 'none'
  AND "community_moderation_status" = 'clear'
  AND "ai_summary" IS NULL
  AND "enrichment_status" = 'partial'
  AND "summary_status" = 'unavailable'
  AND EXISTS (
    SELECT 1
    FROM "public"."jobs" AS "summary_job"
    WHERE "summary_job"."task_type" = 'content.summary.v1'
      AND "summary_job"."status" = 'completed'
      AND "summary_job"."completed_at" IS NOT NULL
      AND "summary_job"."last_error_code" IS NULL
      AND "summary_job"."idempotency_key" =
        'content.summary.v1:' || "content"."id"::text
      AND "summary_job"."payload" ->> 'contentId' = "content"."id"::text
  );
