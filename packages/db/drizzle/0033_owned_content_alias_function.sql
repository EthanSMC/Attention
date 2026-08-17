-- Link a short/original Content to its resolved winner without granting the
-- Web runtime arbitrary writes on the shared alias table. Both collections
-- must be actively owned by the account in the transaction-local context.
CREATE OR REPLACE FUNCTION public.attention_link_owned_content_alias(
  p_alias_content_id uuid,
  p_primary_content_id uuid,
  p_reason_code text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_account_id uuid;
  v_alias_dedupe_key text;
  v_linked_primary_id uuid;
BEGIN
  v_account_id := NULLIF(current_setting('app.account_id', true), '')::uuid;
  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'account_context_required' USING ERRCODE = '42501';
  END IF;
  IF p_alias_content_id = p_primary_content_id THEN
    RAISE EXCEPTION 'content_alias_must_be_distinct' USING ERRCODE = '23514';
  END IF;
  IF p_reason_code NOT IN ('agent_resolved_identity', 'resolved_shortlink_identity') THEN
    RAISE EXCEPTION 'content_alias_reason_not_allowed' USING ERRCODE = '23514';
  END IF;

  -- Serialize both orientations in the same order so two concurrent attempts
  -- cannot create a chain or cycle between the same Contents.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(LEAST(p_alias_content_id::text, p_primary_content_id::text), 0)
  );
  PERFORM pg_advisory_xact_lock(
    hashtextextended(GREATEST(p_alias_content_id::text, p_primary_content_id::text), 0)
  );

  PERFORM 1
  FROM contents AS alias_content
  JOIN contents AS primary_content ON primary_content.id = p_primary_content_id
  WHERE alias_content.id = p_alias_content_id
    AND alias_content.content_status = 'active'
    AND alias_content.public_safety_status = 'allowed'
    AND alias_content.takedown_status = 'none'
    AND alias_content.community_moderation_status = 'clear'
    AND primary_content.content_status = 'active'
    AND primary_content.public_safety_status = 'allowed'
    AND primary_content.takedown_status = 'none'
    AND primary_content.community_moderation_status = 'clear'
    AND EXISTS (
      SELECT 1 FROM collections AS alias_collection
      WHERE alias_collection.account_id = v_account_id
        AND alias_collection.content_id = p_alias_content_id
        AND alias_collection.collection_status = 'active'
    )
    AND EXISTS (
      SELECT 1 FROM collections AS primary_collection
      WHERE primary_collection.account_id = v_account_id
        AND primary_collection.content_id = p_primary_content_id
        AND primary_collection.collection_status = 'active'
    )
    AND NOT EXISTS (
      SELECT 1 FROM content_aliases AS parent_alias
      WHERE parent_alias.alias_content_id = p_primary_content_id
        AND parent_alias.active
    )
    AND NOT EXISTS (
      SELECT 1 FROM content_aliases AS child_alias
      WHERE child_alias.primary_content_id = p_alias_content_id
        AND child_alias.active
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'owned_content_alias_not_allowed' USING ERRCODE = '42501';
  END IF;

  SELECT identity.dedupe_key
  INTO v_alias_dedupe_key
  FROM content_identities AS identity
  WHERE identity.content_id = p_alias_content_id
    AND identity.active
  ORDER BY identity.created_at, identity.dedupe_key
  LIMIT 1;
  IF v_alias_dedupe_key IS NULL THEN
    RAISE EXCEPTION 'alias_identity_required' USING ERRCODE = '23514';
  END IF;

  INSERT INTO content_aliases (
    alias_content_id,
    primary_content_id,
    alias_dedupe_key,
    rule_version,
    reason_code
  ) VALUES (
    p_alias_content_id,
    p_primary_content_id,
    v_alias_dedupe_key,
    'v1',
    p_reason_code
  )
  ON CONFLICT (alias_content_id) DO NOTHING;

  SELECT alias.primary_content_id
  INTO v_linked_primary_id
  FROM content_aliases AS alias
  WHERE alias.alias_content_id = p_alias_content_id
    AND alias.active;
  IF v_linked_primary_id IS DISTINCT FROM p_primary_content_id THEN
    RAISE EXCEPTION 'content_alias_conflict' USING ERRCODE = '23505';
  END IF;
  RETURN true;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.attention_link_owned_content_alias(uuid, uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.attention_link_owned_content_alias(uuid, uuid, text) TO attention_web_runtime;
