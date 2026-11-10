import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { issueSession, serializeSessionCookie } from "@attention/auth";
import { accounts, createDatabase, entitlements, type DatabaseHandle } from "@attention/db";
import { migrateDatabase } from "@attention/db/migrate";
import { expect, test as base } from "@playwright/test";

import { build } from "../../../apps/cli/node_modules/esbuild/lib/main.js";
import { assertWebsiteHttpTestDatabase, websiteHttpTestDatabaseUrls } from "../../integration/website-agent-http-guard";
import { productionFixtureMarker, providerKey } from "./website-agent-offline-provider";
import { productionOrigin } from "./website-agent-production-http";
import { copyWebsiteStandalone } from "./website-agent-standalone-copy";

export { productionOrigin } from "./website-agent-production-http";
const root = fileURLToPath(new URL("../../../", import.meta.url));
export type SyntheticMember = { accountId: string; cookie: string; email: string };

export class ProductionWebsiteFixture {
  private child: ChildProcess | undefined;
  private temporary = "";
  private runtimeUrl = "";
  private serverLog = "";
  private secrets: string[] = [];
  private owner: DatabaseHandle | undefined;
  get db(): DatabaseHandle {
    if (!this.owner) throw new Error("Production test database is not initialized");
    return this.owner;
  }

  async initialize(): Promise<void> {
    const urls = websiteHttpTestDatabaseUrls(process.env);
    if (process.env.TEST_WEBSITE_AGENT_PRODUCTION !== productionFixtureMarker ||
        new URL(urls.admin).hostname !== "127.0.0.1" ||
        !/^attention_website_http_test_production(?:_[a-z0-9]+)*$/u.test(urls.name)) {
      throw new Error("Production acceptance requires its own marked loopback database");
    }
    this.secrets = [urls.admin, urls.runtime];
    this.runtimeUrl = urls.runtime;
    this.owner = createDatabase(urls.admin, { maxConnections: 3 });
    const [identity] = await this.db.sql<{
      name: string; version: string; marker: string | null; userTables: number;
    }[]>`SELECT current_database() AS name, current_setting('server_version_num') AS version,
      shobj_description(oid, 'pg_database') AS marker,
      (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid
        WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')
        AND n.nspname NOT LIKE 'pg_toast%') AS "userTables"
      FROM pg_database WHERE datname=current_database()`;
    if (!identity) throw new Error("Missing production test database identity");
    assertWebsiteHttpTestDatabase(identity, urls.name);
    await migrateDatabase(this.db.db, join(root, "packages/db/drizzle"));
    const runtime = createDatabase(urls.runtime, { maxConnections: 1 });
    try {
      const [role] = await runtime.sql`SELECT current_user AS name, rolsuper, rolbypassrls
        FROM pg_roles WHERE rolname=current_user`;
      expect(role).toMatchObject({ name: "attention_web_runtime", rolsuper: false, rolbypassrls: false });
    } finally { await runtime.close(); }

    this.temporary = await mkdtemp(join(tmpdir(), "attention-website-production-"));
    const standalone = join(this.temporary, "standalone");
    // Keep Next's traced pnpm package links: flattening changes dependency lookup ancestry.
    await copyWebsiteStandalone({
      standalone: join(root, "apps/web/.next/standalone"), destination: standalone,
      staticFiles: join(root, "apps/web/.next/static"), publicFiles: join(root, "apps/web/public"),
    });
    await build({ entryPoints: [join(root, "tests/e2e/fixtures/website-agent-production-preload.ts")],
      outfile: join(this.temporary, "offline-preload.mjs"), bundle: true, platform: "node", format: "esm", target: "node24" });
    await this.start();
  }

  async start(): Promise<void> {
    if (this.child) throw new Error("Production server already running");
    let ready = false;
    let spawnError = false;
    const child = spawn(process.execPath, ["--import", pathToFileURL(join(this.temporary, "offline-preload.mjs")).href,
      join(this.temporary, "standalone/apps/web/server.js")], {
      cwd: join(this.temporary, "standalone/apps/web"), stdio: ["ignore", "pipe", "pipe"],
      // Explicit allowlist: never inherit credentials, proxy configuration, NODE_OPTIONS, or real provider keys.
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: this.temporary, TMPDIR: this.temporary,
        NODE_ENV: "production", HOSTNAME: "127.0.0.1", PORT: "4179", NEXT_TELEMETRY_DISABLED: "1",
        DATABASE_URL: this.runtimeUrl, ATTENTION_WEB_DATABASE_ROLE: "attention_web_runtime",
        NEXT_PUBLIC_APP_URL: productionOrigin,
        ATTENTION_AUTH_SECRET: "synthetic-production-auth-secret-at-least-32",
        ATTENTION_HMAC_SECRET: "synthetic-production-hmac-secret-at-least-32",
        ATTENTION_WEBSITE_AGENT_SESSION_SECRET: "synthetic-production-encryption-secret-at-least-32",
        ATTENTION_WEBSITE_AGENT_ENABLED: "true", ATTENTION_WEBSITE_AGENT_AUDIENCE: "members",
        ATTENTION_WEBSITE_AGENT_DAILY_COST_MICRO_USD: "unlimited", ATTENTION_WEBSITE_AGENT_MAX_RUN_COST_MICRO_USD: "400000",
        ATTENTION_WEBSITE_AGENT_DEEPSEEK_API_KEY: providerKey, ATTENTION_DIGEST_WORKER_ENABLED: "false",
        TEST_WEBSITE_AGENT_PRODUCTION: productionFixtureMarker,
        TEST_WEBSITE_AGENT_PROVIDER_EVENTS: join(this.temporary, "provider-events.jsonl"),
      },
    });
    this.child = child;
    child.on("error", () => { spawnError = true; });
    for (const stream of [child.stdout, child.stderr]) stream?.on("data", (data: Buffer) => {
      const text = data.toString();
      if (text.includes("Ready in")) ready = true;
      this.serverLog = (this.serverLog + text).slice(-20_000);
    });
    for (let attempt = 0; attempt < 240; attempt++) {
      if (spawnError || child.exitCode !== null) throw new Error("Standalone server exited before readiness");
      if (ready) {
        const response = await fetch(`${productionOrigin}/api/health`, { redirect: "error", signal: AbortSignal.timeout(2000) });
        if (response.ok && (await response.json() as { status: string }).status === "ok") return;
      }
      await delay(250);
    }
    throw new Error("Standalone server did not become ready on loopback");
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    for (let attempt = 0; attempt < 40 && child.exitCode === null && child.signalCode === null; attempt++) await delay(250);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise<void>(resolve => child.once("exit", () => resolve()));
    }
  }
  async restart(): Promise<void> { await this.stop(); await this.start(); }

  async member(): Promise<SyntheticMember> {
    const accountId = randomUUID();
    const email = `production-${accountId}@example.test`;
    await this.db.db.insert(accounts).values({ id: accountId, stableHandle: `production-${accountId}`,
      displayName: "Synthetic production member", primaryEmail: email, emailVerifiedAt: new Date() });
    await this.db.db.insert(entitlements).values({ accountId, source: "admin_grant", memberEnabled: true });
    const issued = await issueSession(this.db.db, { accountId });
    this.secrets.push(issued.token);
    return { accountId, email, cookie: serializeSessionCookie(issued.token, issued.expiresAt, { secure: true }).split(";")[0]! };
  }

  async request(path: string, member?: SyntheticMember, body?: Record<string, unknown>): Promise<Response> {
    if (!path.startsWith("/api/website-agent/")) throw new Error("Unexpected production acceptance route");
    return fetch(productionOrigin + path, { method: body ? "POST" : "GET", redirect: "error",
      signal: AbortSignal.timeout(45_000), headers: { "content-type": "application/json", origin: productionOrigin,
        "sec-fetch-site": "same-origin", ...(member ? { cookie: member.cookie } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
  }

  async providerEvents(): Promise<Array<{ kind: string }>> {
    const text = await readFile(join(this.temporary, "provider-events.jsonl"), "utf8").catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    });
    return text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { kind: string });
  }
  sanitizedLog(): string {
    let log = this.serverLog;
    for (const secret of this.secrets) log = log.replaceAll(secret, "[redacted]");
    return log.replace(/postgres(?:ql)?:\/\/\S+/gu, "[redacted-database-url]");
  }
  async close(): Promise<void> {
    await this.stop();
    await this.owner?.close();
    if (this.temporary) await rm(this.temporary, { recursive: true, force: true });
  }
}

export const test = base.extend<object, { production: ProductionWebsiteFixture }>({
  // Playwright parses this destructuring to identify fixture dependencies.
  // eslint-disable-next-line no-empty-pattern
  production: [async ({}, use) => {
    const fixture = new ProductionWebsiteFixture();
    try { await fixture.initialize(); await use(fixture); }
    catch (error) { console.error(fixture.sanitizedLog()); throw error; }
    finally { await fixture.close(); }
  }, { scope: "worker", timeout: 180_000 }],
});
