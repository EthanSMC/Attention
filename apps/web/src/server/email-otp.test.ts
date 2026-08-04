import { afterEach, describe, expect, it, vi } from "vitest";

import { getEmailOtpSender } from "./email-otp";

describe("email OTP provider configuration", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    "http://mail.example/send",
    "https://user:password@mail.example/send",
    "https://mail.example/send?token=unsafe",
    "https://mail.example/send#fragment",
  ])("rejects an unsafe credential target: %s", (endpoint) => {
    expect(() => getEmailOtpSender({
      ATTENTION_EMAIL_PROVIDER: "webhook",
      ATTENTION_EMAIL_WEBHOOK_TOKEN: "secret",
      ATTENTION_EMAIL_WEBHOOK_URL: endpoint,
      NODE_ENV: "test",
    })).toThrow(/HTTPS/u);
  });

  it("allows a loopback HTTP adapter in development", () => {
    expect(() => getEmailOtpSender({
      ATTENTION_EMAIL_PROVIDER: "webhook",
      ATTENTION_EMAIL_WEBHOOK_TOKEN: "secret",
      ATTENTION_EMAIL_WEBHOOK_URL: "http://127.0.0.1:4400/send",
      NODE_ENV: "test",
    })).not.toThrow();
  });

  it("does not follow provider redirects with the OTP payload", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const sender = getEmailOtpSender({
      ATTENTION_EMAIL_PROVIDER: "webhook",
      ATTENTION_EMAIL_WEBHOOK_TOKEN: "secret",
      ATTENTION_EMAIL_WEBHOOK_URL: "https://mail.example/send",
      NODE_ENV: "test",
    });

    await sender.send({
      code: "123456",
      email: "member@example.com",
      expiresAt: new Date("2026-08-04T12:00:00.000Z"),
    });

    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("error");
  });
});
