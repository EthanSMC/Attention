import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const staging = resolve(root, "deploy/staging");

function run(script: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", [resolve(staging, script), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function parseEnv(source: string): Record<string, string> {
  return Object.fromEntries(
    source
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        if (separator < 1) throw new Error(`Invalid env line: ${line}`);
        const key = line.slice(0, separator);
        const raw = line.slice(separator + 1);
        const value = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
        return [key, value];
      }),
  );
}

function createCompletedEnvironment(directory: string): string {
  const target = resolve(directory, "compose.env");
  expect(run("generate-env.sh", [target]).status).toBe(0);
  const source = readFileSync(target, "utf8").replace(
    /^RESEND_API_KEY=.*$/mu,
    "RESEND_API_KEY=re_staging_test_only_not_a_real_key_1234567890",
  );
  writeFileSync(target, source, { mode: 0o600 });
  return target;
}

describe("staging environment preparation", () => {
  it("generates an isolated mode-0600 staging environment exactly once", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "attention-staging-env-"));
    const target = resolve(directory, "compose.env");

    const generated = run("generate-env.sh", [target]);
    expect(generated.status, generated.stderr).toBe(0);
    expect(statSync(target).mode & 0o777).toBe(0o600);

    const values = parseEnv(readFileSync(target, "utf8"));
    expect(values).toMatchObject({
      ATTENTION_DIGEST_WORKER_ENABLED: "false",
      ATTENTION_EMAIL_PROVIDER: "resend",
      ATTENTION_MIGRATION_DATABASE_HOST: "postgres",
      ATTENTION_MIGRATION_DATABASE_NAME: "attention_staging",
      ATTENTION_MIGRATION_DATABASE_ROLE: "attention_migration_owner",
      ATTENTION_POSTGRES_DATA_PATH: "/data/attention-staging/postgres",
      ATTENTION_RESEND_TEMPLATE_ID: "login-code-attention",
      COMPOSE_PROJECT_NAME: "attention-staging",
      NEXT_PUBLIC_APP_URL: "https://attention-staging.noveltystudio.cn",
      WEB_BIND_ADDRESS: "127.0.0.1",
      WEB_PUBLISH_PORT: "9199",
    });

    const independentSecrets = [
      values.POSTGRES_PASSWORD,
      values.ATTENTION_WEB_DATABASE_PASSWORD,
      values.ATTENTION_WORKER_DATABASE_PASSWORD,
      values.ATTENTION_HMAC_SECRET,
      values.ATTENTION_AUTH_SECRET,
      values.ATTENTION_CHANNEL_SECRET,
      values.ATTENTION_CHANNEL_ADAPTER_SECRET,
      values.FETCHER_SHARED_SECRET,
    ];
    expect(independentSecrets.every((secret) => /^[a-f0-9]{64}$/u.test(secret))).toBe(true);
    expect(new Set(independentSecrets).size).toBe(independentSecrets.length);
    expect(values.DATABASE_URL).toContain(values.ATTENTION_WEB_DATABASE_PASSWORD);
    expect(values.WORKER_DATABASE_URL).toContain(values.ATTENTION_WORKER_DATABASE_PASSWORD);
    expect(values.MIGRATION_DATABASE_URL).toContain(values.POSTGRES_PASSWORD);

    const firstContents = readFileSync(target, "utf8");
    const repeated = run("generate-env.sh", [target]);
    expect(repeated.status).not.toBe(0);
    expect(readFileSync(target, "utf8")).toBe(firstContents);
  });

  it("keeps the reviewable staging example in sync with generated keys", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "attention-staging-keys-"));
    const target = resolve(directory, "compose.env");
    expect(run("generate-env.sh", [target]).status).toBe(0);

    const generatedKeys = Object.keys(parseEnv(readFileSync(target, "utf8"))).sort();
    const exampleKeys = Object.keys(
      parseEnv(readFileSync(resolve(staging, "compose.env.example"), "utf8")),
    ).sort();
    expect(exampleKeys).toEqual(generatedKeys);
  });

  it("validates a completed environment without printing secret values", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "attention-staging-valid-"));
    const target = resolve(directory, "compose.env");
    expect(run("generate-env.sh", [target]).status).toBe(0);

    const incomplete = run("validate-env.sh", [target]);
    expect(incomplete.status).not.toBe(0);
    expect(`${incomplete.stdout}${incomplete.stderr}`).toContain("RESEND_API_KEY");

    const source = readFileSync(target, "utf8").replace(
      /^RESEND_API_KEY=.*$/mu,
      "RESEND_API_KEY=re_staging_test_only_not_a_real_key_1234567890",
    );
    writeFileSync(target, source, { mode: 0o600 });
    const valid = run("validate-env.sh", [target]);
    expect(valid.status, valid.stderr).toBe(0);
    expect(`${valid.stdout}${valid.stderr}`).not.toContain(
      "re_staging_test_only_not_a_real_key_1234567890",
    );

    chmodSync(target, 0o644);
    const broadPermissions = run("validate-env.sh", [target]);
    expect(broadPermissions.status).not.toBe(0);
    expect(`${broadPermissions.stdout}${broadPermissions.stderr}`).toContain("0600");

    chmodSync(target, 0o600);
    const link = resolve(directory, "compose-link.env");
    symlinkSync(target, link);
    const symlinked = run("validate-env.sh", [link]);
    expect(symlinked.status).not.toBe(0);
    expect(`${symlinked.stdout}${symlinked.stderr}`).toContain("symlink");
  });

  it("rejects a runtime DSN whose query only looks like the isolated database", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "attention-staging-dsn-"));
    const target = createCompletedEnvironment(directory);
    const unsafe = readFileSync(target, "utf8").replace(
      /^DATABASE_URL=.*$/mu,
      "DATABASE_URL=postgresql://attention_web_runtime:not-real@evil.example:5432/wrong?next=@postgres:5432/attention_staging",
    );
    writeFileSync(target, unsafe, { mode: 0o600 });

    const validation = run("validate-env.sh", [target]);
    expect(validation.status).not.toBe(0);
    expect(`${validation.stdout}${validation.stderr}`).toContain("DATABASE_URL");
    expect(`${validation.stdout}${validation.stderr}`).not.toContain("not-real");
  });

  it("rejects duplicate keys and a mismatched ingress-owned source header", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "attention-staging-duplicate-"));
    const target = createCompletedEnvironment(directory);
    writeFileSync(
      target,
      `${readFileSync(target, "utf8")}WEB_PUBLISH_PORT=9999\n`,
      { mode: 0o600 },
    );
    const duplicate = run("validate-env.sh", [target]);
    expect(duplicate.status).not.toBe(0);
    expect(`${duplicate.stdout}${duplicate.stderr}`).toContain("WEB_PUBLISH_PORT");

    const headerTarget = resolve(directory, "header.env");
    expect(run("generate-env.sh", [headerTarget]).status).toBe(0);
    const unsafeHeader = readFileSync(headerTarget, "utf8")
      .replace(
        /^RESEND_API_KEY=.*$/mu,
        "RESEND_API_KEY=re_staging_test_only_not_a_real_key_1234567890",
      )
      .replace(
        /^ATTENTION_TRUSTED_CLIENT_SOURCE_HEADER=.*$/mu,
        "ATTENTION_TRUSTED_CLIENT_SOURCE_HEADER=x-client-controlled",
      );
    writeFileSync(headerTarget, unsafeHeader, { mode: 0o600 });
    const mismatchedHeader = run("validate-env.sh", [headerTarget]);
    expect(mismatchedHeader.status).not.toBe(0);
    expect(`${mismatchedHeader.stdout}${mismatchedHeader.stderr}`).toContain(
      "ATTENTION_TRUSTED_CLIENT_SOURCE_HEADER",
    );
  });
});

describe("staging database backup", () => {
  it("creates a verified mode-0600 custom dump and retains fourteen dumps", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "attention-staging-backup-"));
    const envFile = createCompletedEnvironment(directory);
    const backupDirectory = resolve(directory, "backups");
    const stateDirectory = resolve(directory, "state");
    mkdirSync(backupDirectory, { mode: 0o700 });
    mkdirSync(stateDirectory, { mode: 0o700 });
    for (let index = 0; index < 14; index += 1) {
      writeFileSync(
        resolve(backupDirectory, `attention-staging-20260101T0000${String(index).padStart(2, "0")}Z.dump`),
        "old-dump",
        { mode: 0o600 },
      );
    }

    const fakeDocker = resolve(directory, "docker");
    writeFileSync(
      fakeDocker,
      [
        "#!/usr/bin/env bash",
        "printf '%s\\n' \"$*\" >>\"$ATTENTION_FAKE_DOCKER_LOG\"",
        "case \" $* \" in",
        "  *\" exec -T postgres \"*) printf 'PGDMP-test-backup' ;;",
        "  *) exit 0 ;;",
        "esac",
      ].join("\n"),
      { mode: 0o755 },
    );
    const fakeRestore = resolve(directory, "pg_restore");
    writeFileSync(fakeRestore, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    const fakeFlock = resolve(directory, "flock");
    writeFileSync(fakeFlock, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    const dockerLog = resolve(directory, "docker.log");

    const backedUp = run("backup.sh", [], {
      ATTENTION_BACKUP_DIR: backupDirectory,
      ATTENTION_DOCKER_BIN: fakeDocker,
      ATTENTION_ENV_FILE: envFile,
      ATTENTION_FAKE_DOCKER_LOG: dockerLog,
      ATTENTION_FLOCK_BIN: fakeFlock,
      ATTENTION_PG_RESTORE_BIN: fakeRestore,
      ATTENTION_RELEASE_ID: "0123456789ab",
      ATTENTION_STATE_DIR: stateDirectory,
    });
    expect(backedUp.status, backedUp.stderr).toBe(0);

    const dumps = readdirSync(backupDirectory).filter((name) => name.endsWith(".dump"));
    expect(dumps).toHaveLength(14);
    const latest = dumps.sort().at(-1);
    expect(latest).toBeDefined();
    expect(statSync(resolve(backupDirectory, latest!)).mode & 0o777).toBe(0o600);
    expect(readFileSync(resolve(backupDirectory, latest!), "utf8")).toBe(
      "PGDMP-test-backup",
    );
    expect(readFileSync(resolve(directory, "docker.log"), "utf8")).toContain(
      "exec -T postgres",
    );

    const repeated = run("backup.sh", [], {
      ATTENTION_BACKUP_DIR: backupDirectory,
      ATTENTION_DOCKER_BIN: fakeDocker,
      ATTENTION_ENV_FILE: envFile,
      ATTENTION_FAKE_DOCKER_LOG: dockerLog,
      ATTENTION_FLOCK_BIN: fakeFlock,
      ATTENTION_PG_RESTORE_BIN: fakeRestore,
      ATTENTION_RELEASE_ID: "0123456789ab",
      ATTENTION_STATE_DIR: stateDirectory,
    });
    expect(repeated.status, repeated.stderr).toBe(0);
    expect(repeated.stdout.trim()).not.toBe(backedUp.stdout.trim());
  });

  it("restores in an isolated temporary container and cleans up on failure", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "attention-staging-restore-"));
    const dump = resolve(directory, "backup.dump");
    writeFileSync(dump, "PGDMP-test-backup", { mode: 0o600 });
    const dockerLog = resolve(directory, "docker.log");
    const fakeDocker = resolve(directory, "docker");
    writeFileSync(
      fakeDocker,
      [
        "#!/usr/bin/env bash",
        "printf '%s\\n' \"$*\" >>\"$ATTENTION_FAKE_DOCKER_LOG\"",
        "if [[ \"$*\" == *\"pg_restore\"* && \"${ATTENTION_FAKE_RESTORE_FAIL:-}\" == 1 ]]; then exit 1; fi",
        "if [[ \"$*\" == *\"to_regclass('public.accounts')\"* ]]; then printf 't\\n'; fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const restored = run("restore-drill.sh", [dump], {
      ATTENTION_DOCKER_BIN: fakeDocker,
      ATTENTION_FAKE_DOCKER_LOG: dockerLog,
    });
    expect(restored.status, restored.stderr).toBe(0);
    const successLog = readFileSync(dockerLog, "utf8");
    expect(successLog).toContain("--network none");
    expect(successLog).toContain("container rm --force attention-staging-restore-drill-");
    expect(successLog).toContain("volume rm attention-staging-restore-drill-");
    expect(successLog).not.toMatch(/\b(?:prune|down)\b/u);

    writeFileSync(dockerLog, "");
    const failed = run("restore-drill.sh", [dump], {
      ATTENTION_DOCKER_BIN: fakeDocker,
      ATTENTION_FAKE_DOCKER_LOG: dockerLog,
      ATTENTION_FAKE_RESTORE_FAIL: "1",
    });
    expect(failed.status).not.toBe(0);
    const failureLog = readFileSync(dockerLog, "utf8");
    expect(failureLog).toContain("container rm --force attention-staging-restore-drill-");
    expect(failureLog).toContain("volume rm attention-staging-restore-drill-");
  });
});

describe("staging deployment order", () => {
  it("proves the pre-migration backup restores before applying migrations", () => {
    const source = readFileSync(resolve(staging, "deploy.sh"), "utf8");
    const backup = source.indexOf(
      'backup_path=$("$ATTENTION_STAGING_DIR/backup.sh" --operation-lock-held)',
    );
    const restore = source.indexOf(
      '"$ATTENTION_STAGING_DIR/restore-drill.sh" "$backup_path"',
    );
    const migrate = source.indexOf(
      "attention_compose --profile tools run --no-deps --rm migrate",
    );

    expect(backup).toBeGreaterThan(-1);
    expect(restore).toBeGreaterThan(backup);
    expect(migrate).toBeGreaterThan(restore);
    expect(source.indexOf("attention_compose build")).toBeGreaterThan(restore);
    expect(source.indexOf("attention_compose pull")).toBeGreaterThan(restore);
    expect(source).toContain("attention_acquire_operation_lock");
    expect(source).toContain("--profile tools run --no-deps --rm migrate");
  });

  it("keeps the release checkout owned by the same root identity that runs deploy", () => {
    const runbook = readFileSync(resolve(staging, "RUNBOOK.md"), "utf8");

    expect(runbook).not.toContain("attention_deploy_user");
    expect(runbook).toContain(
      "sudo install -d -o root -g root -m 0755 /opt/attention-staging/app",
    );
    expect(runbook).toContain(
      "sudo git -C /opt/attention-staging/app rev-parse --verify HEAD",
    );
  });

  it("uses the same host-level operation lock for deploy and rollback", () => {
    const library = readFileSync(resolve(staging, "lib.sh"), "utf8");
    const rollback = readFileSync(resolve(staging, "rollback-app.sh"), "utf8");

    expect(library).toContain("operation.lock");
    expect(library).toContain('"$flock_bin" -n');
    expect(rollback).toContain("attention_acquire_operation_lock");
  });
});

describe("staging application rollback", () => {
  it("switches only application images and records release state after health succeeds", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "attention-staging-rollback-"));
    const envFile = createCompletedEnvironment(directory);
    const stateDirectory = resolve(directory, "state");
    mkdirSync(stateDirectory, { mode: 0o700 });
    writeFileSync(resolve(stateDirectory, "current-release"), "fedcba987654\n");
    writeFileSync(resolve(stateDirectory, "previous-release"), "0123456789ab\n");
    writeFileSync(resolve(stateDirectory, "current-schema-head"), "1785937200000\n");
    writeFileSync(resolve(stateDirectory, "previous-schema-head"), "1785937200000\n");

    const journal = JSON.parse(
      readFileSync(resolve(root, "packages/db/drizzle/meta/_journal.json"), "utf8"),
    ) as { entries: Array<{ when: number }> };
    const expectedCount = String(journal.entries.length);
    const expectedHead = String(Math.max(...journal.entries.map((entry) => entry.when)));

    const dockerLog = resolve(directory, "docker.log");
    const fakeDocker = resolve(directory, "docker");
    writeFileSync(
      fakeDocker,
      [
        "#!/usr/bin/env bash",
        "printf '%s\\n' \"$*\" >>\"$ATTENTION_FAKE_DOCKER_LOG\"",
        "case \"$*\" in",
        "  *\"ps --filter publish=9099 \"*) printf 'qa-container-id\\n' ;;",
        "  *\"SELECT count(*), max(created_at)\"*) printf '%s|%s\\n' \"$EXPECTED_MIGRATION_COUNT\" \"$EXPECTED_MIGRATION_HEAD\" ;;",
        "  *\"SELECT max(created_at)\"*) printf '%s\\n' \"$EXPECTED_MIGRATION_HEAD\" ;;",
        "  *\"FROM pg_roles\"*) printf 't\\n' ;;",
        "esac",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    const fakeCurl = resolve(directory, "curl");
    writeFileSync(fakeCurl, "#!/usr/bin/env bash\nprintf '{\"status\":\"ok\"}'\n", {
      mode: 0o755,
    });
    const fakeFlock = resolve(directory, "flock");
    writeFileSync(fakeFlock, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

    const rollbackEnvironment = {
      ATTENTION_CURL_BIN: fakeCurl,
      ATTENTION_DOCKER_BIN: fakeDocker,
      ATTENTION_ENV_FILE: envFile,
      ATTENTION_FAKE_DOCKER_LOG: dockerLog,
      ATTENTION_FLOCK_BIN: fakeFlock,
      ATTENTION_STATE_DIR: stateDirectory,
      EXPECTED_MIGRATION_COUNT: expectedCount,
      EXPECTED_MIGRATION_HEAD: expectedHead,
    };

    writeFileSync(resolve(stateDirectory, "previous-schema-head"), "1785933600000\n");
    const incompatible = run(
      "rollback-app.sh",
      ["0123456789ab"],
      rollbackEnvironment,
    );
    expect(incompatible.status).not.toBe(0);
    expect(`${incompatible.stdout}${incompatible.stderr}`).toContain(
      "database schema advanced",
    );

    writeFileSync(resolve(stateDirectory, "previous-schema-head"), `${expectedHead}\n`);
    writeFileSync(dockerLog, "");
    const rolledBack = run("rollback-app.sh", ["0123456789ab"], rollbackEnvironment);
    expect(rolledBack.status, rolledBack.stderr).toBe(0);
    expect(readFileSync(resolve(stateDirectory, "current-release"), "utf8").trim()).toBe(
      "0123456789ab",
    );
    expect(readFileSync(resolve(stateDirectory, "previous-release"), "utf8").trim()).toBe(
      "fedcba987654",
    );

    const invocations = readFileSync(dockerLog, "utf8");
    expect(invocations).toContain("image inspect attention-staging-web:0123456789ab");
    expect(invocations).toContain("--no-build");
    expect(invocations).toContain("fetcher web worker");
    expect(invocations).not.toMatch(/\b(down|prune|migrate|runtime-role-passwords)\b/u);
  });
});

describe("staging release source gate", () => {
  it("accepts only a clean Git commit containing every deployment migration", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "attention-staging-source-"));
    const requiredFiles = [
      "Dockerfile",
      "compose.yaml",
      "pnpm-lock.yaml",
      "packages/db/drizzle/0015_account_avatar.sql",
      "packages/db/drizzle/0016_attention_id.sql",
      "packages/db/drizzle/0017_consumer_invite_quota.sql",
      "packages/db/drizzle/0018_schema_checkpoint.sql",
      "packages/db/drizzle/meta/0018_snapshot.json",
      "packages/db/drizzle/meta/_journal.json",
    ];
    for (const file of requiredFiles) {
      const path = resolve(directory, file);
      mkdirSync(resolve(path, ".."), { recursive: true });
      writeFileSync(path, `${file}\n`);
    }
    for (const args of [
      ["init", "--quiet"],
      ["config", "user.email", "deploy-test@example.invalid"],
      ["config", "user.name", "Deploy Test"],
      ["add", "."],
      ["commit", "--quiet", "-m", "test release"],
    ]) {
      const git = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
      expect(git.status, git.stderr).toBe(0);
    }

    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: directory,
      encoding: "utf8",
    }).stdout.trim();
    const clean = run("validate-release-source.sh", [directory], {
      ATTENTION_EXPECTED_RELEASE_SHA: head,
    });
    expect(clean.status, clean.stderr).toBe(0);

    const wrongCommit = run("validate-release-source.sh", [directory], {
      ATTENTION_EXPECTED_RELEASE_SHA: "0".repeat(40),
    });
    expect(wrongCommit.status).not.toBe(0);
    expect(`${wrongCommit.stdout}${wrongCommit.stderr}`).toContain("reviewed release");

    writeFileSync(resolve(directory, "untracked.txt"), "not released\n");
    const dirty = run("validate-release-source.sh", [directory], {
      ATTENTION_EXPECTED_RELEASE_SHA: head,
    });
    expect(dirty.status).not.toBe(0);
    expect(`${dirty.stdout}${dirty.stderr}`).toContain("clean Git commit");
  });
});

describe("rendered staging Compose validation", () => {
  const validConfig = {
    name: "attention-staging",
    networks: { database: { internal: true } },
    services: {
      fetcher: { networks: { application: null } },
      postgres: { networks: { database: null } },
      web: {
        networks: { application: null, database: null },
        ports: [{ host_ip: "127.0.0.1", published: "9199", target: 3000 }],
      },
      worker: { networks: { application: null, database: null } },
    },
    volumes: {
      postgres_data: {
        name: "attention-staging-postgres-data",
        driver_opts: { device: "/data/attention-staging/postgres" },
      },
    },
  };

  it("accepts only loopback Web and an internal unpublished database", () => {
    const validator = resolve(staging, "validate-compose-config.py");
    const valid = spawnSync(
      "python3",
      [validator, "/data/attention-staging/postgres"],
      { encoding: "utf8", input: JSON.stringify(validConfig) },
    );
    expect(valid.status, valid.stderr).toBe(0);

    const unsafe = structuredClone(validConfig);
    unsafe.services.postgres = {
      ports: [{ host_ip: "0.0.0.0", published: "5432", target: 5432 }],
    } as typeof unsafe.services.postgres;
    const exposedDatabase = spawnSync(
      "python3",
      [validator, "/data/attention-staging/postgres"],
      { encoding: "utf8", input: JSON.stringify(unsafe) },
    );
    expect(exposedDatabase.status).not.toBe(0);
    expect(exposedDatabase.stderr).toContain("PostgreSQL must not publish");

    const extraWebPort = structuredClone(validConfig);
    extraWebPort.services.web.ports.push({
      host_ip: "0.0.0.0",
      published: "9200",
      target: 3000,
    });
    const exposedWeb = spawnSync(
      "python3",
      [validator, "/data/attention-staging/postgres"],
      { encoding: "utf8", input: JSON.stringify(extraWebPort) },
    );
    expect(exposedWeb.status).not.toBe(0);
    expect(exposedWeb.stderr).toContain("exactly one loopback port");

    const workerPort = structuredClone(validConfig);
    workerPort.services.worker = {
      ports: [{ host_ip: "127.0.0.1", published: "9300", target: 9300 }],
    } as typeof workerPort.services.worker;
    const exposedWorker = spawnSync(
      "python3",
      [validator, "/data/attention-staging/postgres"],
      { encoding: "utf8", input: JSON.stringify(workerPort) },
    );
    expect(exposedWorker.status).not.toBe(0);
    expect(exposedWorker.stderr).toContain("Worker must not publish");

    const sharedProject = structuredClone(validConfig);
    sharedProject.name = "attention";
    const wrongProject = spawnSync(
      "python3",
      [validator, "/data/attention-staging/postgres"],
      { encoding: "utf8", input: JSON.stringify(sharedProject) },
    );
    expect(wrongProject.status).not.toBe(0);
    expect(wrongProject.stderr).toContain("Compose project");
  });
});

describe("staging public surface gate", () => {
  it("fails when PostgreSQL is publicly reachable and only warns for Novelty QA", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "attention-staging-net-"));
    const fakeNc = resolve(directory, "nc");
    writeFileSync(
      fakeNc,
      [
        "#!/usr/bin/env bash",
        "port=${!#}",
        "case \" ${OPEN_PORTS:-} \" in",
        "  *\" ${port} \"*) exit 0 ;;",
        "  *) exit 1 ;;",
        "esac",
      ].join("\n"),
      { mode: 0o755 },
    );

    const unsafe = run("check-public-surface.sh", ["203.0.113.10"], {
      ATTENTION_NC_BIN: fakeNc,
      OPEN_PORTS: "80 443 5432 9099",
    });
    expect(unsafe.status).not.toBe(0);
    expect(`${unsafe.stdout}${unsafe.stderr}`).toContain("5432");
    expect(`${unsafe.stdout}${unsafe.stderr}`).toContain("9099");

    const safe = run("check-public-surface.sh", ["203.0.113.10"], {
      ATTENTION_NC_BIN: fakeNc,
      OPEN_PORTS: "80 443 9099",
    });
    expect(safe.status, safe.stderr).toBe(0);
    expect(`${safe.stdout}${safe.stderr}`).toContain("9099");
  });
});

describe("staging reverse proxy", () => {
  it("never writes request paths, queries, or referrers to access logs", () => {
    const source = readFileSync(
      resolve(staging, "nginx/attention-staging.conf"),
      "utf8",
    );

    expect(source).toContain("log_format attention_staging_safe");
    expect(source).toContain("access_log /var/log/nginx/attention-staging.access.log attention_staging_safe;");
    expect(source).not.toMatch(/\$(?:request|request_uri|uri|args|query_string|http_referer)\b/u);
  });
});
