import { GrowthError, loadGrowthDashboard } from "@attention/auth";
import type { NextRequest, NextResponse } from "next/server";

import { noStoreJson } from "../../../../server/api-guard";
import { getWebDatabase } from "../../../../server/db";
import {
  clearInvalidSessionCookie,
  getRequestSession,
} from "../../../../server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    const dashboard = await loadGrowthDashboard(
      getWebDatabase(),
      session.principal.accountId,
    );
    return noStoreJson({
      consumer_invite: {
        can_create: dashboard.consumerInvite.canCreate,
        expires_at: dashboard.consumerInvite.expiresAt?.toISOString() ?? null,
        registered_at:
          dashboard.consumerInvite.registeredAt?.toISOString() ?? null,
        status: dashboard.consumerInvite.status,
      },
      filter_codes: dashboard.filterCodes.map((code) => ({
        created_at: code.createdAt.toISOString(),
        expires_at: code.expiresAt.toISOString(),
        id: code.id,
        issuance_year: code.issuanceYear,
        redeemed_at: code.redeemedAt?.toISOString() ?? null,
        status: code.status,
      })),
      filter_codes_issued_this_year: dashboard.filterCodesIssuedThisYear,
      is_filter: dashboard.isFilter,
      points_balances: dashboard.pointsBalances.map((balance) => ({
        available_minor: balance.availableMinor,
        clawback_minor: balance.clawbackMinor,
        currency: balance.currency,
        reserved_minor: balance.reservedMinor,
      })),
      points_entries: dashboard.pointsEntries.map((entry) => ({
        amount_minor: entry.amountMinor,
        available_delta_minor: entry.availableDeltaMinor,
        clawback_delta_minor: entry.clawbackDeltaMinor,
        currency: entry.currency,
        entry_type: entry.entryType,
        id: entry.id,
        occurred_at: entry.occurredAt.toISOString(),
        reserved_delta_minor: entry.reservedDeltaMinor,
      })),
    });
  } catch (error) {
    if (error instanceof GrowthError && error.code === "account_not_active") {
      return noStoreJson({ error: { code: error.code } }, { status: 403 });
    }
    console.error("growth_dashboard_load_failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return noStoreJson({ error: { code: "internal_error" } }, { status: 500 });
  }
}
