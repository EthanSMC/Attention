# Website Agent component browser acceptance

This suite bundles and mounts the production `WebsiteAgentConsole` React component,
its production state helper, real Next `Link`, and the current global stylesheet.
It does not reproduce the component with fixture HTML. Only the page wrapper,
an unmount control, AbortSignal observations, and backend HTTP responses are
synthetic. No application server, database, member account, model key, provider
request, or real user data is used.

Reviewed-action metadata is shared with production through a type-only import.
The browser bundle's esbuild input graph must contain no `src/server/` module;
bundling fails if a server implementation crosses this boundary. A fixed wall
clock keeps proposal expiry dates deterministic while ordinary timers keep running.

Playwright fulfills every permitted request in process on the reserved
`https://attention-ui.example.test` origin. Unexpected requests are blocked and
fail the test. There is no listener, public preview, open host port, or external
test endpoint. The existing CLI workspace supplies esbuild after the normal
lockfile install; no second dependency installation is needed for the fixture.

## Run on a browser-capable runner

```sh
pnpm exec tsc --project tests/e2e/website-agent.tsconfig.json
pnpm exec eslint tests/e2e/website-agent-console.spec.ts tests/e2e/website-agent.playwright.config.ts tests/e2e/fixtures/website-agent-fixture.ts
pnpm exec playwright test --config tests/e2e/website-agent.playwright.config.ts --list
pnpm exec playwright test --config tests/e2e/website-agent.playwright.config.ts
```

On GitHub-hosted Ubuntu 24.04, CI uses the preinstalled official Google Chrome
with Playwright `channel: "chrome"`. Ubuntu already provides an AppArmor profile
for `/opt/google/chrome/chrome`; the workflow checks that binary and profile
without modifying either. Downloaded Playwright Chromium was blocked by the
runner's user-namespace restrictions before any application assertion. The Chrome
route must still pass the actual CI run; binary presence alone is not acceptance.

Outside CI, install the matching Playwright Chromium on a sandbox-capable runner
with `pnpm exec playwright install --with-deps chromium`. The dedicated config
enables Chromium's sandbox in both cases. Use a runner that supports it;
do not disable the sandbox, change host security settings, or add elevated
container privileges to turn a blocked launch into a pass. There is no insecure
fallback. Browser installation
is a runner provisioning step, not an application or production deployment.

All test artifacts, including failure traces/screenshots, JUnit output and mobile
screenshots, are under `output/playwright/website-agent-console/`. Upload that
directory with the CI workflow's normal artifact action, even on failure.

## Coverage and limits

The suite covers session creation, required consent and payload flags, session
selection, deep links outside the list page and missing deep links, reconnecting
to a pending session without resubmitting, close/reload, same-turn duplicate
submit events, stale revision and old-session polls, cancellation and a later
submission, unmount during initial loading/query/polling, interval cleanup, and
320/375/390-pixel layouts with long content. It observes actual fetch abort
signals. A canceled response may be rejected by the browser transport; the suite
does not claim that every intentionally late response reached React.

The expanded suite contains 39 cases: the initial 16 session/composer cases and
23 reviewed-action cases. Action coverage includes exact literal details and
consequences, separate explicit approval, exact session/action endpoint and
revision/hash-only payloads, same-turn duplicate-confirm exclusion, decline,
completed/unknown/expired/executing states, timer and click-time expiry, polling
executing actions without a model run, fresh consent after revision/session
changes, stale poll and refresh/selection responses, unmount during decisions,
wrong-session replies, uncertainty/expiry reconciliation without effect retry,
and three mobile widths with long review values. Every captured decision request
is checked for the allowed key set, so neither initial approval nor replay can
send replacement tool arguments.

Passing this suite validates component behavior in Chromium against a synthetic
backend. It is not proof of HTTP authentication, database RLS, provider behavior,
production configuration, or the complete authenticated application shell.
Discovery, bundling, lint and typecheck results are not browser execution results.
