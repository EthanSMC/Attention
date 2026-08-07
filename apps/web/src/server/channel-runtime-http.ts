import "server-only";

import {
  oauthDefaultScopesByAudience,
  revokeOAuthClientConnection,
} from "@attention/auth";
import {
  CHANNEL_RUNTIME_API_VERSION,
  ChannelActivityReportSchema,
  CreateChannelBindingRequestSchema,
  DisconnectChannelBindingRequestSchema,
  InstallationHeartbeatSchema,
  InstallationIdSchema,
  PairingVerificationReportSchema,
  RegisterInstallationRequestSchema,
  RuntimeEventIdSchema,
  getAgentIntegration,
  type ChannelRuntimeScope,
  type InstallationView,
} from "@attention/contracts";
import type { AttentionDatabase } from "@attention/db";
import { z, ZodError } from "zod";

import { noStoreJson } from "./api-guard";
import {
  type OAuthCloudPrincipal,
  resolveRuntimePrincipal,
} from "./cloud-credentials";
import {
  ChannelRuntimeServiceError,
  createChannelRuntimeService,
  type ChannelRuntimeService,
  type RuntimePrincipal,
} from "./channel-runtime-service";
import { getWebDatabase } from "./db";
import { oauthResourceMetadataUrl } from "./oauth-resources";
import {
  InvalidRequestBodyError,
  readJsonRequestWithinLimit,
  RequestBodyTooLargeError,
} from "./request-body";

export const MAX_CHANNEL_RUNTIME_BODY_BYTES = 16_384;

export type ChannelRuntimeHttpService = Pick<
  ChannelRuntimeService,
  | "createChannelBinding"
  | "disconnectChannelBinding"
  | "getChannelBinding"
  | "getInstallation"
  | "listChannelBindings"
  | "listInstallations"
  | "recordChannelActivity"
  | "recordInstallationHeartbeat"
  | "registerInstallation"
  | "revokeInstallation"
  | "verifyPairing"
>;

export interface ChannelRuntimeHttpDependencies {
  createService: (database: AttentionDatabase) => ChannelRuntimeHttpService;
  getDatabase: () => AttentionDatabase;
  resolvePrincipal: (request: Request) => Promise<OAuthCloudPrincipal | null>;
  revokeClientTokens: (
    database: AttentionDatabase,
    accountId: string,
    clientId: string,
  ) => Promise<void>;
}

const installationParamsSchema = z
  .object({ installationId: InstallationIdSchema })
  .strict();
const bindingParamsSchema = z
  .object({ bindingId: z.string().uuid() })
  .strict();
const installationQuerySchema = z
  .object({ installation_id: InstallationIdSchema })
  .strict();
const revokeInstallationBodySchema = z
  .object({
    api_version: z.literal(CHANNEL_RUNTIME_API_VERSION),
    event_id: RuntimeEventIdSchema,
    reason: z.enum(["account_revoked", "security", "user_requested"]),
  })
  .strict();

class ChannelRuntimeHttpError extends Error {
  constructor(
    readonly code: "control_plane_not_supported" | "invalid_request",
    readonly status: 400 | 409,
  ) {
    super(code);
    this.name = "ChannelRuntimeHttpError";
  }
}

export function resolveChannelPairingSecret(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const secret = environment.ATTENTION_CHANNEL_PAIRING_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error(
      "ATTENTION_CHANNEL_PAIRING_SECRET must contain at least 32 characters",
    );
  }
  for (const key of [
    "ATTENTION_HMAC_SECRET",
    "ATTENTION_AUTH_SECRET",
    "ATTENTION_CHANNEL_SECRET",
    "ATTENTION_CHANNEL_ADAPTER_SECRET",
    "FETCHER_SHARED_SECRET",
  ] as const) {
    const otherSecret = environment[key]?.trim();
    if (otherSecret && secret === otherSecret) {
      throw new Error(
        `ATTENTION_CHANNEL_PAIRING_SECRET must be independent from ${key}`,
      );
    }
  }
  return secret;
}

const defaultDependencies: ChannelRuntimeHttpDependencies = {
  createService: (database) =>
    createChannelRuntimeService(database, {
      pairingSecret: resolveChannelPairingSecret(),
    }),
  getDatabase: getWebDatabase,
  resolvePrincipal: resolveRuntimePrincipal,
  revokeClientTokens: revokeOAuthClientConnection,
};

function runtimePrincipal(principal: OAuthCloudPrincipal): RuntimePrincipal {
  return { accountId: principal.accountId, clientId: principal.clientId };
}

function bearerChallenge(
  request: Request,
  requiredScope: ChannelRuntimeScope,
  errorCode?: "insufficient_scope" | "invalid_token",
): string {
  const attributes = [
    `resource_metadata="${oauthResourceMetadataUrl(request, "attention-channel-runtime")}"`,
    `scope="${requiredScope}"`,
  ];
  if (errorCode) attributes.push(`error="${errorCode}"`);
  return `Bearer ${attributes.join(", ")}`;
}

function unauthorized(
  request: Request,
  requiredScope: ChannelRuntimeScope,
) {
  const response = noStoreJson(
    { error: { code: "invalid_token" } },
    { status: 401 },
  );
  response.headers.set(
    "WWW-Authenticate",
    bearerChallenge(request, requiredScope, "invalid_token"),
  );
  return response;
}

function insufficientScope(
  request: Request,
  requiredScope: ChannelRuntimeScope,
) {
  const response = noStoreJson(
    { error: { code: "insufficient_scope" } },
    { status: 403 },
  );
  response.headers.set(
    "WWW-Authenticate",
    bearerChallenge(request, requiredScope, "insufficient_scope"),
  );
  return response;
}

function queryObject(request: Request): Record<string, string> {
  const result: Record<string, string> = {};
  const search = new URL(request.url).searchParams;
  for (const key of new Set(search.keys())) {
    const values = search.getAll(key);
    if (values.length !== 1) {
      throw new ChannelRuntimeHttpError("invalid_request", 400);
    }
    result[key] = values[0] ?? "";
  }
  return result;
}

function assertRouteIdentity(
  expected: { bindingId?: string; installationId: string },
  actual: { binding_id?: string; installation_id: string },
): void {
  if (
    expected.installationId !== actual.installation_id ||
    (expected.bindingId !== undefined && expected.bindingId !== actual.binding_id)
  ) {
    throw new ChannelRuntimeHttpError("invalid_request", 400);
  }
}

function assertRuntimeControlledInstallation(
  installation: InstallationView,
): void {
  if (
    getAgentIntegration(installation.agent_integration_id).runtime_reporting
      .mode !== "attention_runtime_oauth"
  ) {
    throw new ChannelRuntimeHttpError("control_plane_not_supported", 409);
  }
}

function assertRuntimeControlledIntegration(
  agentIntegrationId: Parameters<typeof getAgentIntegration>[0],
): void {
  if (
    getAgentIntegration(agentIntegrationId).runtime_reporting.mode !==
    "attention_runtime_oauth"
  ) {
    throw new ChannelRuntimeHttpError("control_plane_not_supported", 409);
  }
}

async function parseBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<T> {
  return schema.parse(
    await readJsonRequestWithinLimit(
      request,
      MAX_CHANNEL_RUNTIME_BODY_BYTES,
    ),
  );
}

async function runRuntimeRequest(
  request: Request,
  requiredScope: ChannelRuntimeScope,
  operation: string,
  callback: (context: {
    database: AttentionDatabase;
    dependencies: ChannelRuntimeHttpDependencies;
    principal: OAuthCloudPrincipal;
    runtimePrincipal: RuntimePrincipal;
  }) => Promise<Response>,
  dependencies: ChannelRuntimeHttpDependencies,
): Promise<Response> {
  try {
    const principal = await dependencies.resolvePrincipal(request);
    if (!principal) return unauthorized(request, requiredScope);
    if (!principal.scopes.includes(requiredScope)) {
      return insufficientScope(request, requiredScope);
    }
    const database = dependencies.getDatabase();
    return await callback({
      database,
      dependencies,
      principal,
      runtimePrincipal: runtimePrincipal(principal),
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return noStoreJson(
        { error: { code: "request_too_large" } },
        { status: 413 },
      );
    }
    if (
      error instanceof InvalidRequestBodyError ||
      error instanceof ZodError
    ) {
      return noStoreJson(
        { error: { code: "invalid_request" } },
        { status: 400 },
      );
    }
    if (
      error instanceof ChannelRuntimeServiceError ||
      error instanceof ChannelRuntimeHttpError
    ) {
      return noStoreJson(
        { error: { code: error.code } },
        { status: error.status },
      );
    }
    console.error("channel_runtime_http_failed", {
      name: error instanceof Error ? error.name : "UnknownError",
      operation,
    });
    return noStoreJson(
      { error: { code: "internal_error" } },
      { status: 500 },
    );
  }
}

export async function handleRegisterInstallation(
  request: Request,
  dependencies = defaultDependencies,
): Promise<Response> {
  return runRuntimeRequest(
    request,
    "runtime:register",
    "register_installation",
    async ({ database, dependencies, runtimePrincipal }) => {
      const input = await parseBody(request, RegisterInstallationRequestSchema);
      assertRuntimeControlledIntegration(input.agent_integration_id);
      const installation = await dependencies
        .createService(database)
        .registerInstallation(runtimePrincipal, input);
      return noStoreJson({ installation }, { status: 201 });
    },
    dependencies,
  );
}

export async function handleListInstallations(
  request: Request,
  dependencies = defaultDependencies,
): Promise<Response> {
  return runRuntimeRequest(
    request,
    "runtime:register",
    "list_installations",
    async ({ database, dependencies, runtimePrincipal }) => {
      if ([...new URL(request.url).searchParams].length > 0) {
        throw new ChannelRuntimeHttpError("invalid_request", 400);
      }
      const installations = await dependencies
        .createService(database)
        .listInstallations(runtimePrincipal);
      installations.forEach(assertRuntimeControlledInstallation);
      return noStoreJson({ installations });
    },
    dependencies,
  );
}

export async function handleGetInstallation(
  request: Request,
  rawParams: unknown,
  dependencies = defaultDependencies,
): Promise<Response> {
  return runRuntimeRequest(
    request,
    "runtime:register",
    "get_installation",
    async ({ database, dependencies, runtimePrincipal }) => {
      const { installationId } = installationParamsSchema.parse(rawParams);
      const installation = await dependencies
        .createService(database)
        .getInstallation(runtimePrincipal, installationId);
      assertRuntimeControlledInstallation(installation);
      return noStoreJson({ installation });
    },
    dependencies,
  );
}

export async function handleRevokeInstallation(
  request: Request,
  rawParams: unknown,
  dependencies = defaultDependencies,
): Promise<Response> {
  return runRuntimeRequest(
    request,
    "runtime:register",
    "revoke_installation",
    async ({ database, dependencies, principal, runtimePrincipal }) => {
      const { installationId } = installationParamsSchema.parse(rawParams);
      const body = await parseBody(request, revokeInstallationBodySchema);
      const service = dependencies.createService(database);
      const existing = await service.getInstallation(
        runtimePrincipal,
        installationId,
      );
      assertRuntimeControlledInstallation(existing);
      const result = await service.revokeInstallation(runtimePrincipal, {
        event_id: body.event_id,
        installation_id: installationId,
        reason: body.reason,
      });
      if (result.oauthClientId !== principal.clientId) {
        throw new Error("runtime_oauth_client_mismatch");
      }
      await dependencies.revokeClientTokens(
        database,
        principal.accountId,
        result.oauthClientId,
      );
      return noStoreJson({
        installation: result.installation,
        tokens_revoked: true,
      });
    },
    dependencies,
  );
}

export async function handleInstallationHeartbeat(
  request: Request,
  rawParams: unknown,
  dependencies = defaultDependencies,
): Promise<Response> {
  return runRuntimeRequest(
    request,
    "runtime:heartbeat",
    "installation_heartbeat",
    async ({ database, dependencies, runtimePrincipal }) => {
      const { installationId } = installationParamsSchema.parse(rawParams);
      const input = await parseBody(request, InstallationHeartbeatSchema);
      assertRouteIdentity({ installationId }, input);
      const service = dependencies.createService(database);
      const existing = await service.getInstallation(
        runtimePrincipal,
        installationId,
      );
      assertRuntimeControlledInstallation(existing);
      const installation = await service.recordInstallationHeartbeat(
        runtimePrincipal,
        input,
      );
      return noStoreJson({ installation });
    },
    dependencies,
  );
}

export async function handleCreateChannelBinding(
  request: Request,
  dependencies = defaultDependencies,
): Promise<Response> {
  return runRuntimeRequest(
    request,
    "channel:bind:report",
    "create_channel_binding",
    async ({ database, dependencies, runtimePrincipal }) => {
      const input = await parseBody(request, CreateChannelBindingRequestSchema);
      const service = dependencies.createService(database);
      const installation = await service.getInstallation(
        runtimePrincipal,
        input.installation_id,
      );
      assertRuntimeControlledInstallation(installation);
      const challenge = await service.createChannelBinding(
        runtimePrincipal,
        input,
      );
      return noStoreJson({ challenge }, { status: 201 });
    },
    dependencies,
  );
}

export async function handleListChannelBindings(
  request: Request,
  dependencies = defaultDependencies,
): Promise<Response> {
  return runRuntimeRequest(
    request,
    "channel:bind:report",
    "list_channel_bindings",
    async ({ database, dependencies, runtimePrincipal }) => {
      const query = installationQuerySchema.parse(queryObject(request));
      const service = dependencies.createService(database);
      const installation = await service.getInstallation(
        runtimePrincipal,
        query.installation_id,
      );
      assertRuntimeControlledInstallation(installation);
      const bindings = await service.listChannelBindings(
        runtimePrincipal,
        query.installation_id,
      );
      return noStoreJson({ bindings });
    },
    dependencies,
  );
}

export async function handleGetChannelBinding(
  request: Request,
  rawParams: unknown,
  dependencies = defaultDependencies,
): Promise<Response> {
  return runRuntimeRequest(
    request,
    "channel:bind:report",
    "get_channel_binding",
    async ({ database, dependencies, runtimePrincipal }) => {
      const { bindingId } = bindingParamsSchema.parse(rawParams);
      const query = installationQuerySchema.parse(queryObject(request));
      const service = dependencies.createService(database);
      const installation = await service.getInstallation(
        runtimePrincipal,
        query.installation_id,
      );
      assertRuntimeControlledInstallation(installation);
      const binding = await service.getChannelBinding(
        runtimePrincipal,
        query.installation_id,
        bindingId,
      );
      return noStoreJson({ binding });
    },
    dependencies,
  );
}

export async function handleVerifyChannelBinding(
  request: Request,
  rawParams: unknown,
  dependencies = defaultDependencies,
): Promise<Response> {
  return handleBindingMutation(
    request,
    rawParams,
    "channel:bind:report",
    "verify_channel_binding",
    PairingVerificationReportSchema,
    (service, principal, input) => service.verifyPairing(principal, input),
    dependencies,
  );
}

export async function handleChannelBindingActivity(
  request: Request,
  rawParams: unknown,
  dependencies = defaultDependencies,
): Promise<Response> {
  return handleBindingMutation(
    request,
    rawParams,
    "runtime:heartbeat",
    "channel_binding_activity",
    ChannelActivityReportSchema,
    (service, principal, input) =>
      service.recordChannelActivity(principal, input),
    dependencies,
  );
}

export async function handleDisconnectChannelBinding(
  request: Request,
  rawParams: unknown,
  dependencies = defaultDependencies,
): Promise<Response> {
  return handleBindingMutation(
    request,
    rawParams,
    "channel:disconnect:report",
    "disconnect_channel_binding",
    DisconnectChannelBindingRequestSchema,
    (service, principal, input) =>
      service.disconnectChannelBinding(principal, input),
    dependencies,
  );
}

async function handleBindingMutation<T extends {
  binding_id: string;
  installation_id: string;
}>(
  request: Request,
  rawParams: unknown,
  requiredScope: ChannelRuntimeScope,
  operation: string,
  schema: z.ZodType<T>,
  mutate: (
    service: ChannelRuntimeHttpService,
    principal: RuntimePrincipal,
    input: T,
  ) => Promise<unknown>,
  dependencies: ChannelRuntimeHttpDependencies,
): Promise<Response> {
  return runRuntimeRequest(
    request,
    requiredScope,
    operation,
    async ({ database, dependencies, runtimePrincipal }) => {
      const { bindingId } = bindingParamsSchema.parse(rawParams);
      const input = await parseBody(request, schema);
      assertRouteIdentity(
        { bindingId, installationId: input.installation_id },
        input,
      );
      const service = dependencies.createService(database);
      const installation = await service.getInstallation(
        runtimePrincipal,
        input.installation_id,
      );
      assertRuntimeControlledInstallation(installation);
      const binding = await mutate(service, runtimePrincipal, input);
      return noStoreJson({ binding });
    },
    dependencies,
  );
}

export const channelRuntimeRequiredScopes =
  oauthDefaultScopesByAudience["attention-channel-runtime"];
