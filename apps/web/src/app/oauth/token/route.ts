import {
  exchangeAuthorizationCode,
  OAuthError,
  rotateRefreshToken,
} from "@attention/auth";
import type { NextRequest, NextResponse } from "next/server";

import { noStoreJson } from "../../../server/api-guard";
import { getWebDatabase } from "../../../server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function tokenResponse(pair: Awaited<ReturnType<typeof exchangeAuthorizationCode>>): NextResponse {
  return noStoreJson({
    access_token: pair.accessToken,
    expires_in: pair.expiresIn,
    refresh_token: pair.refreshToken,
    scope: pair.scope,
    token_type: pair.tokenType,
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 16_384) {
    return noStoreJson({ error: "invalid_request" }, { status: 413 });
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.startsWith("application/x-www-form-urlencoded")) {
    return noStoreJson({ error: "invalid_request" }, { status: 400 });
  }
  try {
    const form = await request.formData();
    const grantType = String(form.get("grant_type") ?? "");
    const clientId = String(form.get("client_id") ?? "");
    if (grantType === "authorization_code") {
      return tokenResponse(await exchangeAuthorizationCode(getWebDatabase(), {
        clientId,
        code: String(form.get("code") ?? ""),
        codeVerifier: String(form.get("code_verifier") ?? ""),
        redirectUri: String(form.get("redirect_uri") ?? ""),
      }));
    }
    if (grantType === "refresh_token") {
      return tokenResponse(await rotateRefreshToken(getWebDatabase(), {
        clientId,
        refreshToken: String(form.get("refresh_token") ?? ""),
        ...(form.get("scope") ? { scope: String(form.get("scope")) } : {}),
      }));
    }
    throw new OAuthError("unsupported_grant_type");
  } catch (error) {
    const code = error instanceof OAuthError ? error.code : "invalid_request";
    return noStoreJson({ error: code }, { status: 400 });
  }
}
