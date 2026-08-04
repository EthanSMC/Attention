\set ON_ERROR_STOP on
\getenv web_runtime_password ATTENTION_WEB_DATABASE_PASSWORD
\getenv worker_runtime_password ATTENTION_WORKER_DATABASE_PASSWORD

SELECT format(
  'ALTER ROLE attention_web_runtime PASSWORD %L',
  :'web_runtime_password'
) \gexec

SELECT format(
  'ALTER ROLE attention_worker_runtime PASSWORD %L',
  :'worker_runtime_password'
) \gexec
