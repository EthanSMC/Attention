# Website Agent component browser acceptance

This suite bundles and mounts the production `WebsiteAgentConsole` React component,
its production state helper, real Next `Link`, and the current global stylesheet.
It does not reproduce the component with fixture HTML. Only the page wrapper,
an unmount control, AbortSignal observations, and backend HTTP responses are
synthetic. No application server, database, member account, model key, provider
request, or real user data is used.

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
pnpm exec playwright install --with-deps chromium
pnpm exec playwright test --config tests/e2e/website-agent.playwright.config.ts
```

The dedicated config enables Chromium's sandbox. Use a runner that supports it;
do not disable the sandbox, change host security settings, or add elevated
container privileges to turn a blocked launch into a pass. Browser installation
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

Passing this suite validates component behavior in Chromium against a synthetic
backend. It is not proof of HTTP authentication, database RLS, provider behavior,
production configuration, or the complete authenticated application shell.
Discovery, bundling, lint and typecheck results are not browser execution results.
