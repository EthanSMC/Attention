import type { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";

import { mutationRequestError, noStoreJson } from "../../../../server/api-guard";
import {
  DigestSettingsError,
  loadDigestSettings,
  updateDigestSettings,
} from "../../../../server/digest-settings";
import { getWebDatabase } from "../../../../server/db";
import {
  InvalidRequestBodyError,
  readJsonRequestWithinLimit,
  RequestBodyTooLargeError,
} from "../../../../server/request-body";
import {
  clearInvalidSessionCookie,
  getRequestSession,
} from "../../../../server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_DIGEST_SETTINGS_BODY_BYTES = 8_192;

const bodySchema = z
  .object({
    domain_slugs: z.array(z.string().max(64)).max(20),
    enabled: z.boolean(),
    timezone: z.string().min(1).max(64),
    window_minutes: z.number().int().min(15).max(240),
    window_start: z.string().max(5),
  })
  .strict();

function apiSettings(settings: Awaited<ReturnType<typeof loadDigestSettings>>) {
  return {
    domains: settings.domains,
    enabled: settings.enabled,
    timezone: settings.timezone,
    window_minutes: settings.windowMinutes,
    window_start: settings.windowStart,
  };
}

async function authenticatedSession(request: NextRequest) {
  const requestSession = await getRequestSession(request);
  if (!requestSession.principal) {
    const response = noStoreJson(
      { error: { code: "authentication_required" } },
      { status: 401 },
    );
    clearInvalidSessionCookie(response, requestSession);
    return { response } as const;
  }
  return { principal: requestSession.principal } as const;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authentication = await authenticatedSession(request);
  if ("response" in authentication) return authentication.response;
  try {
    const settings = await loadDigestSettings(
      getWebDatabase(),
      authentication.principal.accountId,
    );
    return noStoreJson({
      eligible:
        authentication.principal.isMember || authentication.principal.isFilter,
      settings: apiSettings(settings),
    });
  } catch (error) {
    console.error("digest_settings_load_failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return noStoreJson({ error: { code: "internal_error" } }, { status: 500 });
  }
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const requestError = mutationRequestError(request);
  if (requestError) {
    return noStoreJson({ error: { code: requestError } }, { status: 400 });
  }
  const authentication = await authenticatedSession(request);
  if ("response" in authentication) return authentication.response;

  try {
    const body = bodySchema.parse(
      await readJsonRequestWithinLimit(request, MAX_DIGEST_SETTINGS_BODY_BYTES),
    );
    const settings = await updateDigestSettings(
      getWebDatabase(),
      authentication.principal.accountId,
      {
        domainSlugs: body.domain_slugs,
        enabled: body.enabled,
        timezone: body.timezone,
        windowMinutes: body.window_minutes,
        windowStart: body.window_start,
      },
    );
    return noStoreJson({ settings: apiSettings(settings) });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return noStoreJson({ error: { code: "request_too_large" } }, { status: 413 });
    }
    if (error instanceof InvalidRequestBodyError || error instanceof ZodError) {
      return noStoreJson(
        { error: { code: "invalid_digest_settings" } },
        { status: 400 },
      );
    }
    if (error instanceof DigestSettingsError) {
      return noStoreJson(
        { error: { code: error.code } },
        { status: error.code === "digest_entitlement_required" ? 403 : 400 },
      );
    }
    console.error("digest_settings_update_failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return noStoreJson({ error: { code: "internal_error" } }, { status: 500 });
  }
}
