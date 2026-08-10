-- Password login records failures before verifying the credential, then marks
-- the reserved attempt successful in a second transaction. The Web runtime
-- role therefore needs narrowly-scoped UPDATE access to this column.
GRANT UPDATE (success)
ON TABLE password_login_attempts TO attention_web_runtime;
