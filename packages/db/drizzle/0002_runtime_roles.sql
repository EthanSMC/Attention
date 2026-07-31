-- Runtime roles are deliberately distinct from the migration/table owner.
-- They are LOGIN roles without passwords; deployment assigns secrets out of
-- band, never in source control. Table owners bypass RLS, these roles do not.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'attention_web_runtime') THEN
    CREATE ROLE attention_web_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'attention_worker_runtime') THEN
    CREATE ROLE attention_worker_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
ALTER ROLE attention_web_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
--> statement-breakpoint
ALTER ROLE attention_worker_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM attention_web_runtime, attention_worker_runtime;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO attention_web_runtime, attention_worker_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE
  accounts,
  entitlements,
  filter_profiles,
  invitations,
  sessions,
  input_attempts,
  pending_candidate_sets,
  collections
TO attention_web_runtime;
--> statement-breakpoint
GRANT SELECT ON TABLE
  domains,
  content_aliases,
  public_contents_current,
  public_content_attributions_current
TO attention_web_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE contents, content_identities
TO attention_web_runtime;
--> statement-breakpoint
GRANT INSERT ON TABLE input_candidates, collection_events, content_links
TO attention_web_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE jobs TO attention_web_runtime;
--> statement-breakpoint
GRANT SELECT, UPDATE ON TABLE contents TO attention_worker_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE jobs TO attention_worker_runtime;
--> statement-breakpoint
GRANT SELECT, DELETE ON TABLE pending_candidate_sets TO attention_worker_runtime;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public
TO attention_web_runtime, attention_worker_runtime;
--> statement-breakpoint
DROP POLICY IF EXISTS collections_owner_access ON collections;
--> statement-breakpoint
CREATE POLICY collections_owner_access ON collections
  AS PERMISSIVE
  FOR ALL
  TO attention_web_runtime
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
