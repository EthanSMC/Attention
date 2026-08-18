import {
  createAuthorizationCode,
  OAuthError,
  type OAuthConnectionIntent,
  type ValidatedAuthorizationRequest,
  validateAuthorizationRequest,
} from "@attention/auth";
import type { AttentionDatabase } from "@attention/db";
import type { NextRequest, NextResponse } from "next/server";

import { mutationRequestError } from "../../../../server/api-guard";
import { getWebDatabase } from "../../../../server/db";
import { oauthResourceMap } from "../../../../server/oauth-resources";
import {
  readUrlEncodedRequestWithinLimit,
  RequestBodyTooLargeError,
} from "../../../../server/request-body";
import {
  getRequestSession,
  type RequestSession,
} from "../../../../server/session";

const MAX_AUTHORIZATION_CONFIRM_BODY_BYTES = 16_384;

function errorResponse(code: string, status: number): NextResponse {
  return new Response(code, { headers: { "Cache-Control": "no-store" }, status }) as NextResponse;
}

interface OAuthAuthorizationConfirmDependencies {
  createCode: (
    database: AttentionDatabase,
    accountId: string,
    authorization: ValidatedAuthorizationRequest,
    intent: OAuthConnectionIntent,
  ) => Promise<string>;
  database: AttentionDatabase;
  loadSession: (request: Request) => Promise<RequestSession>;
  validateRequest: typeof validateAuthorizationRequest;
}

function defaultDependencies(): OAuthAuthorizationConfirmDependencies {
  return {
    createCode: createAuthorizationCode,
    database: getWebDatabase(),
    loadSession: getRequestSession,
    validateRequest: validateAuthorizationRequest,
  };
}

function noStoreRedirect(location: URL): NextResponse {
  return new Response(null, {
    headers: {
      "Cache-Control": "no-store",
      Location: location.toString(),
      "Referrer-Policy": "no-referrer",
    },
    status: 303,
  }) as NextResponse;
}

export async function handleOAuthAuthorizationConfirmRequest(
  request: NextRequest,
  dependencies: OAuthAuthorizationConfirmDependencies = defaultDependencies(),
): Promise<NextResponse> {
  const guardError = mutationRequestError(request);
  if (guardError) return errorResponse(guardError, 400);
  const session = await dependencies.loadSession(request);
  if (!session.principal) return errorResponse("authentication_required", 401);

  let form: URLSearchParams;
  let authorization: ValidatedAuthorizationRequest;
  try {
    form = await readUrlEncodedRequestWithinLimit(
      request,
      MAX_AUTHORIZATION_CONFIRM_BODY_BYTES,
    );
    const resources = form.getAll("resource");
    authorization = await dependencies.validateRequest(dependencies.database, {
      clientId: String(form.get("client_id") ?? ""),
      codeChallenge: String(form.get("code_challenge") ?? ""),
      codeChallengeMethod: String(form.get("code_challenge_method") ?? ""),
      redirectUri: String(form.get("redirect_uri") ?? ""),
      resource: resources.length === 1 ? String(resources[0]) : "",
      resources: oauthResourceMap(request),
      responseType: String(form.get("response_type") ?? ""),
      scope: String(form.get("scope") ?? ""),
      state: typeof form.get("state") === "string" ? String(form.get("state")) : null,
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return errorResponse("request_too_large", 413);
    }
    const code = error instanceof OAuthError
      ? error.code
      : error instanceof Error && error.message === "invalid_request"
        ? "invalid_request"
        : "server_error";
    return errorResponse(code, 400);
  }

  try {
    const code = await dependencies.createCode(
      dependencies.database,
      session.principal.accountId,
      authorization,
      { mode: "auto" },
    );
    const redirectTo = new URL(authorization.redirectUri);
    redirectTo.searchParams.set("code", code);
    if (authorization.state) redirectTo.searchParams.set("state", authorization.state);
    return noStoreRedirect(redirectTo);
  } catch (error) {
    return errorResponse(error instanceof OAuthError ? error.code : "server_error", 400);
  }
}
