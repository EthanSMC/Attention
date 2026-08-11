import {
  fingerprintLoginRequester,
  hashRuntimeInstallationId,
  OAuthError,
  OAuthRegistrationRateLimitError,
  registerPublicOAuthClient,
  resolveOAuthClientAllowedScopes,
} from "@attention/auth";
import {
  CHANNEL_RUNTIME_RESOURCE,
  CHANNEL_RUNTIME_SCOPES,
} from "@attention/contracts";
import type { AttentionDatabase } from "@attention/db";
import type { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";

import { noStoreJson } from "../../../server/api-guard";
import { getWebDatabase } from "../../../server/db";
import { oauthResourceMap } from "../../../server/oauth-resources";
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
  attention_connection_kind: z.literal("runtime").optional(),
  attention_device_name: z.string()
    .min(1)
    .max(80)
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value))
    .optional(),
  attention_installation_id: z.uuid().optional(),
  client_name: z.string().min(1).max(100).optional(),
  grant_types: z.array(z.string().min(1).max(200)).max(8).optional(),
  redirect_uris: z.array(z.string().max(2048)).min(1).max(8),
  resource: z.string().max(2048).optional(),
  response_types: z.array(z.string().min(1).max(100)).max(8).optional(),
  scope: z.string().max(2048).optional(),
  software_id: z.string().min(1).max(200).optional(),
  software_version: z.string().min(1).max(200).optional(),
  token_endpoint_auth_method: z.string().min(1).max(100).optional(),
}).superRefine((body, context) => {
  const extensionValues = [
    body.attention_connection_kind,
    body.attention_device_name,
    body.attention_installation_id,
  ];
  const supplied = extensionValues.filter((value) => value !== undefined).length;
  if (supplied !== 0 && supplied !== extensionValues.length) {
    context.addIssue({
      code: "custom",
      message: "Runtime identity metadata must be complete",
    });
  }
});

function normalizedResource(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).href;
  } catch {
    return null;
  }
}

function sanitizeDeviceName(value: string): string {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (
    !normalized ||
    normalized.length > 80 ||
    /[\p{Cc}\p{Cf}]/u.test(normalized)
  ) {
    throw new OAuthError("invalid_request");
  }
  return normalized;
}

export async function handleOAuthRegistrationRequest(
  request: Request,
  db: AttentionDatabase = getWebDatabase(),
): Promise<NextResponse> {
  try {
    const body = bodySchema.parse(
      await readJsonRequestWithinLimit(request, 16_384),
    );
    const allowedScopes = resolveOAuthClientAllowedScopes(body.scope);
    const clientName = body.client_name ?? body.software_id ?? "Dynamic OAuth client";
    const exactRuntimeScopes =
      allowedScopes.length === CHANNEL_RUNTIME_SCOPES.length &&
      allowedScopes.every((scope) =>
        (CHANNEL_RUNTIME_SCOPES as readonly string[]).includes(scope)
      );
    const runtimeResource = oauthResourceMap(request)[CHANNEL_RUNTIME_RESOURCE];
    const trustedRuntimeIdentity =
      body.attention_connection_kind === "runtime" &&
      body.attention_device_name !== undefined &&
      body.attention_installation_id !== undefined &&
      body.software_id === CHANNEL_RUNTIME_RESOURCE &&
      exactRuntimeScopes &&
      normalizedResource(body.resource) === normalizedResource(runtimeResource)
        ? {
            deviceName: sanitizeDeviceName(body.attention_device_name),
            installationKeyHash: hashRuntimeInstallationId(
              body.attention_installation_id,
            ),
          }
        : undefined;
    const client = await registerPublicOAuthClient(db, {
      allowedScopes,
      name: clientName,
      requesterFingerprint: fingerprintLoginRequester(trustedClientSource(request)),
      redirectUris: body.redirect_uris,
      ...(trustedRuntimeIdentity
        ? { runtimeIdentity: trustedRuntimeIdentity }
        : {}),
    });
    return noStoreJson({
      client_id: client.clientId,
      client_id_issued_at: Math.floor(Date.now() / 1_000),
      client_name: clientName,
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: body.redirect_uris,
      response_types: ["code"],
      ...(body.application_type ? { application_type: body.application_type } : {}),
      scope: client.allowedScopes.join(" "),
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
    if (error instanceof OAuthRegistrationRateLimitError) {
      const response = noStoreJson(
        { error: "temporarily_unavailable" },
        { status: 429 },
      );
      response.headers.set("Retry-After", String(error.retryAfterSeconds));
      return response;
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
