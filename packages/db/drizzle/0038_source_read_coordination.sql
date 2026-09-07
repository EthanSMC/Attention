CREATE TABLE "source_read_accounts" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"collection_id" uuid NOT NULL,
	"operation" char(64) NOT NULL,
	"source_fingerprint" char(64) NOT NULL,
	"attempt_ref" varchar(128) NOT NULL,
	"request_ref" varchar(128) NOT NULL,
	"reference" uuid NOT NULL,
	"lease_deadline" timestamp with time zone NOT NULL,
	"authorized_until" timestamp with time zone NOT NULL,
	"minute_bucket" timestamp with time zone NOT NULL,
	"minute_count" integer NOT NULL,
	"browser_consumed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "source_read_fingerprints" CHECK ("source_read_accounts"."operation" ~ '^[0-9a-f]{64}$' AND "source_read_accounts"."source_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "source_read_count" CHECK ("source_read_accounts"."minute_count" BETWEEN 1 AND 6)
);
--> statement-breakpoint
ALTER TABLE "source_read_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "source_read_browser_slots" (
	"slot" smallint PRIMARY KEY NOT NULL,
	"reference" uuid,
	"claim" uuid,
	"renderer_ref" varchar(64),
	"claimed_at" timestamp with time zone,
	CONSTRAINT "source_read_physical_slots" CHECK ("source_read_browser_slots"."slot" IN (1, 2)),
	CONSTRAINT "source_read_slot_shape" CHECK (("source_read_browser_slots"."reference" IS NULL AND "source_read_browser_slots"."claim" IS NULL AND "source_read_browser_slots"."renderer_ref" IS NULL AND "source_read_browser_slots"."claimed_at" IS NULL)
    OR ("source_read_browser_slots"."reference" IS NOT NULL AND "source_read_browser_slots"."claim" IS NOT NULL AND "source_read_browser_slots"."renderer_ref" ~ '^attention-reader-[0-9a-f-]{36}$' AND "source_read_browser_slots"."claimed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "source_read_browser_slots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "source_read_reference_unique" ON "source_read_accounts" USING btree ("reference");--> statement-breakpoint
CREATE POLICY "source_read_account_owner" ON "source_read_accounts" AS PERMISSIVE FOR ALL TO "attention_web_runtime" USING ("source_read_accounts"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK ("source_read_accounts"."account_id" = NULLIF(current_setting('app.account_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.source_read_accounts TO attention_web_runtime;
--> statement-breakpoint
INSERT INTO public.source_read_browser_slots (slot) VALUES (1), (2);
--> statement-breakpoint
CREATE FUNCTION public.source_read_browser(p_action text, p_reference uuid, p_request text, p_attempt text,
  p_source text, p_renderer text, p_claim uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_source public.source_read_accounts%ROWTYPE;
  v_slot public.source_read_browser_slots%ROWTYPE;
BEGIN
  IF p_action NOT IN ('inspect', 'consume', 'status', 'release') OR p_reference IS NULL
    OR p_renderer IS NULL OR p_renderer !~ '^attention-reader-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN RETURN NULL; END IF;
  -- Serialize the two physical slots and all claims. Expiry NEVER clears a slot.
  PERFORM pg_catalog.pg_advisory_xact_lock(782350194);
  IF p_action = 'release' THEN
    UPDATE public.source_read_browser_slots SET reference = NULL, claim = NULL, renderer_ref = NULL, claimed_at = NULL
      WHERE reference = p_reference AND claim = p_claim AND renderer_ref = p_renderer RETURNING * INTO v_slot;
    IF FOUND THEN RETURN pg_catalog.jsonb_build_object('released', true); END IF;
    RETURN NULL;
  END IF;
  SELECT * INTO v_source FROM public.source_read_accounts
    WHERE reference = p_reference AND request_ref = p_request AND attempt_ref = p_attempt AND source_fingerprint = p_source
      AND lease_deadline > pg_catalog.clock_timestamp() AND authorized_until > pg_catalog.clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = v_source.account_id AND status = 'active') THEN RETURN NULL; END IF;
  IF p_action = 'consume' THEN
    IF v_source.browser_consumed THEN RETURN NULL; END IF;
    SELECT * INTO v_slot FROM public.source_read_browser_slots WHERE reference IS NULL ORDER BY slot LIMIT 1 FOR UPDATE;
    IF NOT FOUND THEN
      IF (SELECT count(*) FROM public.source_read_browser_slots s JOIN public.source_read_accounts a ON a.reference = s.reference
        WHERE a.lease_deadline > pg_catalog.clock_timestamp() AND a.authorized_until > pg_catalog.clock_timestamp()) = 2 THEN
        RETURN pg_catalog.jsonb_build_object('code', 'rate_limited');
      END IF;
      RETURN NULL;
    END IF;
    UPDATE public.source_read_browser_slots SET reference = p_reference, claim = pg_catalog.gen_random_uuid(),
      renderer_ref = p_renderer, claimed_at = pg_catalog.clock_timestamp() WHERE slot = v_slot.slot RETURNING * INTO v_slot;
    UPDATE public.source_read_accounts SET browser_consumed = true WHERE account_id = v_source.account_id;
  ELSIF p_action = 'status' THEN
    SELECT * INTO v_slot FROM public.source_read_browser_slots
      WHERE reference = p_reference AND claim = p_claim AND renderer_ref = p_renderer;
    IF NOT FOUND THEN RETURN NULL; END IF;
  END IF;
  RETURN pg_catalog.jsonb_build_object('accountId', v_source.account_id, 'collectionId', v_source.collection_id,
    'operation', pg_catalog.rtrim(v_source.operation), 'claim', v_slot.claim);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.source_read_browser(text, uuid, text, text, text, text, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.source_read_browser(text, uuid, text, text, text, text, uuid) TO attention_web_runtime;
