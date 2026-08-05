import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createConfiguredEmailProvider,
  EmailProviderError,
} from "./email-provider";

describe("digest email provider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the existing webhook adapter with an idempotency key", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ message_id: "provider-123" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = createConfiguredEmailProvider({
      ATTENTION_EMAIL_PROVIDER: "webhook",
      ATTENTION_EMAIL_WEBHOOK_TOKEN: "secret",
      ATTENTION_EMAIL_WEBHOOK_URL: "https://mail.example/send",
      NODE_ENV: "production",
    });
    await expect(
      provider.send({
        html: "<p>日报</p>",
        idempotencyKey: "delivery-1",
        subject: "日报",
        text: "日报",
        to: "member@example.com",
      }),
    ).resolves.toEqual({ providerMessageId: "provider-123" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("delivery-1");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      email: "member@example.com",
      message_id: "delivery-1",
      template: "attention-daily-digest-v1",
    });
  });

  it("rejects console delivery in production and normalizes webhook failures", async () => {
    expect(() =>
      createConfiguredEmailProvider({
        ATTENTION_EMAIL_PROVIDER: "console",
        NODE_ENV: "production",
      }),
    ).toThrow(/webhook/u);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    const provider = createConfiguredEmailProvider({
      ATTENTION_EMAIL_PROVIDER: "webhook",
      ATTENTION_EMAIL_WEBHOOK_TOKEN: "secret",
      ATTENTION_EMAIL_WEBHOOK_URL: "https://mail.example/send",
    });
    await expect(
      provider.send({
        html: "",
        idempotencyKey: "delivery-2",
        subject: "",
        text: "",
        to: "member@example.com",
      }),
    ).rejects.toBeInstanceOf(EmailProviderError);
  });

  it.each([
    "http://mail.example/send",
    "https://user:password@mail.example/send",
    "https://mail.example/send?token=unsafe",
    "https://mail.example/send#fragment",
  ])("rejects an unsafe webhook endpoint: %s", (endpoint) => {
    expect(() =>
      createConfiguredEmailProvider({
        ATTENTION_EMAIL_PROVIDER: "webhook",
        ATTENTION_EMAIL_WEBHOOK_TOKEN: "secret",
        ATTENTION_EMAIL_WEBHOOK_URL: endpoint,
      }),
    ).toThrow(/HTTPS/u);
  });

  it("allows loopback HTTP for local email adapter development", () => {
    expect(() =>
      createConfiguredEmailProvider({
        ATTENTION_EMAIL_PROVIDER: "webhook",
        ATTENTION_EMAIL_WEBHOOK_TOKEN: "secret",
        ATTENTION_EMAIL_WEBHOOK_URL: "http://127.0.0.1:4100/send",
      }),
    ).not.toThrow();
  });
});
