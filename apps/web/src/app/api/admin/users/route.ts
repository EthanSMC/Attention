import type { NextRequest, NextResponse } from "next/server";

import { AdminAccessError, requireAdminPrincipal } from "../../../../server/admin-access";
import {
  listAdminUsers,
  parseAdminUserListInput,
} from "../../../../server/admin-user-entitlements";
import { noStoreJson } from "../../../../server/api-guard";
import { getWebDatabase } from "../../../../server/db";
import {
  clearInvalidSessionCookie,
  getRequestSession,
} from "../../../../server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function adminAccessErrorResponse(error: AdminAccessError): NextResponse {
  if (error.code === "admin_configuration_invalid") {
    return noStoreJson({ error: { code: "admin_unavailable" } }, { status: 503 });
  }
  return noStoreJson({ error: { code: "admin_required" } }, { status: 403 });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
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
    if (error instanceof AdminAccessError) return adminAccessErrorResponse(error);
    throw error;
  }

  const search = new URL(request.url).searchParams;
  let input;
  try {
    input = parseAdminUserListInput({
      page: search.get("page") ?? undefined,
      pageSize: search.get("page_size") ?? undefined,
      query: search.get("q") ?? undefined,
      tier: search.get("tier") ?? undefined,
    });
  } catch {
    return noStoreJson({ error: { code: "invalid_admin_query" } }, { status: 400 });
  }

  try {
    const result = await listAdminUsers(
      getWebDatabase(),
      session.principal,
      input,
    );
    return noStoreJson({
      items: result.items.map((item) => ({
        account_id: item.accountId,
        attention_id: item.attentionId,
        created_at: item.createdAt.toISOString(),
        display_name: item.displayName,
        is_filter: item.isFilter,
        is_member: item.isMember,
        primary_email: item.primaryEmail,
        status: item.status,
        tier: item.tier,
      })),
      pagination: {
        page: result.page,
        page_size: result.pageSize,
        total: result.total,
        total_pages: result.totalPages,
      },
    });
  } catch (error) {
    if (error instanceof AdminAccessError) return adminAccessErrorResponse(error);
    console.error("admin_user_list_failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return noStoreJson({ error: { code: "internal_error" } }, { status: 500 });
  }
}
