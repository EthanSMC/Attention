import { safeReturnTo } from "@attention/auth";
import type { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";

import { mutationRequestError, noStoreJson } from "../../../../server/api-guard";
import { getWebDatabase } from "../../../../server/db";
import { getBillingProvider } from "../../../../server/membership";
import {
  clearInvalidSessionCookie,
  getRequestSession,
} from "../../../../server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  confirm_auto_renewal: z.literal(true),
  return_to: z.string().max(2048).optional(),
}).strict();

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guardError = mutationRequestError(request);
  if (guardError) return noStoreJson({ error: { code: guardError } }, { status: 400 });
  const requestSession = await getRequestSession(request);
  if (!requestSession.principal) {
    const response = noStoreJson({ error: { code: "authentication_required" } }, { status: 401 });
    clearInvalidSessionCookie(response, requestSession);
    return response;
  }
  try {
    const body = bodySchema.parse(await request.json());
    const returnTo = safeReturnTo(body.return_to ?? "/ai");
    const provider = getBillingProvider(getWebDatabase());
    if (!provider) {
      return noStoreJson({ error: { code: "billing_provider_unavailable" } }, { status: 503 });
    }
    const checkout = await provider.startSubscription({
      accountId: requestSession.principal.accountId,
      returnTo,
    });
    return noStoreJson({ redirect_to: checkout.redirectTo });
  } catch (error) {
    if (error instanceof ZodError) {
      return noStoreJson({ error: { code: "invalid_request" } }, { status: 400 });
    }
    console.error("membership_checkout_failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return noStoreJson({ error: { code: "billing_checkout_failed" } }, { status: 502 });
  }
}
