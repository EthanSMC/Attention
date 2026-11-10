# Production standalone HTTP and browser acceptance

This is a small complement to the 43 component cases and the isolated route/PG
suite. It runs the built Next standalone server as a separate Node process on
`127.0.0.1:4179`, with its traced dependencies, public files and `.next/static`.
Clients use `http://localhost:4179`, matching NextRequest's canonical loopback
origin. An IP URL would be normalized to localhost inside Next while its browser
Origin header stayed numeric, correctly failing the unchanged CSRF guard when
the configured build-time public origin differs. The listener stays IPv4
loopback-only; no host/DNS/proxy, browser-security or production guard is changed.
No production source, route handler, authentication function, database store,
React component or browser API response is replaced.

## Exact scope

Two Playwright cases cover:

1. Actual TCP HTTP authentication, session creation, query through native Pi,
   encrypted PostgreSQL persistence, server-process restart, state reload and a
   second native query that must include the earlier conversation.
2. The real `/agent/website` page, Next hydration and assets, browser creation and
   native digest-tool proposal, exact trusted review including a unique verified
   synthetic email, explicit checkbox/confirmation, revision/hash-only approval,
   a real PostgreSQL preference update and persisted completed receipt. A reload
   must not repeat the effect or model call. The test captures the completed card
   at a 390-pixel viewport and checks horizontal overflow.

The second case uses an issued opaque session token in an explicit manual Cookie
header on loopback HTTP. It does **not** prove HTTPS, TLS, browser-managed Secure
cookie acceptance, cookie persistence, login, or a real user's account. The
browser context blocks off-origin requests; actual app responses are never
fulfilled from fixtures. Traces, videos and HAR are disabled, cookies are kept
only in memory, and only synthetic screenshots/JUnit/limit notes are artifacts.
Failed HTTP assertions include only the status and a fixed allowlist of error
codes. Unknown or non-JSON errors are labeled generically; no response bodies,
arbitrary messages, headers, tokens or cookies are printed.

## Offline provider boundary

A test-only Node preload runs before the server entrypoint. It replaces global
fetch with a fail-closed handler accepting only a POST to the exact native
DeepSeek chat-completions endpoint, the fixed synthetic key, the expected model,
streaming protocol and three fixed test prompts. It returns protocol-valid SSE.
Its sole tool proposal has fixed digest arguments. No executable command,
arbitrary tool name, remote script or network passthrough is accepted. It records
only event names, never request bodies, cookie values or credentials.

The child's environment is an explicit allowlist containing only synthetic
secrets, the non-owner test DB URL and loopback address. The digest worker is off;
no email is sent. The preload is never part of the production build. This is a
fetch-level test isolation boundary, not an assertion of OS-level network
isolation. Native Pi's actual provider transport uses that replaced fetch.

## Isolated PostgreSQL fixture

Use a separate new PostgreSQL 17 database named
`attention_website_http_test_production_ci`, with comment
`attention-website-http-acceptance-v1`. The existing disposable-DB guard checks
the marker, exact owner/runtime pairing, role, version and zero user tables
before migration. The additional production guard requires loopback and the
`attention_website_http_test_production*` namespace. Never reuse the ordinary
test DB, the route-suite DB, an existing populated DB, or production.

The fixture applies the actual migrations, checks the runtime role is not
superuser/BYPASSRLS, and issues real synthetic member sessions with the auth
library. It never truncates or drops tables/databases. CI's disposable service
owns DB cleanup. Its temporary standalone copy excludes dotenv files and is
removed after stopping only the spawned server process. Relative pnpm symlinks
are preserved verbatim: dereferencing Next's package link changes Node's lookup
ancestry and breaks its sibling dependencies. Before and after copying, symlinks
must resolve within their packaged tree; absolute, escaping and dotenv/private
configuration links fail closed. Dotenv files, `.git`, `.npmrc` and `.netrc` are
excluded from all copied inputs.

These two cases share one initialized worker/database. The suite stops on its
first failure, with the later case reported as not run, rather than spawning a
replacement worker against the already-migrated database. There is no DB reuse,
guard bypass, retry or pass substitution.

## CI integration after the production build

Use the same preflighted, preinstalled official Chrome as the component suite,
with `chromiumSandbox: true`. There is no sandbox-disabled fallback. After
`pnpm build`, create and mark the new DB (creation must fail if it exists), then:

```sh
pnpm exec tsc --project tests/e2e/website-agent-production.tsconfig.json
pnpm exec vitest run tests/e2e/website-agent-offline-provider.test.ts tests/e2e/website-agent-standalone-copy.test.ts tests/e2e/website-agent-production-http.test.ts
pnpm exec playwright test --config tests/e2e/website-agent-production.playwright.config.ts
```

Required test-process environment:

```text
TEST_WEBSITE_AGENT_DISPOSABLE=attention-website-http-acceptance-v1
TEST_WEBSITE_AGENT_PRODUCTION=attention-website-production-acceptance-v1
TEST_WEBSITE_AGENT_DATABASE_URL=postgresql://postgres:<synthetic-ci-password>@127.0.0.1:5432/attention_website_http_test_production_ci
TEST_WEBSITE_AGENT_RUNTIME_DATABASE_URL=postgresql://attention_web_runtime:<synthetic-ci-runtime-password>@127.0.0.1:5432/attention_website_http_test_production_ci
```

Always preserve `output/playwright/website-agent-production/` with the normal CI
artifact action. Provider/preload guard unit tests, discovery, lint, typechecking
and preload bundling are only static/offline checks; they are not evidence that
the real server or browser acceptance has executed successfully.
