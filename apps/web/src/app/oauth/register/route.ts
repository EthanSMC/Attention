import { OAuthError, registerPublicOAuthClient } from "@attention/auth";
import type { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";

import { noStoreJson } from "../../../server/api-guard";
import { getWebDatabase } from "../../../server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  client_name: z.string().min(1).max(100),
  redirect_uris: z.array(z.string().max(2048)).min(1).max(8),
  token_endpoint_auth_method: z.literal("none").optional(),
}).strict();

export async function POST(request: NextRequest): Promise<NextResponse> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 16_384) {
    return noStoreJson({ error: "invalid_client_metadata" }, { status: 413 });
  }
  try {
    const body = bodySchema.parse(await request.json());
    const client = await registerPublicOAuthClient(getWebDatabase(), {
      name: body.client_name,
      redirectUris: body.redirect_uris,
    });
    return noStoreJson({
      client_id: client.clientId,
      client_id_issued_at: Math.floor(Date.now() / 1_000),
      client_name: body.client_name,
      redirect_uris: body.redirect_uris,
      token_endpoint_auth_method: "none",
    }, { status: 201 });
  } catch (error) {
    const code = error instanceof OAuthError || error instanceof ZodError ? "invalid_client_metadata" : "server_error";
    return noStoreJson({ error: code }, { status: code === "server_error" ? 500 : 400 });
  }
}
