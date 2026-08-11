import {
  checkOAuthConnectionName,
  OAuthError,
  resolveOAuthResource,
  type OAuthConnectionNameResult,
} from "@attention/auth";
import {
  and,
  eq,
  oauthClients,
  type AttentionDatabase,
} from "@attention/db";
import type { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";

import { mutationRequestError, noStoreJson } from "../../../../server/api-guard";
import { getWebDatabase } from "../../../../server/db";
import { oauthResourceMap } from "../../../../server/oauth-resources";
import {
  InvalidRequestBodyError,
  readJsonRequestWithinLimit,
  RequestBodyTooLargeError,
} from "../../../../server/request-body";
import {
  getRequestSession,
  type RequestSession,
} from "../../../../server/session";

const MAX_CONNECTION_NAME_BODY_BYTES = 4_096;

const bodySchema = z.object({
  client_id: z.string().min(1).max(128),
  label: z.string().max(512),
  resource: z.string().min(1).max(2_048),
}).strict();

interface OAuthConnectionNameDependencies {
  checkName: (
    database: AttentionDatabase,
    input: { accountId: string; audience: string; label: string },
  ) => Promise<OAuthConnectionNameResult>;
  database: AttentionDatabase;
  loadActiveClient: (
    database: AttentionDatabase,
    clientId: string,
  ) => Promise<boolean>;
  loadSession: (request: Request) => Promise<RequestSession>;
}

async function loadActiveOAuthClient(
  database: AttentionDatabase,
  clientId: string,
): Promise<boolean> {
  const [client] = await database
    .select({ clientId: oauthClients.clientId })
    .from(oauthClients)
    .where(and(eq(oauthClients.clientId, clientId), eq(oauthClients.active, true)))
    .limit(1);
  return Boolean(client);
}

function defaultDependencies(): OAuthConnectionNameDependencies {
  return {
    checkName: checkOAuthConnectionName,
    database: getWebDatabase(),
    loadActiveClient: loadActiveOAuthClient,
    loadSession: getRequestSession,
  };
}

function errorCode(error: unknown): { code: string; status: number } {
  if (error instanceof OAuthError) {
    return { code: error.code, status: 400 };
  }
  if (error instanceof Error && error.message === "invalid_connection_label") {
    return { code: "invalid_connection_label", status: 400 };
  }
  if (
    error instanceof InvalidRequestBodyError ||
    error instanceof ZodError
  ) {
    return { code: "invalid_request", status: 400 };
  }
  if (error instanceof RequestBodyTooLargeError) {
    return { code: "request_too_large", status: 413 };
  }
  return { code: "server_error", status: 500 };
}

export async function handleOAuthConnectionNameRequest(
  request: NextRequest,
  dependencies: OAuthConnectionNameDependencies = defaultDependencies(),
): Promise<NextResponse> {
  const requestError = mutationRequestError(request, {
    maxContentLengthBytes: MAX_CONNECTION_NAME_BODY_BYTES,
  });
  if (requestError) {
    return noStoreJson({ error: requestError }, { status: 400 });
  }

  const session = await dependencies.loadSession(request);
  if (!session.principal) {
    return noStoreJson(
      { error: "authentication_required" },
      { status: 401 },
    );
  }

  try {
    const body = bodySchema.parse(
      await readJsonRequestWithinLimit(request, MAX_CONNECTION_NAME_BODY_BYTES),
    );
    const resource = resolveOAuthResource(body.resource, oauthResourceMap(request));
    if (
      !(await dependencies.loadActiveClient(
        dependencies.database,
        body.client_id,
      ))
    ) {
      return noStoreJson({ error: "invalid_client" }, { status: 400 });
    }
    const result = await dependencies.checkName(dependencies.database, {
      accountId: session.principal.accountId,
      audience: resource.audience,
      label: body.label,
    });
    return noStoreJson(result);
  } catch (error) {
    const mapped = errorCode(error);
    return noStoreJson({ error: mapped.code }, { status: mapped.status });
  }
}
