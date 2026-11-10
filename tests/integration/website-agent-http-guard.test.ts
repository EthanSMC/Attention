import { describe, expect, it } from "vitest";

import { assertWebsiteHttpTestDatabase, WEBSITE_HTTP_TEST_MARKER, websiteHttpTestDatabaseUrls } from "./website-agent-http-guard";

const env = {
  TEST_WEBSITE_AGENT_DISPOSABLE: WEBSITE_HTTP_TEST_MARKER,
  TEST_WEBSITE_AGENT_DATABASE_URL: "postgresql://postgres:synthetic@127.0.0.1:5432/attention_website_http_test",
  TEST_WEBSITE_AGENT_RUNTIME_DATABASE_URL: "postgresql://attention_web_runtime:synthetic@127.0.0.1:5432/attention_website_http_test",
};

describe("website HTTP acceptance database safety", () => {
  it("accepts only the explicit matched disposable owner/runtime pair", () => {
    expect(websiteHttpTestDatabaseUrls(env)).toMatchObject({ name: "attention_website_http_test" });
  });
  it.each([
    { TEST_WEBSITE_AGENT_DISPOSABLE: undefined },
    { TEST_WEBSITE_AGENT_RUNTIME_DATABASE_URL: undefined },
    { TEST_WEBSITE_AGENT_DATABASE_URL: env.TEST_WEBSITE_AGENT_DATABASE_URL.replace("attention_website_http_test", "attention_staging") },
    { TEST_WEBSITE_AGENT_RUNTIME_DATABASE_URL: env.TEST_WEBSITE_AGENT_RUNTIME_DATABASE_URL.replace("127.0.0.1", "other-host") },
    { TEST_WEBSITE_AGENT_RUNTIME_DATABASE_URL: env.TEST_WEBSITE_AGENT_RUNTIME_DATABASE_URL.replace("attention_web_runtime", "postgres") },
    { TEST_WEBSITE_AGENT_DATABASE_URL: env.TEST_WEBSITE_AGENT_DATABASE_URL + "?options=unsafe" },
  ])("rejects unsafe configuration before connecting: %j", change => {
    expect(() => websiteHttpTestDatabaseUrls({ ...env, ...change })).toThrow();
  });
  const safe = { name: "attention_website_http_test", version: "170006", marker: WEBSITE_HTTP_TEST_MARKER, userTables: 0 };
  it("accepts a marked empty PostgreSQL 17 database", () => {
    expect(() => assertWebsiteHttpTestDatabase(safe, safe.name)).not.toThrow();
  });
  it.each([{ marker: null }, { name: "attention_staging" }, { version: "160006" }, { userTables: 1 }])(
    "refuses migration for non-disposable server state: %j", change => {
      expect(() => assertWebsiteHttpTestDatabase({ ...safe, ...change }, safe.name)).toThrow();
    },
  );
});
