import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { AdminAccessError, requireAdminPrincipal } from "../../../../../../server/admin-access";
import { listAdminEntitlementAudits } from "../../../../../../server/admin-user-entitlements";
import { noStoreJson } from "../../../../../../server/api-guard";
import { getWebDatabase } from "../../../../../../server/db";
import {
  clearInvalidSessionCookie,
  getRequestSession,
} from "../../../../../../server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ accountId: string }>;
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

function isTargetNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "target_account_not_found"
  );
}

export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
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

  let accountId: string;
  try {
    accountId = z.string().uuid().parse((await context.params).accountId);
  } catch {
    return noStoreJson({ error: { code: "invalid_account_id" } }, { status: 400 });
  }

  try {
    const audits = await listAdminEntitlementAudits(
      getWebDatabase(),
      session.principal,
      accountId,
      50,
    );
    return noStoreJson({
      items: audits.map((audit) => ({
        action: audit.action,
        actor: {
          account_id: audit.actor.accountId,
          display_name: audit.actor.displayName,
          primary_email: audit.actor.primaryEmail,
        },
        id: audit.id,
        next_state: audit.nextState,
        occurred_at: audit.occurredAt.toISOString(),
        previous_state: audit.previousState,
        reason: audit.reason,
        request_id: audit.requestId,
        source: audit.source,
        target_account_id: audit.targetAccountId,
      })),
    });
  } catch (error) {
    if (error instanceof AdminAccessError) return accessErrorResponse(error);
    if (isTargetNotFound(error)) {
      return noStoreJson({ error: { code: "account_not_found" } }, { status: 404 });
    }
    console.error("admin_entitlement_audit_list_failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return noStoreJson({ error: { code: "internal_error" } }, { status: 500 });
  }
}
