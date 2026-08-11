import {
  checkOAuthConnectionName,
  createAuthorizationCode,
  isOAuthConnectionNameConflict,
  OAuthError,
  resolveRuntimeOAuthConnectionIntent,
  type OAuthConnectionIntent,
  type OAuthConnectionNameResult,
  type ValidatedAuthorizationRequest,
  validateAuthorizationRequest,
} from "@attention/auth";
import { CHANNEL_RUNTIME_RESOURCE } from "@attention/contracts";
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
  checkName: (
    database: AttentionDatabase,
    input: { accountId: string; audience: string; label: string },
  ) => Promise<OAuthConnectionNameResult>;
  createCode: (
    database: AttentionDatabase,
    accountId: string,
    authorization: ValidatedAuthorizationRequest,
    intent: OAuthConnectionIntent,
  ) => Promise<string>;
  database: AttentionDatabase;
  loadSession: (request: Request) => Promise<RequestSession>;
  resolveRuntimeIntent: typeof resolveRuntimeOAuthConnectionIntent;
  validateRequest: typeof validateAuthorizationRequest;
}

function defaultDependencies(): OAuthAuthorizationConfirmDependencies {
  return {
    checkName: checkOAuthConnectionName,
    createCode: createAuthorizationCode,
    database: getWebDatabase(),
    loadSession: getRequestSession,
    resolveRuntimeIntent: resolveRuntimeOAuthConnectionIntent,
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

function recoverableAuthorizationRedirect(
  request: Request,
  authorization: ValidatedAuthorizationRequest,
  label: string,
  error: "invalid_connection_label" | "name_conflict",
): NextResponse {
  const redirectTo = new URL("/oauth/authorize", request.url);
  redirectTo.searchParams.set("client_id", authorization.clientId);
  redirectTo.searchParams.set("code_challenge", authorization.codeChallenge);
  redirectTo.searchParams.set("code_challenge_method", "S256");
  redirectTo.searchParams.set("connection_error", error);
  redirectTo.searchParams.set("connection_label", label);
  redirectTo.searchParams.set("redirect_uri", authorization.redirectUri);
  redirectTo.searchParams.set("resource", authorization.resource);
  redirectTo.searchParams.set("response_type", "code");
  redirectTo.searchParams.set("scope", authorization.scopes.join(" "));
  if (authorization.state) redirectTo.searchParams.set("state", authorization.state);
  return noStoreRedirect(redirectTo);
}

function isInvalidConnectionLabel(error: unknown): boolean {
  return error instanceof Error && error.message === "invalid_connection_label";
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

  const connectionLabel = String(form.get("connection_label") ?? "");
  const replacementConnectionId = String(
    form.get("replacement_connection_id") ?? "",
  );
  try {
    if (authorization.audience === CHANNEL_RUNTIME_RESOURCE) {
      const intent = await dependencies.resolveRuntimeIntent(
        dependencies.database,
        {
          accountId: session.principal.accountId,
          audience: CHANNEL_RUNTIME_RESOURCE,
          clientId: authorization.clientId,
          label: connectionLabel,
          ...(replacementConnectionId ? { replacementConnectionId } : {}),
        },
      );
      const code = await dependencies.createCode(
        dependencies.database,
        session.principal.accountId,
        authorization,
        intent,
      );
      const redirectTo = new URL(authorization.redirectUri);
      redirectTo.searchParams.set("code", code);
      if (authorization.state) redirectTo.searchParams.set("state", authorization.state);
      return noStoreRedirect(redirectTo);
    }
    const name = await dependencies.checkName(dependencies.database, {
      accountId: session.principal.accountId,
      audience: authorization.audience,
      label: connectionLabel,
    });
    let intent: OAuthConnectionIntent;
    if (name.status === "replaceable") {
      if (replacementConnectionId !== name.existing.connectionId) {
        return recoverableAuthorizationRedirect(
          request,
          authorization,
          connectionLabel,
          "name_conflict",
        );
      }
      intent = {
        label: name.label,
        mode: "replace",
        replacementConnectionId: name.existing.connectionId,
      };
    } else {
      if (replacementConnectionId) {
        return recoverableAuthorizationRedirect(
          request,
          authorization,
          connectionLabel,
          "name_conflict",
        );
      }
      intent = { label: name.label, mode: "create" };
    }

    const code = await dependencies.createCode(
      dependencies.database,
      session.principal.accountId,
      authorization,
      intent,
    );
    const redirectTo = new URL(authorization.redirectUri);
    redirectTo.searchParams.set("code", code);
    if (authorization.state) redirectTo.searchParams.set("state", authorization.state);
    return noStoreRedirect(redirectTo);
  } catch (error) {
    if (isInvalidConnectionLabel(error)) {
      return recoverableAuthorizationRedirect(
        request,
        authorization,
        connectionLabel,
        "invalid_connection_label",
      );
    }
    if (isOAuthConnectionNameConflict(error)) {
      return recoverableAuthorizationRedirect(
        request,
        authorization,
        connectionLabel,
        "name_conflict",
      );
    }
    return errorResponse(error instanceof OAuthError ? error.code : "server_error", 400);
  }
}
