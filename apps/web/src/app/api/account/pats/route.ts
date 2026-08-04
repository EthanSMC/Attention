import { createApiCredential } from "@attention/auth";
import type { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";

import { mutationRequestError, noStoreJson } from "../../../../server/api-guard";
import { getWebDatabase } from "../../../../server/db";
import {
  clearInvalidSessionCookie,
  getRequestSession,
} from "../../../../server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  expires_in_days: z.number().int().min(1).max(365).default(90),
  name: z.string().min(1).max(100),
  scopes: z.array(z.string()).min(1).max(12),
}).strict();
const advancedScopes = new Set(["ai:search", "public:full", "subscription:read"]);

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guardError = mutationRequestError(request);
  if (guardError) return noStoreJson({ error: { code: guardError } }, { status: 400 });
  const session = await getRequestSession(request);
  if (!session.principal) {
    const response = noStoreJson({ error: { code: "authentication_required" } }, { status: 401 });
    clearInvalidSessionCookie(response, session);
    return response;
  }
  try {
    const body = bodySchema.parse(await request.json());
    if (!session.principal.isMember && body.scopes.some((scope) => advancedScopes.has(scope))) {
      return noStoreJson({ error: { code: "membership_required" } }, { status: 403 });
    }
    const credential = await createApiCredential(getWebDatabase(), {
      accountId: session.principal.accountId,
      expiresAt: new Date(Date.now() + body.expires_in_days * 24 * 60 * 60 * 1_000),
      name: body.name,
      scopes: body.scopes,
    });
    return noStoreJson({
      credential_id: credential.credentialId,
      expires_at: credential.expiresAt?.toISOString() ?? null,
      key: credential.key,
      key_prefix: credential.keyPrefix,
      name: credential.name,
      scopes: credential.scopes,
      warning: "此密钥只显示一次，请立即保存。",
    }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError || error instanceof RangeError) {
      return noStoreJson({ error: { code: "invalid_request" } }, { status: 400 });
    }
    console.error("pat_creation_failed", { name: error instanceof Error ? error.name : "UnknownError" });
    return noStoreJson({ error: { code: "internal_error" } }, { status: 500 });
  }
}
