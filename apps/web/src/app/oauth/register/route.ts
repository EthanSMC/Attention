import {
  fingerprintLoginRequester,
  OAuthError,
  oauthScopes,
  registerPublicOAuthClient,
} from "@attention/auth";
import type { AttentionDatabase } from "@attention/db";
import type { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";

import { noStoreJson } from "../../../server/api-guard";
import { getWebDatabase } from "../../../server/db";
import {
  InvalidRequestBodyError,
  readJsonRequestWithinLimit,
  RequestBodyTooLargeError,
} from "../../../server/request-body";
import {
  trustedClientSource,
  TrustedClientSourceError,
} from "../../../server/trusted-client-source";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  application_type: z.enum(["native", "web"]).optional(),
  client_name: z.string().min(1).max(100).optional(),
  grant_types: z.array(z.string().min(1).max(200)).max(8).optional(),
  redirect_uris: z.array(z.string().max(2048)).min(1).max(8),
  response_types: z.array(z.string().min(1).max(100)).max(8).optional(),
  scope: z.string().max(2048).optional(),
  software_id: z.string().min(1).max(200).optional(),
  software_version: z.string().min(1).max(200).optional(),
  token_endpoint_auth_method: z.string().min(1).max(100).optional(),
});

function validateRequestedScope(scope: string | undefined): void {
  if (!scope) return;
  const allowed = new Set<string>(oauthScopes);
  if (scope.split(/\s+/u).filter(Boolean).some((value) => !allowed.has(value))) {
    throw new OAuthError("invalid_scope");
  }
}

export async function handleOAuthRegistrationRequest(
  request: Request,
  db: AttentionDatabase = getWebDatabase(),
): Promise<NextResponse> {
  try {
    const body = bodySchema.parse(
      await readJsonRequestWithinLimit(request, 16_384),
    );
    validateRequestedScope(body.scope);
    const clientName = body.client_name ?? body.software_id ?? "Dynamic MCP client";
    const client = await registerPublicOAuthClient(db, {
      name: clientName,
      requesterFingerprint: fingerprintLoginRequester(trustedClientSource(request)),
      redirectUris: body.redirect_uris,
    });
    return noStoreJson({
      client_id: client.clientId,
      client_id_issued_at: Math.floor(Date.now() / 1_000),
      client_name: clientName,
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: body.redirect_uris,
      response_types: ["code"],
      ...(body.application_type ? { application_type: body.application_type } : {}),
      ...(body.scope ? { scope: body.scope } : {}),
      token_endpoint_auth_method: "none",
    }, { status: 201 });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return noStoreJson({ error: "invalid_client_metadata" }, { status: 413 });
    }
    if (error instanceof TrustedClientSourceError) {
      console.error("trusted_client_source_unavailable", { route: "oauth_register" });
      return noStoreJson({ error: "temporarily_unavailable" }, { status: 503 });
    }
    const code =
      error instanceof InvalidRequestBodyError ||
      error instanceof OAuthError ||
      error instanceof ZodError
        ? "invalid_client_metadata"
        : "server_error";
    return noStoreJson({ error: code }, { status: code === "server_error" ? 500 : 400 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handleOAuthRegistrationRequest(request);
}
