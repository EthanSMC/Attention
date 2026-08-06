import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalExposeOtp = process.env.ATTENTION_AUTH_EXPOSE_OTP;

const mocks = vi.hoisted(() => {
  class EmailAuthError extends Error {
    readonly code = "rate_limited";
    readonly retryAfterSeconds = 60;
  }

  return {
    EmailAuthError,
    cancelLoginChallenge: vi.fn(),
    createLoginChallenge: vi.fn(),
    getWebDatabase: vi.fn(() => ({})),
    send: vi.fn(),
  };
});

vi.mock("@attention/auth", () => ({
  EmailAuthError: mocks.EmailAuthError,
  cancelLoginChallenge: mocks.cancelLoginChallenge,
  createLoginChallenge: mocks.createLoginChallenge,
  fingerprintLoginRequester: vi.fn(() => "requester-fingerprint"),
}));
vi.mock("../../../../../server/db", () => ({
  getWebDatabase: mocks.getWebDatabase,
}));
vi.mock("../../../../../server/email-otp", () => ({
  getEmailOtpSender: () => ({ send: mocks.send }),
}));
vi.mock("../../../../../server/trusted-client-source", () => ({
  TrustedClientSourceError: class TrustedClientSourceError extends Error {},
  trustedClientSource: vi.fn(() => "local-development"),
}));

import { POST } from "./route";

function emailStartRequest(): NextRequest {
  const source = JSON.stringify({
    email: "member@example.com",
    return_to: "/account",
  });
  return new Request("https://attention.example/api/auth/email/start", {
    body: source,
    headers: {
      "content-length": String(Buffer.byteLength(source)),
      "content-type": "application/json",
      origin: "https://attention.example",
      "sec-fetch-site": "same-origin",
    },
    method: "POST",
  }) as NextRequest;
}

describe("email login start response", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ATTENTION_AUTH_EXPOSE_OTP = "true";
    mocks.createLoginChallenge.mockResolvedValue({
      challengeId: "018f6a43-36c7-75f1-bf3d-3f2cfbd20c01",
      code: "123456",
      email: "member@example.com",
      expiresAt: new Date("2026-08-06T12:10:00.000Z"),
      retryAfterSeconds: 60,
    });
    mocks.send.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (originalExposeOtp === undefined) {
      delete process.env.ATTENTION_AUTH_EXPOSE_OTP;
      return;
    }
    process.env.ATTENTION_AUTH_EXPOSE_OTP = originalExposeOtp;
  });

  it("never returns the verification code to the browser", async () => {
    const response = await POST(emailStartRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      challenge_id: "018f6a43-36c7-75f1-bf3d-3f2cfbd20c01",
      expires_at: "2026-08-06T12:10:00.000Z",
      retry_after_seconds: 60,
    });
  });
});
