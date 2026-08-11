-- Xiaohongshu note identity intentionally stays query-free for deduplication,
-- while some public notes require xsec_token to open. Recover only the two
-- public access parameters from an already safety-approved observation.
WITH candidate_observations AS (
  SELECT
    "content_links"."id",
    "content_links"."content_id",
    "content_links"."normalized_url",
    "content_links"."observed_at",
    substring(
      "content_links"."safe_selected_url"
      FROM '[?&]xsec_source=([A-Za-z0-9._~%+-]+)'
    ) AS "access_source",
    substring(
      "content_links"."safe_selected_url"
      FROM '[?&]xsec_token=([A-Za-z0-9._~%+-]+)'
    ) AS "access_token"
  FROM "public"."content_links"
  WHERE "content_links"."source_adapter" = 'xiaohongshu'
    AND "content_links"."safety_status" = 'allowed'
    AND (
      "content_links"."safe_selected_url" LIKE 'https://www.xiaohongshu.com/explore/%'
      OR "content_links"."safe_selected_url" LIKE 'https://www.xiaohongshu.com/discovery/item/%'
      OR "content_links"."safe_selected_url" LIKE 'https://xiaohongshu.com/explore/%'
      OR "content_links"."safe_selected_url" LIKE 'https://xiaohongshu.com/discovery/item/%'
    )
),
latest_observations AS (
  SELECT DISTINCT ON ("content_id")
    "id",
    "content_id",
    "normalized_url",
    "observed_at",
    "access_source",
    "access_token"
  FROM candidate_observations
  WHERE "access_token" IS NOT NULL
    AND length("access_token") BETWEEN 1 AND 2048
    AND ("access_source" IS NULL OR length("access_source") BETWEEN 1 AND 128)
  ORDER BY "content_id", "observed_at" DESC, "id" DESC
),
repair_candidates AS (
  SELECT
    latest_observations.*,
    "contents"."title" = '小红书 - 你访问的页面不见了' AS "reset_enrichment"
  FROM latest_observations
  INNER JOIN "public"."contents" AS "contents"
    ON "contents"."id" = latest_observations."content_id"
  WHERE "contents"."source" = 'xiaohongshu'
    AND "contents"."normalized_url" = latest_observations."normalized_url"
    AND "contents"."normalized_url" LIKE 'https://www.xiaohongshu.com/explore/%'
),
repaired_contents AS (
  UPDATE "public"."contents" AS "contents"
  SET
    "outbound_url" = "contents"."normalized_url"
      || CASE
        WHEN repair_candidates."access_source" IS NULL THEN '?'
        ELSE '?xsec_source=' || repair_candidates."access_source" || '&'
      END
      || 'xsec_token=' || repair_candidates."access_token",
    "title" = CASE
      WHEN repair_candidates."reset_enrichment" THEN NULL
      ELSE "contents"."title"
    END,
    "author" = CASE
      WHEN repair_candidates."reset_enrichment" THEN NULL
      ELSE "contents"."author"
    END,
    "published_at" = CASE
      WHEN repair_candidates."reset_enrichment" THEN NULL
      ELSE "contents"."published_at"
    END,
    "ai_summary" = CASE
      WHEN repair_candidates."reset_enrichment" THEN NULL
      ELSE "contents"."ai_summary"
    END,
    "ai_tags" = CASE
      WHEN repair_candidates."reset_enrichment" THEN '[]'::jsonb
      ELSE "contents"."ai_tags"
    END,
    "summary_status" = CASE
      WHEN repair_candidates."reset_enrichment" THEN 'pending'
      ELSE "contents"."summary_status"
    END,
    "enrichment_status" = CASE
      WHEN repair_candidates."reset_enrichment" THEN 'pending'
      ELSE "contents"."enrichment_status"
    END,
    "updated_at" = now()
  FROM repair_candidates
  WHERE "contents"."id" = repair_candidates."content_id"
  RETURNING
    "contents"."id",
    repair_candidates."reset_enrichment"
)
UPDATE "public"."jobs" AS "jobs"
SET
  "status" = 'pending',
  "attempts" = 0,
  "available_at" = now(),
  "locked_at" = NULL,
  "locked_by" = NULL,
  "completed_at" = NULL,
  "last_error_code" = NULL,
  "updated_at" = now()
FROM repaired_contents
WHERE "jobs"."idempotency_key" IN (
  'content.metadata.v1:' || repaired_contents."id"::text,
  'content.summary.v1:' || repaired_contents."id"::text
)
AND repaired_contents."reset_enrichment";
