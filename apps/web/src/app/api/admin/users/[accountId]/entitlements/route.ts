import { randomUUID } from "node:crypto";

import type { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";

import { AdminAccessError, requireAdminPrincipal } from "../../../../../../server/admin-access";
import { changeAdminUserEntitlement } from "../../../../../../server/admin-user-entitlements";
import { mutationRequestError, noStoreJson } from "../../../../../../server/api-guard";
import { getWebDatabase } from "../../../../../../server/db";
import {
  InvalidRequestBodyError,
  readJsonRequestWithinLimit,
  RequestBodyTooLargeError,
} from "../../../../../../server/request-body";
import {
  clearInvalidSessionCookie,
  getRequestSession,
} from "../../../../../../server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ADMIN_ENTITLEMENT_BODY_BYTES = 4_096;
const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

const bodySchema = z
  .object({
    action: z.enum(["set_member", "set_filter", "revoke_filter"]),
    confirmed: z.literal(true),
    reason: z.string().transform((value) => value.normalize("NFKC").trim()).pipe(
      z.string().min(3).max(500),
    ),
  })
  .strict();

interface RouteContext {
  params: Promise<{ accountId: string }>;
}

function requestCorrelationId(request: Request): string {
  const supplied = request.headers.get("x-request-id")?.trim();
  return supplied && requestIdPattern.test(supplied) ? supplied : randomUUID();
}

function accessErrorResponse(error: AdminAccessError): NextResponse {
  return noStoreJson(
    {
      error: {
        code:
          error.code === "admin_configuration_invalid"
            ? "admin_unavailable"
            : "admin_required",
      },
    },
    { status: error.code === "admin_configuration_invalid" ? 503 : 403 },
  );
}

function serviceErrorCode(error: unknown): string | null {
  if (!(error instanceof Error) || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const guardError = mutationRequestError(request, {
    maxContentLengthBytes: MAX_ADMIN_ENTITLEMENT_BODY_BYTES,
  });
  if (guardError) {
    return noStoreJson({ error: { code: guardError } }, { status: 400 });
  }

  const session = await getRequestSession(request);
  if (!session.principal) {
    const response = noStoreJson(
      { error: { code: "authentication_required" } },
      { status: 401 },
    );
    clearInvalidSessionCookie(response, session);
    return response;
  }
  try {
    requireAdminPrincipal(session.principal);
  } catch (error) {
    if (error instanceof AdminAccessError) return accessErrorResponse(error);
    throw error;
  }

  const requestId = requestCorrelationId(request);
  try {
    const [{ accountId }, body] = await Promise.all([
      context.params,
      readJsonRequestWithinLimit(request, MAX_ADMIN_ENTITLEMENT_BODY_BYTES),
    ]);
    const targetAccountId = z.string().uuid().parse(accountId);
    const parsed = bodySchema.parse(body);
    const result = await changeAdminUserEntitlement(
      getWebDatabase(),
      session.principal,
      {
        action: parsed.action,
        reason: parsed.reason,
        requestId,
        source: "admin_console",
        targetAccountId,
      },
    );
    const response = noStoreJson({
      action: result.action,
      audit_id: result.auditId,
      next_state: result.nextState,
      previous_state: result.previousState,
      target_account_id: result.targetAccountId,
    });
    response.headers.set("X-Request-ID", requestId);
    return response;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return noStoreJson({ error: { code: "request_too_large" } }, { status: 413 });
    }
    if (
      error instanceof InvalidRequestBodyError ||
      error instanceof ZodError
    ) {
      return noStoreJson(
        { error: { code: "invalid_entitlement_change" } },
        { status: 400 },
      );
    }
    if (error instanceof AdminAccessError) return accessErrorResponse(error);
    const code = serviceErrorCode(error);
    if (code === "target_account_not_found") {
      return noStoreJson({ error: { code: "account_not_found" } }, { status: 404 });
    }
    if (code === "target_account_not_active") {
      return noStoreJson({ error: { code: "account_not_active" } }, { status: 409 });
    }
    console.error("admin_entitlement_change_failed", {
      name: error instanceof Error ? error.name : "UnknownError",
      requestId,
    });
    return noStoreJson({ error: { code: "internal_error" } }, { status: 500 });
  }
}
