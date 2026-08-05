import type { AttentionDatabase } from "@attention/db";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getBillingProvider,
  normalizeBillingCheckoutEndpoint,
} from "./membership";

const originalBillingProvider = process.env.ATTENTION_BILLING_PROVIDER;
const originalBillingEndpoint = process.env.ATTENTION_BILLING_CHECKOUT_WEBHOOK;
const originalBillingSecret = process.env.ATTENTION_BILLING_WEBHOOK_SECRET;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("billing checkout credential endpoint", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    restoreEnv("ATTENTION_BILLING_PROVIDER", originalBillingProvider);
    restoreEnv("ATTENTION_BILLING_CHECKOUT_WEBHOOK", originalBillingEndpoint);
    restoreEnv("ATTENTION_BILLING_WEBHOOK_SECRET", originalBillingSecret);
  });

  it.each([
    "http://billing.example/checkout",
    "https://user:password@billing.example/checkout",
    "https://billing.example/checkout?secret=unsafe",
    "https://billing.example/checkout#fragment",
  ])("rejects an unsafe webhook target before sending credentials: %s", (value) => {
    expect(() => normalizeBillingCheckoutEndpoint(value)).toThrow();
  });

  it.each([
    ["https://billing.example/checkout/", "https://billing.example/checkout"],
    ["http://127.0.0.1:4300/checkout", "http://127.0.0.1:4300/checkout"],
    ["http://localhost:4300/checkout", "http://localhost:4300/checkout"],
  ])("normalizes an allowed webhook target: %s", (value, expected) => {
    expect(normalizeBillingCheckoutEndpoint(value)).toBe(expected);
  });

  it("does not forward checkout credentials or account data through redirects", async () => {
    process.env.ATTENTION_BILLING_PROVIDER = "webhook";
    process.env.ATTENTION_BILLING_CHECKOUT_WEBHOOK =
      "https://billing.example/checkout";
    process.env.ATTENTION_BILLING_WEBHOOK_SECRET = "billing-secret";
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ checkout_url: "https://billing.example/pay/once" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = getBillingProvider({} as AttentionDatabase);

    await expect(
      provider?.startSubscription({
        accountId: "00000000-0000-4000-8000-000000000001",
        returnTo: "/membership",
      }),
    ).resolves.toEqual({ redirectTo: "https://billing.example/pay/once" });
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("error");
  });
});
