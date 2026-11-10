\set ON_ERROR_STOP on
-- Run only in a brand-new disposable PostgreSQL 17 cluster/database. This
-- validates the migration and runtime-role RLS, not the Node admission method.
-- Set PGOPTIONS='-c attention.website_agent_disposable=yes' and use a database
-- name beginning attention_website_agent_test_. Never point this at production.
BEGIN;
DO $$ BEGIN
  IF current_database() NOT LIKE 'attention_website_agent_test_%'
    OR current_setting('attention.website_agent_disposable', true) IS DISTINCT FROM 'yes'
    OR to_regclass('public.accounts') IS NOT NULL
    OR current_setting('server_version_num')::int NOT BETWEEN 170000 AND 179999
  THEN RAISE EXCEPTION 'requires empty, explicitly disposable PostgreSQL 17 database'; END IF;
END $$;
CREATE ROLE attention_web_runtime LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE TABLE public.accounts (id uuid PRIMARY KEY);
INSERT INTO public.accounts VALUES
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000002');
\ir ../../packages/db/drizzle/0039_website_agent_budget.sql

SET LOCAL ROLE attention_web_runtime;
DO $$ BEGIN
  IF (SELECT count(*) FROM public.website_agent_runs) <> 0 THEN RAISE EXCEPTION 'missing-context read leaked rows'; END IF;
END $$;
SELECT set_config('app.account_id', '00000000-0000-4000-8000-000000000001', true);
INSERT INTO public.website_agent_runs(account_id, operation_id, request_fingerprint,
  budget_date, reserved_cost_microusd, deadline)
VALUES ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003',
  repeat('a', 64), current_date, 400000, clock_timestamp() + interval '1 minute');
DO $$ BEGIN
  IF (SELECT count(*) FROM public.website_agent_runs) <> 1 THEN RAISE EXCEPTION 'owner could not read reservation'; END IF;
  BEGIN
    INSERT INTO public.website_agent_runs(account_id, operation_id, request_fingerprint, budget_date, reserved_cost_microusd, deadline)
      VALUES ('00000000-0000-4000-8000-000000000002', gen_random_uuid(), repeat('a',64), current_date, 1, clock_timestamp());
    RAISE EXCEPTION 'cross-account insert unexpectedly allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO public.website_agent_runs(account_id, operation_id, request_fingerprint, budget_date, reserved_cost_microusd, deadline)
      VALUES ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003', repeat('a',64), current_date, 1, clock_timestamp());
    RAISE EXCEPTION 'duplicate operation unexpectedly allowed';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.website_agent_runs(account_id, operation_id, request_fingerprint, budget_date, reserved_cost_microusd, deadline)
      VALUES ('00000000-0000-4000-8000-000000000001', gen_random_uuid(), repeat('a',64), current_date, 0, clock_timestamp());
    RAISE EXCEPTION 'zero reservation unexpectedly allowed';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    DELETE FROM public.website_agent_runs;
    RAISE EXCEPTION 'runtime delete unexpectedly allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;

SELECT set_config('app.account_id', '00000000-0000-4000-8000-000000000002', true);
DO $$ DECLARE affected integer; BEGIN
  IF (SELECT count(*) FROM public.website_agent_runs) <> 0 THEN RAISE EXCEPTION 'cross-account read leaked rows'; END IF;
  UPDATE public.website_agent_runs SET outcome = 'completed', finished_at = clock_timestamp();
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN RAISE EXCEPTION 'cross-account update unexpectedly allowed'; END IF;
END $$;
SELECT set_config('app.account_id', '00000000-0000-4000-8000-000000000001', true);
UPDATE public.website_agent_runs SET outcome = 'cancelled', finished_at = clock_timestamp();
DO $$ BEGIN
  IF (SELECT sum(reserved_cost_microusd) FROM public.website_agent_runs) <> 400000 THEN RAISE EXCEPTION 'cancellation refunded reservation'; END IF;
END $$;
ROLLBACK;
SELECT 'website_agent_migration_rls_checks_passed' AS result;
