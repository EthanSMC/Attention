import { afterEach, describe, expect, it, vi } from "vitest";

import { getEmailOtpSender } from "./email-otp";

describe("email OTP provider configuration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("sends the unified login template through the native Resend endpoint", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T12:00:00.000Z"));
    const timeoutSignal = new AbortController().signal;
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(timeoutSignal);
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ id: "email_01K1TEST" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const sender = getEmailOtpSender({
      ATTENTION_EMAIL_PROVIDER: "resend",
      ATTENTION_RESEND_FROM: "Attention <no_reply@service.noveltystudio.cn>",
      ATTENTION_RESEND_TEMPLATE_ID: "login-code-attention",
      NODE_ENV: "test",
      RESEND_API_KEY: "test_resend_api_key",
    });

    await sender.send({
      challengeId: "018f6a43-36c7-75f1-bf3d-3f2cfbd20c01",
      code: "123456",
      email: "member@example.com",
      expiresAt: new Date("2026-08-04T12:10:00.000Z"),
    });

    expect(timeout).toHaveBeenCalledWith(8_000);
    expect(fetchMock).toHaveBeenCalledWith("https://api.resend.com/emails", {
      body: JSON.stringify({
        from: "Attention <no_reply@service.noveltystudio.cn>",
        subject: "Attention 登录验证码",
        template: {
          id: "login-code-attention",
          variables: {
            valid_minutes: 10,
            verification_code: "123456",
          },
        },
        to: ["member@example.com"],
      }),
      headers: {
        Authorization: "Bearer test_resend_api_key",
        "Content-Type": "application/json",
        "Idempotency-Key":
          "attention-login-otp:018f6a43-36c7-75f1-bf3d-3f2cfbd20c01",
      },
      method: "POST",
      redirect: "error",
      signal: timeoutSignal,
    });
  });

  it("logs only the masked recipient and Resend message id after success", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ id: "email_01K1TEST" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const sender = getEmailOtpSender({
      ATTENTION_EMAIL_PROVIDER: "resend",
      ATTENTION_RESEND_FROM: "Attention <no_reply@service.noveltystudio.cn>",
      ATTENTION_RESEND_TEMPLATE_ID: "login-code-attention",
      NODE_ENV: "test",
      RESEND_API_KEY: "test_resend_api_key",
    });

    await sender.send({
      challengeId: "018f6a43-36c7-75f1-bf3d-3f2cfbd20c01",
      code: "123456",
      email: "a@example.com",
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });

    expect(info).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith("attention_email_otp_sent", {
      email: "a***@example.com",
      providerMessageId: "email_01K1TEST",
    });
  });

  it.each([
    [undefined, "Attention <no_reply@service.noveltystudio.cn>", "login-code-attention"],
    ["test_resend_api_key", undefined, "login-code-attention"],
    ["test_resend_api_key", "Attention <no_reply@service.noveltystudio.cn>", undefined],
  ])(
    "rejects incomplete native Resend configuration",
    (apiKey, from, templateId) => {
      expect(() =>
        getEmailOtpSender({
          ATTENTION_EMAIL_PROVIDER: "resend",
          ATTENTION_RESEND_FROM: from,
          ATTENTION_RESEND_TEMPLATE_ID: templateId,
          NODE_ENV: "test",
          RESEND_API_KEY: apiKey,
        }),
      ).toThrow(
        "RESEND_API_KEY, ATTENTION_RESEND_FROM, and ATTENTION_RESEND_TEMPLATE_ID are required",
      );
    },
  );

  it("rejects a non-2xx response without writing a success log", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ id: "email_should_not_succeed" }, { status: 429 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const sender = getEmailOtpSender({
      ATTENTION_EMAIL_PROVIDER: "resend",
      ATTENTION_RESEND_FROM: "Attention <no_reply@service.noveltystudio.cn>",
      ATTENTION_RESEND_TEMPLATE_ID: "login-code-attention",
      NODE_ENV: "test",
      RESEND_API_KEY: "test_resend_api_key",
    });

    await expect(
      sender.send({
        challengeId: "018f6a43-36c7-75f1-bf3d-3f2cfbd20c01",
        code: "123456",
        email: "member@example.com",
        expiresAt: new Date(Date.now() + 10 * 60_000),
      }),
    ).rejects.toThrow("OTP email provider returned 429");
    expect(info).not.toHaveBeenCalled();
  });

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
      challengeId: "018f6a43-36c7-75f1-bf3d-3f2cfbd20c01",
      code: "123456",
      email: "member@example.com",
      expiresAt: new Date("2026-08-04T12:00:00.000Z"),
    });

    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("error");
  });
});
