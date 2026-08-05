# Attention Staging Deployment Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a versioned, testable deployment bundle that lets an administrator deploy Attention staging beside the existing Novelty QA stack without sharing ports, databases, volumes, secrets, or Compose resources.

**Architecture:** Attention runs as the existing `postgres`, `fetcher`, `web`, and `worker` services under Compose project `attention-staging`. The Web service binds only to `127.0.0.1:9199`; a host Nginx virtual host exposes `attention-staging.noveltystudio.cn` over HTTPS. Source lives at `/opt/attention-staging/app`, secrets at `/etc/attention-staging/compose.env`, and PostgreSQL data/backups on `/data/attention-staging`.

**Tech Stack:** Docker 29, Docker Compose 5, PostgreSQL 17.6, Node.js 24.11.1, Next.js standalone, Nginx, Certbot, Bash, Vitest.

## Global Constraints

- Do not modify or stop the existing Novelty QA service on host port `9099`.
- Do not use the host PostgreSQL listener on `0.0.0.0:5432`; Attention PostgreSQL remains Compose-internal with no published port.
- Treat public reachability of host port `5432` as a hard deployment blocker until the Alibaba Cloud security group is corrected.
- Never commit, print, or copy real API keys, database passwords, or application secrets into logs.
- The Resend key previously pasted into chat must be revoked; staging accepts only a newly rotated key stored outside the repository.
- Staging email uses the single neutral `login-code-attention` template with `verification_code` and `valid_minutes` variables.
- First staging deployment keeps digests and WeChat disabled.
- Deployment commands must always use Compose project `attention-staging` and both the base and staging Compose files.
- Build on the 4-core/8-GB ECS serially to avoid starving Novelty QA.
- Never use `docker compose down -v`, `docker volume rm`, or `docker system prune` in deployment or rollback scripts.
- Do not modify frontend files in this workstream.

---

### Task 1: Executable deployment contract tests

**Files:**
- Create: `tests/staging-deployment.test.ts`

**Interfaces:**
- Consumes: repository deployment artifacts as files and executable shell programs.
- Produces: regression coverage for isolation, environment generation, validation, backup naming, and public-surface checks.

- [ ] **Step 1: Write failing tests for the missing staging bundle**

  The tests execute shell scripts in temporary directories and assert observable exit codes and filesystem effects. They must cover: generated file mode `0600`; refusal to overwrite; placeholder rejection; correct Compose project/domain/loopback port; no PostgreSQL port publication; and failure when public port `5432` is reachable.

- [ ] **Step 2: Run the focused test and verify RED**

  Run: `pnpm test tests/staging-deployment.test.ts`

  Expected: FAIL because `deploy/staging` artifacts do not exist.

- [ ] **Step 3: Keep the tests independent of Docker availability**

  Use temporary fixtures and injected command paths for the environment/public-port scripts. Docker-specific rendering remains a separate CI gate.

### Task 2: Staging Compose and environment generator

**Files:**
- Create: `deploy/staging/compose.staging.yaml`
- Create: `deploy/staging/compose.env.example`
- Create: `deploy/staging/generate-env.sh`
- Create: `deploy/staging/validate-env.sh`
- Modify: `compose.yaml`
- Modify: `.env.compose.example`

**Interfaces:**
- Consumes: `openssl`, a target environment-file path, and the existing root `compose.yaml`.
- Produces: a root-readable `0600` environment file and an overlay that tags release images, binds Web to loopback, places PostgreSQL data on `/data`, rotates logs, and caps runtime resources.

- [ ] **Step 1: Implement one-time environment generation**

  `generate-env.sh [target]` uses `umask 077`, refuses existing targets, generates independent hexadecimal passwords/secrets with `openssl rand -hex 32`, builds matching PostgreSQL DSNs, and leaves only external provider values as explicit `replace-me` placeholders.

- [ ] **Step 2: Implement fail-closed validation**

  `validate-env.sh <env-file>` rejects missing files, permissions broader than `0600`, any `replace-me`, non-Resend/console production email providers, wrong origin, digest enablement, a non-loopback bind, wrong port, or secrets shorter than 32 characters. It reports variable names only, never values.

- [ ] **Step 3: Add the staging overlay**

  Require `ATTENTION_RELEASE_ID`, tag every locally built application image, store PostgreSQL through `/data/attention-staging/postgres`, and apply bounded log rotation/resource limits without publishing PostgreSQL or Fetcher.

- [ ] **Step 4: Pass the invite quota through Compose**

  Add `ATTENTION_CONSUMER_INVITE_QUOTA=${ATTENTION_CONSUMER_INVITE_QUOTA:-1}` to Web and both example files.

- [ ] **Step 5: Run focused tests and verify GREEN**

  Run: `pnpm test tests/staging-deployment.test.ts tests/compose-email-config.test.ts`

### Task 3: Safe deployment, backup, smoke, and rollback scripts

**Files:**
- Create: `deploy/staging/lib.sh`
- Create: `deploy/staging/preflight.sh`
- Create: `deploy/staging/deploy.sh`
- Create: `deploy/staging/backup.sh`
- Create: `deploy/staging/restore-drill.sh`
- Create: `deploy/staging/smoke-test.sh`
- Create: `deploy/staging/rollback-app.sh`
- Create: `deploy/staging/check-public-surface.sh`

**Interfaces:**
- Consumes: a clean Git checkout, `/etc/attention-staging/compose.env`, Docker/Compose, and optional prior release ID.
- Produces: serial image builds, pre-migration custom-format backups, isolated restore proof, one-way migrations, healthy services, release records, non-destructive application rollback, and external network validation.

- [ ] **Step 1: Implement shared Compose invocation**

  `lib.sh` fixes project name, Compose file order, env location, state paths, and release tag derivation. It must never print expanded Compose configuration.

- [ ] **Step 2: Implement server preflight**

  Check clean Git state, Docker/Compose versions, free disk/memory, port `9199`, required directories, environment validity, and rendered Compose validity. Abort rather than modifying another stack.

- [ ] **Step 3: Implement database backup**

  Stream `pg_dump --format=custom` from the Compose PostgreSQL service to a mode-`0600` timestamped file under `/data/attention-staging/backups`; validate non-empty output and retain no more than 14 successful staging backups.

- [ ] **Step 3a: Prove each upgrade backup restores before migration**

  Restore the custom-format dump into a disposable PostgreSQL 17 container with no published ports or external network, verify the required Attention schema, and clean up only the explicitly named temporary container and volume.

- [ ] **Step 4: Implement deployment order**

  Preflight, pull pinned base images, build application targets serially, start PostgreSQL, back up when initialized, prove the backup restores, run migrations, set runtime passwords, start services with `--wait`, run loopback smoke tests, and atomically record current/previous release IDs.

- [ ] **Step 5: Implement application-only rollback**

  Require an explicit prior release ID, reuse already-built images with `--no-build`, never touch the database or volumes, and clearly fail if images are missing. Database restore remains an operator procedure because migrations are forward-only.

- [ ] **Step 6: Implement external public-surface gate**

  From a separate machine, require public `80/443`, fail on reachable `5432` or `9199`, and warn (without blocking) when the pre-existing QA port `9099` remains public.

### Task 4: Nginx, TLS bootstrap, and operator runbook

**Files:**
- Create: `deploy/staging/nginx/attention-staging.conf`
- Create: `deploy/staging/RUNBOOK.md`
- Modify: `docs/deployment.md`

**Interfaces:**
- Consumes: DNS A record, administrator access, Nginx/Certbot, and the staging loopback service.
- Produces: an HTTP bootstrap virtual host that Certbot can convert to HTTPS, authenticated-source header replacement, rate limits, exact deploy/verify/rollback commands, and manual gates for Alibaba Cloud.

- [ ] **Step 1: Add a directly installable Nginx virtual host**

  Use `attention-staging.noveltystudio.cn`, proxy only to `127.0.0.1:9199`, overwrite `X-Attention-Client-Source`, preserve Host/scheme, rate-limit auth/OAuth, and avoid proxying internal service ports.

- [ ] **Step 2: Document TLS bootstrap**

  Install and validate the HTTP config, then run Certbot with an operator-owned email, automatic redirect, renewal timer verification, and an HTTPS health check.

- [ ] **Step 3: Document security-group rules and evidence**

  Permit public `80/443`, restrict `22` to administrator sources, remove public `5432`, keep `9199` closed, and explicitly record the current `9099` exception for Novelty QA.

- [ ] **Step 4: Document Resend activation and synthetic login test**

  Require a rotated API key, verified sender domain, published neutral template, and a test recipient supplied only at verification time.

### Task 5: CI deployment-artifact gates

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: example environment, Compose overlay, Nginx config, and shell scripts.
- Produces: syntax checks, Compose rendering, Nginx validation, and builds for all production image targets.

- [ ] **Step 1: Validate shell syntax and staging behavior tests**

  Run `bash -n deploy/staging/*.sh` and the Vitest suite.

- [ ] **Step 2: Render the full staging Compose model**

  Create a temporary PostgreSQL data directory, set `ATTENTION_RELEASE_ID=ci`, and run both Compose files with `config --quiet` without printing secrets.

- [ ] **Step 3: Validate the staging Nginx config**

  Mount the file into the pinned Nginx container and run `nginx -t`.

- [ ] **Step 4: Build every application image target**

  Build Web, Worker, Fetcher, Migrate, and WeChat Adapter in CI so staging cannot be the first place a target is compiled.

### Task 6: Full verification and handoff

**Files:**
- Verify only; no new production files.

**Interfaces:**
- Consumes: completed staging bundle.
- Produces: evidence-backed deployability report and the exact remaining administrator actions.

- [ ] **Step 1: Run focused deployment tests**

  Run: `pnpm test tests/staging-deployment.test.ts tests/compose-email-config.test.ts`

- [ ] **Step 2: Run repository verification**

  Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build && git diff --check`

- [ ] **Step 3: Run available local syntax checks**

  Run: `bash -n deploy/staging/*.sh`. If Docker is unavailable locally, record that exact limitation and rely on the CI/server preflight rather than claiming Compose runtime validation.

- [ ] **Step 4: Review the final diff for frontend isolation and secret safety**

  Confirm no frontend file was modified by this workstream and no real secret appears in tracked changes.

- [ ] **Step 5: Deliver administrator checklist**

  Provide the security-group fix, DNS change, rotated Resend/template prerequisites, source commit/push gate, directory bootstrap, deploy command, acceptance checks, and application-only rollback command.
