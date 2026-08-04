import type { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";

import { mutationRequestError, noStoreJson } from "../../../../server/api-guard";
import { retrieveForAgent } from "../../../../server/agent-retrieval";
import { getWebDatabase } from "../../../../server/db";
import {
  clearInvalidSessionCookie,
  getRequestSession,
} from "../../../../server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ query: z.string().trim().min(2).max(500) }).strict();

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guardError = mutationRequestError(request);
  if (guardError) return noStoreJson({ error: { code: guardError } }, { status: 400 });
  const requestSession = await getRequestSession(request);
  if (!requestSession.principal) {
    const response = noStoreJson({ error: { code: "authentication_required" } }, { status: 401 });
    clearInvalidSessionCookie(response, requestSession);
    return response;
  }
  if (!requestSession.principal.isMember) {
    return noStoreJson({ error: { code: "membership_required" } }, { status: 403 });
  }
  try {
    const body = bodySchema.parse(await request.json());
    return noStoreJson(
      await retrieveForAgent(
        getWebDatabase(),
        requestSession.principal.accountId,
        body.query,
      ),
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return noStoreJson({ error: { code: "invalid_query" } }, { status: 400 });
    }
    console.error("agent_retrieval_failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return noStoreJson({ error: { code: "internal_error" } }, { status: 500 });
  }
}
