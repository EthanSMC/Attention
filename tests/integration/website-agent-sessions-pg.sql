\set ON_ERROR_STOP on
-- Run only in a brand-new disposable PostgreSQL 17 cluster/database.
-- PGOPTIONS='-c attention.website_agent_disposable=yes'; never use production.
BEGIN;
DO $$ BEGIN
  IF current_database() NOT LIKE 'attention_website_agent_test_%'
    OR current_setting('attention.website_agent_disposable', true) IS DISTINCT FROM 'yes'
    OR to_regclass('public.accounts') IS NOT NULL
    OR current_setting('server_version_num')::int NOT BETWEEN 170000 AND 179999
  THEN RAISE EXCEPTION 'requires empty, explicitly disposable PostgreSQL 17 database'; END IF;
END $$;
CREATE ROLE attention_web_runtime LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE attention_worker_runtime LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE TABLE public.accounts (id uuid PRIMARY KEY);
INSERT INTO public.accounts VALUES
 ('00000000-0000-4000-8000-000000000001'), ('00000000-0000-4000-8000-000000000002');
\ir ../../packages/db/drizzle/0039_website_agent_budget.sql
-- Existing 0039 reservations remain valid and retain their amounts after 0040.
INSERT INTO public.website_agent_runs(account_id, operation_id, request_fingerprint, budget_date, reserved_cost_microusd, deadline)
VALUES ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003', repeat('a',64), current_date, 400000, clock_timestamp());
\ir ../../packages/db/drizzle/0040_website_agent_sessions.sql
DO $$ BEGIN
 IF (SELECT count(*) FROM public.website_agent_runs WHERE session_id IS NULL AND reserved_cost_microusd = 400000) <> 1
 THEN RAISE EXCEPTION 'migration lost existing admission data'; END IF;
END $$;
SET LOCAL ROLE attention_web_runtime;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM public.website_agent_sessions) THEN RAISE EXCEPTION 'missing-context read leaked sessions'; END IF;
 BEGIN
  INSERT INTO public.website_agent_sessions (account_id, encrypted_state, expires_at)
  VALUES ('00000000-0000-4000-8000-000000000001', repeat('x',100), clock_timestamp());
  RAISE EXCEPTION 'missing-context insert allowed';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
SELECT set_config('app.account_id', '00000000-0000-4000-8000-000000000001', true);
INSERT INTO public.website_agent_sessions (id, account_id, encrypted_state, expires_at)
VALUES ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', repeat('x',100), clock_timestamp() + interval '7 days');
DO $$ BEGIN
 IF (SELECT count(*) FROM public.website_agent_sessions) <> 1 THEN RAISE EXCEPTION 'owner cannot read session'; END IF;
 BEGIN
  INSERT INTO public.website_agent_sessions (account_id, encrypted_state, expires_at)
  VALUES ('00000000-0000-4000-8000-000000000002', repeat('x',100), clock_timestamp());
  RAISE EXCEPTION 'cross-owner insert allowed';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  UPDATE public.website_agent_sessions SET account_id = '00000000-0000-4000-8000-000000000002';
  RAISE EXCEPTION 'owner reassignment allowed';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  DELETE FROM public.website_agent_sessions;
  RAISE EXCEPTION 'runtime permanent deletion allowed';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  UPDATE public.website_agent_sessions SET revision = -1;
  RAISE EXCEPTION 'negative revision allowed';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  UPDATE public.website_agent_sessions SET encrypted_state = repeat('x',1048577);
  RAISE EXCEPTION 'unbounded ciphertext allowed';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  UPDATE public.website_agent_sessions SET encrypted_state = repeat('x',49);
  RAISE EXCEPTION 'invalid short ciphertext allowed';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  UPDATE public.website_agent_sessions SET active_run_id = gen_random_uuid();
  RAISE EXCEPTION 'partial lease allowed';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
INSERT INTO public.website_agent_runs (id, account_id, session_id, operation_id, request_fingerprint, budget_date, reserved_cost_microusd, deadline)
VALUES ('20000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', gen_random_uuid(), repeat('b',64), current_date, 400000, clock_timestamp() + interval '1 minute');
UPDATE public.website_agent_sessions SET revision = 1, active_run_id = '20000000-0000-4000-8000-000000000001', active_run_deadline = clock_timestamp() + interval '1 minute'
WHERE id = '10000000-0000-4000-8000-000000000001' AND revision = 0;
DO $$ DECLARE affected integer; BEGIN
 BEGIN
  UPDATE public.website_agent_sessions SET closed_at = clock_timestamp();
  RAISE EXCEPTION 'closed session retained active lease';
 EXCEPTION WHEN check_violation THEN NULL; END;
 UPDATE public.website_agent_sessions SET revision = 99 WHERE id = '10000000-0000-4000-8000-000000000001' AND revision = 0;
 GET DIAGNOSTICS affected = ROW_COUNT;
 IF affected <> 0 THEN RAISE EXCEPTION 'stale CAS unexpectedly changed session'; END IF;
END $$;
-- Both records must roll back together when a transaction cannot persist its session revision.
SAVEPOINT rejected_turn;
UPDATE public.website_agent_runs SET outcome = 'failed', finished_at = clock_timestamp()
WHERE id = '20000000-0000-4000-8000-000000000001';
UPDATE public.website_agent_sessions SET revision = 2, active_run_id = NULL, active_run_deadline = NULL
WHERE id = '10000000-0000-4000-8000-000000000001';
ROLLBACK TO SAVEPOINT rejected_turn;
DO $$ BEGIN
 IF (SELECT outcome FROM public.website_agent_runs WHERE id = '20000000-0000-4000-8000-000000000001') <> 'reserved'
    OR (SELECT revision FROM public.website_agent_sessions WHERE id = '10000000-0000-4000-8000-000000000001') <> 1
 THEN RAISE EXCEPTION 'session and reservation did not roll back atomically'; END IF;
END $$;
SELECT set_config('app.account_id', '00000000-0000-4000-8000-000000000002', true);
DO $$ DECLARE affected integer; BEGIN
 IF EXISTS (SELECT 1 FROM public.website_agent_sessions WHERE id = '10000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'guessed session ID leaked'; END IF;
 UPDATE public.website_agent_sessions SET closed_at = clock_timestamp(), active_run_id = NULL, active_run_deadline = NULL;
 GET DIAGNOSTICS affected = ROW_COUNT;
 IF affected <> 0 THEN RAISE EXCEPTION 'cross-owner close allowed'; END IF;
 UPDATE public.website_agent_sessions SET encrypted_state = repeat('z',100), revision = revision + 1 WHERE id = '10000000-0000-4000-8000-000000000001';
 GET DIAGNOSTICS affected = ROW_COUNT;
 IF affected <> 0 THEN RAISE EXCEPTION 'cross-owner resume/update allowed'; END IF;
 BEGIN
  INSERT INTO public.website_agent_runs (account_id, session_id, operation_id, request_fingerprint, budget_date, reserved_cost_microusd, deadline)
  VALUES ('00000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', gen_random_uuid(), repeat('c',64), current_date, 400000, clock_timestamp());
  RAISE EXCEPTION 'cross-owner run/session linkage allowed';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END $$;
-- Also verify the ownership FK independently of RLS, as the migration owner.
RESET ROLE;
DO $$ BEGIN
 BEGIN
  INSERT INTO public.website_agent_runs (account_id, session_id, operation_id, request_fingerprint, budget_date, reserved_cost_microusd, deadline)
  VALUES ('00000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', gen_random_uuid(), repeat('c',64), current_date, 400000, clock_timestamp());
  RAISE EXCEPTION 'composite owner FK missing';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END $$;
SET LOCAL ROLE attention_worker_runtime;
DO $$ BEGIN
 BEGIN
  PERFORM 1 FROM public.website_agent_sessions;
  RAISE EXCEPTION 'unrelated worker has website session access';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
SET LOCAL ROLE attention_web_runtime;
SELECT set_config('app.account_id', '00000000-0000-4000-8000-000000000001', true);
UPDATE public.website_agent_sessions SET revision = 2, closed_at = clock_timestamp(), active_run_id = NULL, active_run_deadline = NULL
WHERE id = '10000000-0000-4000-8000-000000000001' AND revision = 1;
UPDATE public.website_agent_runs SET outcome = 'cancelled', finished_at = clock_timestamp() WHERE id = '20000000-0000-4000-8000-000000000001';
DO $$ DECLARE affected integer; BEGIN
 UPDATE public.website_agent_sessions SET revision = 3, encrypted_state = repeat('z',100)
 WHERE id = '10000000-0000-4000-8000-000000000001' AND revision = 1 AND closed_at IS NULL;
 GET DIAGNOSTICS affected = ROW_COUNT;
 IF affected <> 0 THEN RAISE EXCEPTION 'stale completion after close allowed'; END IF;
 IF (SELECT sum(reserved_cost_microusd) FROM public.website_agent_runs) <> 800000 THEN RAISE EXCEPTION 'close refunded budget'; END IF;
END $$;
ROLLBACK;
SELECT 'website_agent_session_migration_rls_checks_passed' AS result;
