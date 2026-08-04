import "server-only";

import { randomUUID } from "node:crypto";

import {
  accounts,
  and,
  desc,
  eq,
  gt,
  inArray,
  membershipGrants,
  subscriptions,
  type AttentionDatabase,
} from "@attention/db";
import { normalizeCredentialEndpoint } from "@attention/contracts";

export interface MembershipOffer {
  billingIntervalLabel: string;
  firstChargeAmountLabel: string;
  priceLabel: string;
  providerAvailable: boolean;
  trialMonths: number;
}

export interface StartedCheckout {
  redirectTo: string;
}

export interface BillingProvider {
  startSubscription(input: {
    accountId: string;
    returnTo: string;
  }): Promise<StartedCheckout>;
}

export function addCalendarMonths(value: Date, months: number): Date {
  const result = new Date(value);
  const originalDay = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(originalDay, lastDay));
  return result;
}

export async function subscriptionPreview(
  db: AttentionDatabase,
  accountId: string,
  now = new Date(),
): Promise<{ firstChargeAt: Date; trialEligible: boolean }> {
  const [account] = await db
    .select({
      directTrialConsumedAt: accounts.directTrialConsumedAt,
      signupSource: accounts.signupSource,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!account) throw new Error("account_not_found");
  const [latestGrant] = await db
    .select({ endsAt: membershipGrants.endsAt })
    .from(membershipGrants)
    .where(and(
      eq(membershipGrants.accountId, accountId),
      inArray(membershipGrants.status, ["active", "scheduled"]),
      gt(membershipGrants.endsAt, now),
    ))
    .orderBy(desc(membershipGrants.endsAt))
    .limit(1);
  const [existingDirectTrial] = await db
    .select({ id: membershipGrants.id })
    .from(membershipGrants)
    .where(and(eq(membershipGrants.accountId, accountId), eq(membershipGrants.kind, "direct_trial")))
    .limit(1);
  const trialEligible =
    account.signupSource === "direct" &&
    account.directTrialConsumedAt === null &&
    !existingDirectTrial;
  const trialStartsAt = latestGrant?.endsAt ?? now;
  return {
    firstChargeAt: trialEligible ? addCalendarMonths(trialStartsAt, 3) : now,
    trialEligible,
  };
}

export function membershipOffer(): MembershipOffer {
  const provider = process.env.ATTENTION_BILLING_PROVIDER?.trim();
  return {
    billingIntervalLabel: process.env.ATTENTION_MEMBER_BILLING_INTERVAL_LABEL ?? "按年自动续费",
    firstChargeAmountLabel:
      process.env.ATTENTION_MEMBER_FIRST_CHARGE_LABEL ??
      process.env.ATTENTION_MEMBER_PRICE_LABEL ??
      "价格待发布",
    priceLabel: process.env.ATTENTION_MEMBER_PRICE_LABEL ?? "价格待发布",
    providerAvailable: provider === "demo" || provider === "webhook",
    trialMonths: 3,
  };
}

export function normalizeBillingCheckoutEndpoint(rawValue: string): string {
  return normalizeCredentialEndpoint(rawValue, "ATTENTION_BILLING_CHECKOUT_WEBHOOK");
}

async function createDemoSubscription(
  db: AttentionDatabase,
  accountId: string,
  returnTo: string,
): Promise<StartedCheckout> {
  const now = new Date();
  const preview = await subscriptionPreview(db, accountId, now);

  const [existing] = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.accountId, accountId),
        inArray(subscriptions.status, ["trialing", "active"]),
        gt(subscriptions.currentPeriodEnd, now),
      ),
    )
    .limit(1);
  if (existing) return { redirectTo: `${returnTo}${returnTo.includes("?") ? "&" : "?"}membership=active` };

  const [latestGrant] = await db
    .select({ endsAt: membershipGrants.endsAt })
    .from(membershipGrants)
    .where(
      and(
        eq(membershipGrants.accountId, accountId),
        inArray(membershipGrants.status, ["active", "scheduled"]),
        gt(membershipGrants.endsAt, now),
      ),
    )
    .orderBy(desc(membershipGrants.endsAt))
    .limit(1);

  const trialEligible = preview.trialEligible;
  const startsAt = latestGrant?.endsAt ?? now;
  const trialEndsAt = trialEligible ? addCalendarMonths(startsAt, 3) : startsAt;
  const paidPeriodEnd = trialEligible ? trialEndsAt : addCalendarMonths(now, 12);
  const providerSubscriptionId = `demo_${randomUUID()}`;

  await db.transaction(async (tx) => {
    const [subscription] = await tx
      .insert(subscriptions)
      .values({
        accountId,
        currentPeriodEnd: paidPeriodEnd,
        currentPeriodStart: trialEligible ? startsAt : now,
        firstChargeAt: trialEligible ? trialEndsAt : now,
        introEligible: trialEligible,
        provider: "demo",
        providerCustomerId: `demo_account_${accountId}`,
        providerSubscriptionId,
        status: trialEligible ? "trialing" : "active",
      })
      .returning({ id: subscriptions.id });
    if (!subscription) throw new Error("subscription_creation_failed");
    if (trialEligible) {
      await tx.insert(membershipGrants).values({
        accountId,
        endsAt: trialEndsAt,
        kind: "direct_trial",
        sourceId: subscription.id,
        startsAt,
        status: startsAt <= now ? "active" : "scheduled",
      });
      await tx
        .update(accounts)
        .set({
          directTrialConsumedAt: now,
          directTrialSourceEventKey: `demo:${subscription.id}`,
          updatedAt: now,
        })
        .where(eq(accounts.id, accountId));
    }
  });

  return { redirectTo: `${returnTo}${returnTo.includes("?") ? "&" : "?"}membership=started` };
}

class WebhookBillingProvider implements BillingProvider {
  async startSubscription(input: {
    accountId: string;
    returnTo: string;
  }): Promise<StartedCheckout> {
    const endpoint = process.env.ATTENTION_BILLING_CHECKOUT_WEBHOOK?.trim();
    const secret = process.env.ATTENTION_BILLING_WEBHOOK_SECRET?.trim();
    if (!endpoint || !secret) throw new Error("billing_provider_unavailable");
    const response = await fetch(normalizeBillingCheckoutEndpoint(endpoint), {
      body: JSON.stringify({
        account_id: input.accountId,
        return_to: input.returnTo,
      }),
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("billing_checkout_failed");
    const result = (await response.json()) as { checkout_url?: unknown };
    if (typeof result.checkout_url !== "string") throw new Error("billing_checkout_failed");
    const url = new URL(result.checkout_url);
    if (url.protocol !== "https:") throw new Error("billing_checkout_failed");
    return { redirectTo: url.toString() };
  }
}

export function getBillingProvider(db: AttentionDatabase): BillingProvider | null {
  const provider = process.env.ATTENTION_BILLING_PROVIDER?.trim();
  if (provider === "demo" && process.env.NODE_ENV !== "production") {
    return { startSubscription: (input) => createDemoSubscription(db, input.accountId, input.returnTo) };
  }
  if (provider === "webhook") return new WebhookBillingProvider();
  return null;
}
