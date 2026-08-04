import {
  exchangeAuthorizationCode,
  OAuthError,
  rotateRefreshToken,
} from "@attention/auth";
import type { AttentionDatabase } from "@attention/db";
import type { NextRequest, NextResponse } from "next/server";

import { noStoreJson } from "../../../server/api-guard";
import { getWebDatabase } from "../../../server/db";
import { oauthResourceMap } from "../../../server/oauth-resources";
import {
  readUrlEncodedRequestWithinLimit,
  RequestBodyTooLargeError,
} from "../../../server/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_OAUTH_FORM_BODY_BYTES = 16_384;

function tokenResponse(pair: Awaited<ReturnType<typeof exchangeAuthorizationCode>>): NextResponse {
  return noStoreJson({
    access_token: pair.accessToken,
    expires_in: pair.expiresIn,
    refresh_token: pair.refreshToken,
    scope: pair.scope,
    token_type: pair.tokenType,
  });
}

export async function handleOAuthTokenRequest(
  request: Request,
  db: AttentionDatabase = getWebDatabase(),
): Promise<NextResponse> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.startsWith("application/x-www-form-urlencoded")) {
    return noStoreJson({ error: "invalid_request" }, { status: 400 });
  }
  try {
    const form = await readUrlEncodedRequestWithinLimit(
      request,
      MAX_OAUTH_FORM_BODY_BYTES,
    );
    const grantType = String(form.get("grant_type") ?? "");
    const clientId = String(form.get("client_id") ?? "");
    const resourceValues = form.getAll("resource");
    const resource = resourceValues.length === 1 ? String(resourceValues[0]) : "";
    const resources = oauthResourceMap(request);
    if (grantType === "authorization_code") {
      return tokenResponse(await exchangeAuthorizationCode(db, {
        clientId,
        code: String(form.get("code") ?? ""),
        codeVerifier: String(form.get("code_verifier") ?? ""),
        redirectUri: String(form.get("redirect_uri") ?? ""),
        resource,
        resources,
      }));
    }
    if (grantType === "refresh_token") {
      return tokenResponse(await rotateRefreshToken(db, {
        clientId,
        refreshToken: String(form.get("refresh_token") ?? ""),
        resource,
        resources,
        ...(form.get("scope") ? { scope: String(form.get("scope")) } : {}),
      }));
    }
    throw new OAuthError("unsupported_grant_type");
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return noStoreJson({ error: "invalid_request" }, { status: 413 });
    }
    const code = error instanceof OAuthError ? error.code : "invalid_request";
    return noStoreJson({ error: code }, { status: 400 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handleOAuthTokenRequest(request);
}
