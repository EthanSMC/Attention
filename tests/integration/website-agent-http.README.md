# Website agent authenticated HTTP acceptance

`website-agent-http.test.ts` invokes the actual Next route exports with Web
Request/Response objects. It issues real opaque session cookies for synthetic
accounts, resolves them through the actual authentication functions and full
PostgreSQL schema, and uses the non-owner `attention_web_runtime` connection.
No fake principal, auth function, store, route, or native Pi implementation is
injected. Only external provider fetch is replaced by deterministic DeepSeek SSE;
unexpected network destinations fail. No paid API call is made.

Coverage includes anonymous/forged-cookie/bearer-only denial, Member eligibility,
cross-origin guards, two independent owners, create/query/resume/list/close,
persisted native history, direct runtime RLS denial, revocation during generation,
and revocation during persistence before a final response. The final transaction
test preserves a completed durable run while withholding its answer from a newly
revoked caller. Test-only PostgreSQL triggers cause real auth revocation; they do
not replace authentication or application logic.

## Safe execution

The CI step after the ordinary test suite creates a separate database on its
ephemeral PostgreSQL 17.6 service. It never shares the `attention_test` schema
with the existing truncating suites. The new suite never truncates or deletes
application tables. Use a new database for each execution; do not rerun against
an existing fixture.

Required environment:

- `TEST_WEBSITE_AGENT_DISPOSABLE=attention-website-http-acceptance-v1`
- `TEST_WEBSITE_AGENT_DATABASE_URL`: owner URL, user `postgres`.
- `TEST_WEBSITE_AGENT_RUNTIME_DATABASE_URL`: same host, port and database, user
  `attention_web_runtime`, with that disposable cluster's synthetic password.

The caller must provision that runtime role's password on the disposable cluster.
CI already does so before this step. The suite does not change cluster-wide role
passwords, and it must not be pointed at a newly created database on a production
cluster.

The database name must match `attention_website_http_test` or that prefix plus
underscore-separated lowercase alphanumeric suffixes. Both URLs must have
passwords and no query parameters/fragments. Before migration, the suite verifies
PostgreSQL 17, zero user tables, and a database COMMENT exactly equal to the
disposable marker. It refuses mismatched or unmarked databases before writing.
Use only a dedicated ephemeral cluster/test database. No production credentials,
environment files, user data, or deployed services are needed.

Typecheck with `pnpm exec tsc --project tests/integration/website-agent-http.tsconfig.json`.
Run `pnpm exec vitest run tests/integration/website-agent-http-guard.test.ts
tests/integration/website-agent-http.test.ts` with those variables. Without the
dedicated owner URL, database cases are explicitly skipped; that is not a pass.
The caller owns deletion of the entire disposable service/database afterward.

## Limits

This is an authenticated HTTP-handler integration test, not a network-listening
Next server, browser cookie-jar, proxy, TLS, login UI or production migration test.
It uses real request cookies and auth resolution but issues synthetic sessions
directly rather than sending login emails. Provider/model/tool services remain
offline. Browser component checks and the broader unit suite are separate.
