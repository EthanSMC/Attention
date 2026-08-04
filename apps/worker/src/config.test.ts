import { describe, expect, it } from "vitest";

import { loadWorkerConfig } from "./config";

describe("worker digest configuration", () => {
  it("normalizes the public app URL for digest links", () => {
    expect(
      loadWorkerConfig({
        DATABASE_URL: "postgresql:///attention_test",
        NEXT_PUBLIC_APP_URL: "https://attention.example/some/path",
      }).publicOrigin,
    ).toBe("https://attention.example");
  });

  it("requires an explicit public URL in production when digests are enabled", () => {
    expect(() =>
      loadWorkerConfig({
        ATTENTION_WORKER_DATABASE_ROLE: "attention_worker_runtime",
        NODE_ENV: "production",
        WORKER_DATABASE_URL:
          "postgresql://attention_worker_runtime:secret@example.com/attention",
      }),
    ).toThrow(/NEXT_PUBLIC_APP_URL/u);
    expect(
      loadWorkerConfig({
        ATTENTION_DIGEST_WORKER_ENABLED: "false",
        ATTENTION_WORKER_DATABASE_ROLE: "attention_worker_runtime",
        NODE_ENV: "production",
        WORKER_DATABASE_URL:
          "postgresql://attention_worker_runtime:secret@example.com/attention",
      }).digestEnabled,
    ).toBe(false);
  });

  it("rejects ambiguous digest enablement values", () => {
    expect(() =>
      loadWorkerConfig({
        ATTENTION_DIGEST_WORKER_ENABLED: "sometimes",
        DATABASE_URL: "postgresql:///attention_test",
      }),
    ).toThrow(/must be true or false/u);
  });
});
