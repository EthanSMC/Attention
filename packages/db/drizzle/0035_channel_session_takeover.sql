ALTER TABLE "external_channel_bindings" ADD COLUMN "channel_session_fingerprint" char(64);--> statement-breakpoint
CREATE INDEX "external_channel_bindings_session_lookup_idx" ON "external_channel_bindings" USING btree ("provider","channel_account_fingerprint","channel_session_fingerprint");--> statement-breakpoint
ALTER TABLE "external_channel_bindings" ADD CONSTRAINT "external_channel_bindings_session_fingerprint_format" CHECK ("external_channel_bindings"."channel_session_fingerprint" IS NULL OR "external_channel_bindings"."channel_session_fingerprint" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER POLICY "event_ledger_web_runtime_lifecycle_insert" ON "event_ledger" TO attention_web_runtime WITH CHECK ("event_ledger"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid AND "event_ledger"."event_type" IN ('agent.installation.registered.v1', 'agent.installation.heartbeat.v1', 'agent.installation.revoked.v1', 'channel.binding.reported.v1', 'channel.binding.replaced.v1', 'channel.binding.verified.v1', 'channel.binding.activity.v1', 'channel.binding.disconnected.v1') AND "event_ledger"."scope" = 'private' AND "event_ledger"."content_id" IS NULL AND "event_ledger"."anonymous_session_id" IS NULL AND "event_ledger"."request_id" IS NOT NULL);--> statement-breakpoint
ALTER POLICY "event_ledger_web_runtime_lifecycle_replay_read" ON "event_ledger" TO attention_web_runtime USING ("event_ledger"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid AND "event_ledger"."event_type" IN ('agent.installation.registered.v1', 'agent.installation.heartbeat.v1', 'agent.installation.revoked.v1', 'channel.binding.reported.v1', 'channel.binding.replaced.v1', 'channel.binding.verified.v1', 'channel.binding.activity.v1', 'channel.binding.disconnected.v1') AND "event_ledger"."scope" = 'private' AND "event_ledger"."content_id" IS NULL AND "event_ledger"."anonymous_session_id" IS NULL AND "event_ledger"."request_id" IS NOT NULL AND "event_ledger"."dedupe_key" IS NOT NULL);
--> statement-breakpoint
CREATE FUNCTION public.replace_active_channel_binding_owner(
  p_new_account_id uuid,
  p_new_installation_id uuid,
  p_provider public.local_channel_provider,
  p_channel_account_fingerprint char(64),
  p_channel_session_fingerprint char(64),
  p_replaced_at timestamptz DEFAULT pg_catalog.clock_timestamp()
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor_account_id uuid;
  v_replaced boolean := false;
BEGIN
  v_actor_account_id := NULLIF(
    pg_catalog.current_setting('app.account_id', true),
    ''
  )::uuid;

  IF v_actor_account_id IS NULL OR v_actor_account_id <> p_new_account_id THEN
    RAISE EXCEPTION 'invalid runtime account'
      USING ERRCODE = '42501';
  END IF;

  IF p_channel_account_fingerprint !~ '^[0-9a-f]{64}$'
    OR (
      p_channel_session_fingerprint IS NOT NULL
      AND p_channel_session_fingerprint !~ '^[0-9a-f]{64}$'
    )
  THEN
    RAISE EXCEPTION 'invalid channel fingerprint'
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.agent_installations AS replacement_installation
     WHERE replacement_installation.id = p_new_installation_id
       AND replacement_installation.account_id = p_new_account_id
       AND replacement_installation.status NOT IN ('disconnected', 'revoked')
  ) THEN
    RAISE EXCEPTION 'invalid runtime installation'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_provider::text || ':' || pg_catalog.rtrim(p_channel_account_fingerprint),
      0
    )
  );

  IF p_channel_session_fingerprint IS NULL THEN
    IF EXISTS (
      SELECT 1
        FROM public.external_channel_bindings AS prior_binding
       WHERE prior_binding.provider = p_provider
         AND prior_binding.channel_account_fingerprint =
           p_channel_account_fingerprint
    ) THEN
      RETURN 'channel_session_proof_required';
    END IF;
  ELSIF EXISTS (
    SELECT 1
      FROM public.external_channel_bindings AS prior_session
     WHERE prior_session.provider = p_provider
       AND prior_session.channel_account_fingerprint =
         p_channel_account_fingerprint
       AND prior_session.channel_session_fingerprint =
         p_channel_session_fingerprint
  ) THEN
    RETURN 'channel_session_superseded';
  END IF;

  UPDATE public.external_channel_binding_challenges AS old_challenge
     SET revoked_at = p_replaced_at
   WHERE old_challenge.consumed_at IS NULL
     AND old_challenge.revoked_at IS NULL
     AND EXISTS (
       SELECT 1
         FROM public.external_channel_bindings AS old_binding
        WHERE old_binding.id = old_challenge.binding_id
          AND old_binding.account_id = old_challenge.account_id
          AND old_binding.provider = p_provider
          AND old_binding.channel_account_fingerprint =
            p_channel_account_fingerprint
          AND old_binding.status IN ('reported', 'verified', 'healthy', 'stale')
     );

  WITH retired AS (
    UPDATE public.external_channel_bindings AS old_binding
       SET revoked_at = p_replaced_at,
           status = 'revoked',
           updated_at = p_replaced_at
     WHERE old_binding.provider = p_provider
       AND old_binding.channel_account_fingerprint =
         p_channel_account_fingerprint
       AND old_binding.status IN ('reported', 'verified', 'healthy', 'stale')
    RETURNING 1
  )
  SELECT EXISTS(SELECT 1 FROM retired)
    INTO v_replaced;

  RETURN CASE WHEN v_replaced THEN 'replaced' ELSE 'none' END;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.replace_active_channel_binding_owner(
  uuid,
  uuid,
  public.local_channel_provider,
  char(64),
  char(64),
  timestamptz
) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.replace_active_channel_binding_owner(
  uuid,
  uuid,
  public.local_channel_provider,
  char(64),
  char(64),
  timestamptz
) TO attention_web_runtime;
