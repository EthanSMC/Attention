DROP VIEW "public"."public_contents_current";--> statement-breakpoint
ALTER TABLE "contents" ADD COLUMN "ai_tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE VIEW "public"."public_contents_current" WITH (security_barrier = true) AS (
    SELECT
      c.id,
      c.public_id,
      c.outbound_url,
      c.normalized_url,
      c.canonical_url,
      c.first_public_at,
      c.visibility_version,
      c.source,
      c.content_type,
      c.title,
      c.author,
      c.published_at,
      c.cached_favicon_asset_key,
      c.ai_summary,
      c.ai_tags,
      c.summary_status,
      c.enrichment_status,
      count(col.id)::integer AS public_collection_count,
      c.created_at,
      c.updated_at
    FROM contents c
    JOIN collections col ON col.content_id = c.id
    JOIN filter_profiles fp ON fp.account_id = col.account_id
    JOIN accounts a ON a.id = col.account_id
    JOIN domains d ON d.id = col.domain_id
    WHERE c.content_status = 'active'
      AND c.public_safety_status = 'allowed'
      AND c.takedown_status = 'none'
      AND c.first_public_at IS NOT NULL
      AND col.collection_status = 'active'
      AND col.visibility = 'public'
      AND col.public_since IS NOT NULL
      AND col.filter_revoked_at IS NULL
      AND col.moderation_status = 'clear'
      AND fp.active = true
      AND fp.revoked_at IS NULL
      AND a.status = 'active'
      AND d.active = true
    GROUP BY c.id
  );--> statement-breakpoint
CREATE POLICY "collections_worker_read" ON "collections" AS PERMISSIVE FOR SELECT TO "attention_worker_runtime" USING (true);--> statement-breakpoint
GRANT SELECT ON TABLE public_contents_current TO attention_web_runtime;--> statement-breakpoint
GRANT SELECT ON TABLE
  collections,
  entitlements,
  filter_profiles,
  membership_grants,
  subscriptions
TO attention_worker_runtime;
