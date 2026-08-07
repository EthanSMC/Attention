import { oauthDefaultScopesByAudience } from "@attention/auth";
import type { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";

import { noStoreJson } from "../../../server/api-guard";
import { resolveCloudPrincipal } from "../../../server/cloud-credentials";
import { getWebDatabase } from "../../../server/db";
import { oauthResourceMetadataUrl } from "../../../server/oauth-resources";
import {
  InvalidRequestBodyError,
  readJsonRequestWithinLimit,
  RequestBodyTooLargeError,
} from "../../../server/request-body";
import { pullSyncEvents, pushSyncMutations } from "../../../server/sync-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SYNC_PUSH_REQUEST_BYTES = 8 * 1_024 * 1_024;

const mutationSchema = z.discriminatedUnion("op", [
  z.object({
    client_mutation_id: z.string().min(8).max(128),
    historical: z.boolean().default(false),
    op: z.literal("collect"),
    raw_input: z.string().trim().min(1).max(32_768),
    visibility: z.enum(["private", "public"]).default("private"),
  }).strict(),
  z.object({ client_mutation_id: z.string().min(8).max(128), collection_id: z.string().uuid(), op: z.literal("delete") }).strict(),
  z.object({ client_mutation_id: z.string().min(8).max(128), collection_id: z.string().uuid(), op: z.literal("visibility"), visibility: z.enum(["private", "public"]) }).strict(),
]);
const pushSchema = z.object({ mutations: z.array(mutationSchema).min(1).max(50) }).strict();

function unauthorized(request: Request): NextResponse {
  const response = noStoreJson({ error: { code: "invalid_token" } }, { status: 401 });
  response.headers.set(
    "WWW-Authenticate",
    `Bearer resource_metadata="${oauthResourceMetadataUrl(request, "attention-sync")}", scope="${oauthDefaultScopesByAudience["attention-sync"].join(" ")}"`,
  );
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const principal = await resolveCloudPrincipal(request, "attention-sync");
  if (!principal) return unauthorized(request);
  if (!principal.scopes.includes("sync:read")) return noStoreJson({ error: { code: "insufficient_scope" } }, { status: 403 });
  const limit = Math.min(Math.max(Number.parseInt(request.nextUrl.searchParams.get("limit") ?? "100", 10) || 100, 1), 200);
  try {
    return noStoreJson(await pullSyncEvents(getWebDatabase(), principal.accountId, {
      cursor: request.nextUrl.searchParams.get("cursor"),
      limit,
    }));
  } catch (error) {
    return noStoreJson({ error: { code: error instanceof RangeError ? "invalid_cursor" : "internal_error" } }, { status: error instanceof RangeError ? 400 : 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const principal = await resolveCloudPrincipal(request, "attention-sync");
  if (!principal) return unauthorized(request);
  if (!principal.scopes.includes("sync:write")) return noStoreJson({ error: { code: "insufficient_scope" } }, { status: 403 });
  try {
    const body = pushSchema.parse(
      await readJsonRequestWithinLimit(request, MAX_SYNC_PUSH_REQUEST_BYTES),
    );
    return noStoreJson(await pushSyncMutations(getWebDatabase(), principal, body.mutations.map((item) => ({
      clientMutationId: item.client_mutation_id,
      ...(item.op === "collect"
        ? { historical: item.historical, op: item.op, rawInput: item.raw_input, visibility: item.visibility }
        : item.op === "delete"
          ? { collectionId: item.collection_id, op: item.op }
          : { collectionId: item.collection_id, op: item.op, visibility: item.visibility }),
    }))));
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return noStoreJson({ error: { code: "request_too_large" } }, { status: 413 });
    }
    if (error instanceof InvalidRequestBodyError || error instanceof ZodError) {
      return noStoreJson({ error: { code: "invalid_request" } }, { status: 400 });
    }
    console.error("sync_push_failed", { name: error instanceof Error ? error.name : "UnknownError" });
    return noStoreJson({ error: { code: "internal_error" } }, { status: 500 });
  }
}
