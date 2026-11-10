/** These integration tests may initialize only a new, explicitly marked test database. */
export const WEBSITE_HTTP_TEST_MARKER = "attention-website-http-acceptance-v1";

export function websiteHttpTestDatabaseUrls(env: Readonly<Record<string, string | undefined>>): {
  admin: string; runtime: string; name: string;
} {
  if (env.TEST_WEBSITE_AGENT_DISPOSABLE !== WEBSITE_HTTP_TEST_MARKER) {
    throw new Error("Explicit disposable website HTTP test acknowledgement required");
  }
  const admin = env.TEST_WEBSITE_AGENT_DATABASE_URL;
  const runtime = env.TEST_WEBSITE_AGENT_RUNTIME_DATABASE_URL;
  if (!admin || !runtime) throw new Error("Both isolated website HTTP database URLs are required");
  const owner = new URL(admin);
  const web = new URL(runtime);
  const name = owner.pathname.slice(1);
  if (!/^postgres(?:ql)?:$/u.test(owner.protocol) || !/^postgres(?:ql)?:$/u.test(web.protocol) ||
      !/^attention_website_http_test(?:_[a-z0-9]+)*$/u.test(name) ||
      owner.hostname !== web.hostname || owner.port !== web.port || owner.pathname !== web.pathname ||
      owner.username !== "postgres" || web.username !== "attention_web_runtime" ||
      !owner.password || !web.password || owner.search || web.search || owner.hash || web.hash) {
    throw new Error("Website HTTP acceptance requires matched, dedicated owner/runtime test URLs");
  }
  return { admin, runtime, name };
}

export function assertWebsiteHttpTestDatabase(input: {
  name: string; version: string; marker: string | null; userTables: number;
}, expectedName: string): void {
  if (input.name !== expectedName || !/^17\d{4}$/u.test(input.version) ||
      input.marker !== WEBSITE_HTTP_TEST_MARKER || input.userTables !== 0) {
    throw new Error("Refusing migration: database must be empty, marked disposable, and PostgreSQL 17");
  }
}
