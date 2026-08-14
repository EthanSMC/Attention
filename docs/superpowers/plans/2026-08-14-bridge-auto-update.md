# Bridge Auto-update Implementation Plan

> Execute in the isolated `feat/bridge-auto-update` worktree with strict TDD.

## Task 1: Publish a strict update contract

1. Add RED tests for manifest schema, semantic-version comparison, exact origin,
   and permission-profile hashing.
2. Implement the canonical permission profile and manifest parser.
3. Extend the CLI artifact generator and bump the CLI version to 0.3.5.
4. Regenerate the public artifact and prove drift checks pass.

## Task 2: Add managed installation and launcher rollback

1. Add RED tests that execute the real generated launcher against temporary
   artifacts and state.
2. Implement atomic managed layout/state writes with 0700/0600 permissions.
3. Make background service plans run the stable launcher.
4. Prove restart-to-new-version, healthy commit, crash rollback, and startup
   timeout behavior without touching real user services.

## Task 3: Add the Bridge update checker

1. Add RED tests for network failure, redirect/origin rejection, size cap, bad
   digest, bad probe, permission change, major change, successful staging, and
   queue deferral.
2. Implement bounded fetch/download/probe/stage behavior.
3. Integrate the check after Bridge readiness and at the 24-hour jittered cadence.
4. Return the launcher restart exit code only after durable queues are empty.

## Task 4: Add local and Web observability

1. Add RED tests for privacy-safe `channel status` update projection.
2. Include reported adapter version in the existing device projection.
3. Compare it with the public manifest on the connections page and render the
   three version states using the existing design system.
4. Add responsive component coverage without changing navigation or adding a new
   settings section.

## Task 5: Documentation, verification, and release

1. Update the public install guide with the one-time bootstrap boundary and update
   policy.
2. Run focused RED/GREEN suites, full Vitest, all typechecks, full lint, builds,
   artifact checks, and `git diff --check`.
3. Inspect the release diff for generated artifacts, permissions, privacy, and
   compatibility claims.
4. Commit, push, open a PR against `main`, verify CI, squash-merge, and verify the
   merged commit on `origin/main`.

