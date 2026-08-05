ALTER TABLE event_ledger ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS event_ledger_web_tool_audit_insert ON event_ledger;
--> statement-breakpoint
CREATE POLICY event_ledger_web_tool_audit_insert ON event_ledger
  AS PERMISSIVE
  FOR INSERT
  TO attention_web_runtime
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND event_type = 'agent.tool_call.v1'
    AND scope = 'private'
    AND content_id IS NULL
    AND anonymous_session_id IS NULL
    AND request_id IS NOT NULL
    AND dedupe_key IS NULL
  );
--> statement-breakpoint
GRANT INSERT ON TABLE event_ledger TO attention_web_runtime;
