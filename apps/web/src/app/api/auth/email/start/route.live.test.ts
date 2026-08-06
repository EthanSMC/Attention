import { cancelLoginChallenge } from "@attention/auth";
import type { NextRequest } from "next/server";
import { afterAll, describe, expect, it, vi } from "vitest";

import { getDatabaseHandle, getWebDatabase } from "../../../../../server/db";
import { POST } from "./route";

const liveResendEnabled = process.env.ATTENTION_LIVE_RESEND_E2E === "true";
let databaseOpened = false;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the live Resend E2E`);
  return value;
}

describe.runIf(liveResendEnabled)("live Resend email login", () => {
  afterAll(async () => {
    if (databaseOpened) await getDatabaseHandle().close();
  });

  it("sends through Resend without returning the verification code", async () => {
    expect(requiredEnvironment("ATTENTION_EMAIL_PROVIDER")).toBe("resend");
    requiredEnvironment("RESEND_API_KEY");
    requiredEnvironment("ATTENTION_RESEND_FROM");
    expect(requiredEnvironment("ATTENTION_RESEND_TEMPLATE_ID")).toBe(
      "attention-login-code",
    );
    requiredEnvironment("ATTENTION_AUTH_SECRET");
    requiredEnvironment("DATABASE_URL");
    const origin = new URL(requiredEnvironment("NEXT_PUBLIC_APP_URL")).origin;
    const source = JSON.stringify({
      email: `delivered+attention-live-${Date.now()}@resend.dev`,
      return_to: "/account",
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    let challengeId: string | undefined;

    try {
      databaseOpened = true;
      const response = await POST(new Request(`${origin}/api/auth/email/start`, {
        body: source,
        headers: {
          "content-length": String(Buffer.byteLength(source)),
          "content-type": "application/json",
          origin,
          "sec-fetch-site": "same-origin",
        },
        method: "POST",
      }) as NextRequest);
      const body = await response.json() as Record<string, unknown>;
      if (typeof body.challenge_id === "string") {
        challengeId = body.challenge_id;
      }

      expect(response.status).toBe(200);
      expect(body).toEqual({
        challenge_id: expect.any(String),
        expires_at: expect.any(String),
        retry_after_seconds: 60,
      });
      expect(JSON.stringify(body)).not.toMatch(/\b\d{6}\b/u);
    } finally {
      info.mockRestore();
      if (challengeId) {
        await cancelLoginChallenge(getWebDatabase(), challengeId);
      }
    }
  }, 20_000);
});
