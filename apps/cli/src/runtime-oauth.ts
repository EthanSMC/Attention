import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  CHANNEL_RUNTIME_RESOURCE,
  CHANNEL_RUNTIME_SCOPES,
  type ChannelRuntimeScope,
} from "@attention/contracts";

import { runCommand } from "./command-runner";
import { normalizeAttentionOrigin } from "./origin";
import { ATTENTION_CLI_VERSION } from "./version";

const RUNTIME_CREDENTIAL_VERSION = 1 as const;
const RUNTIME_CREDENTIAL_MAXIMUM_BYTES = 65_536;
const RUNTIME_OAUTH_MAXIMUM_RESPONSE_BYTES = 65_536;
const RUNTIME_OAUTH_TIMEOUT_MS = 15_000;
const RUNTIME_CALLBACK_TIMEOUT_MS = 5 * 60 * 1_000;
const RUNTIME_ACCESS_TOKEN_SKEW_MS = 30_000;
const RUNTIME_CLIENT_NAME = "Attention Local Channel Runtime";
const RUNTIME_SCOPE = CHANNEL_RUNTIME_SCOPES.join(" ");
const activeRefreshes = new Map<string, Promise<string>>();

export type RuntimeOAuthErrorCode =
  | "runtime_credential_invalid"
  | "runtime_credential_not_configured"
  | "runtime_credential_permissions"
  | "runtime_oauth_browser_failed"
  | "runtime_oauth_callback_failed"
  | "runtime_oauth_callback_invalid"
  | "runtime_oauth_http_failed"
  | "runtime_oauth_metadata_invalid"
  | "runtime_oauth_registration_invalid"
  | "runtime_oauth_state_mismatch"
  | "runtime_oauth_token_invalid";

export class RuntimeOAuthError extends Error {
  constructor(readonly code: RuntimeOAuthErrorCode) {
    super(code);
    this.name = "RuntimeOAuthError";
  }
}

export interface RuntimeCredential {
  readonly access_token: string;
  readonly access_token_expires_at: string;
  readonly audience: typeof CHANNEL_RUNTIME_RESOURCE;
  readonly authorization_server: string;
  readonly client_id: string;
  readonly protected_resource_metadata_url: string;
  readonly refresh_token: string;
  readonly resource: string;
  readonly scopes: readonly ChannelRuntimeScope[];
  readonly token_type: "Bearer";
  readonly version: typeof RUNTIME_CREDENTIAL_VERSION;
}

export interface RuntimeCallbackServer {
  readonly close: () => Promise<void>;
  readonly redirectUri: string;
  readonly waitForCallback: () => Promise<URL>;
}

export interface AuthorizeRuntimeInput {
  readonly createCallbackServer?: (
    expectedState: string,
  ) => Promise<RuntimeCallbackServer>;
  readonly credentialPath?: string;
  readonly deviceName: string;
  readonly fetchImpl?: typeof fetch;
  readonly installationId: string;
  readonly now?: () => Date;
  readonly openBrowser?: (authorizationUrl: string) => Promise<void>;
  readonly origin: string;
}

export type RuntimeAuthorizer = (
  input: AuthorizeRuntimeInput,
) => Promise<RuntimeCredential>;

export interface RuntimeCredentialOptions {
  readonly credentialPath?: string;
}

export interface RuntimeAccessTokenOptions extends RuntimeCredentialOptions {
  readonly fetchImpl?: typeof fetch;
  readonly forceRefresh?: boolean;
  readonly now?: () => Date;
}

interface ProtectedResourceMetadata {
  readonly authorizationServer: string;
  readonly metadataUrl: string;
  readonly resource: string;
}

interface AuthorizationServerMetadata {
  readonly authorizationEndpoint: string;
  readonly issuer: string;
  readonly registrationEndpoint: string;
  readonly tokenEndpoint: string;
}

interface RuntimeTokenResponse {
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly refreshToken: string;
}

function runtimeError(code: RuntimeOAuthErrorCode): never {
  throw new RuntimeOAuthError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function secureUrl(value: unknown): string {
  if (typeof value !== "string") runtimeError("runtime_oauth_metadata_invalid");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    runtimeError("runtime_oauth_metadata_invalid");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(
    url.hostname,
  );
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) {
    runtimeError("runtime_oauth_metadata_invalid");
  }
  return url.toString();
}

function issuerUrl(value: unknown): string {
  const url = new URL(secureUrl(value));
  if (url.pathname !== "/" || url.search) {
    runtimeError("runtime_oauth_metadata_invalid");
  }
  return url.origin;
}

function endpointUrl(value: unknown, issuer: string): string {
  const endpoint = new URL(secureUrl(value));
  if (endpoint.origin !== new URL(issuer).origin) {
    runtimeError("runtime_oauth_metadata_invalid");
  }
  return endpoint.toString();
}

function stringArray(
  value: unknown,
  invalidCode: RuntimeOAuthErrorCode = "runtime_oauth_metadata_invalid",
): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    runtimeError(invalidCode);
  }
  return value as string[];
}

function exactRuntimeScopes(
  value: unknown,
  invalidCode: RuntimeOAuthErrorCode = "runtime_oauth_metadata_invalid",
): readonly ChannelRuntimeScope[] {
  const values = typeof value === "string"
    ? value.split(/\s+/u).filter(Boolean)
    : stringArray(value, invalidCode);
  const expected = new Set<string>(CHANNEL_RUNTIME_SCOPES);
  if (
    values.length !== CHANNEL_RUNTIME_SCOPES.length ||
    new Set(values).size !== CHANNEL_RUNTIME_SCOPES.length ||
    values.some((scope) => !expected.has(scope))
  ) {
    runtimeError(invalidCode);
  }
  return [...CHANNEL_RUNTIME_SCOPES];
}

function runtimeMetadataUrl(originValue: string): string {
  const origin = normalizeAttentionOrigin(originValue);
  return new URL(
    "/.well-known/oauth-protected-resource/api/runtime",
    `${origin}/`,
  ).toString();
}

function authorizationServerMetadataUrl(issuer: string): string {
  return new URL(
    "/.well-known/oauth-authorization-server",
    `${issuer}/`,
  ).toString();
}

async function fetchJson(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      headers: {
        Accept: "application/json",
        "User-Agent": `attention-cli/${ATTENTION_CLI_VERSION}`,
        ...init.headers,
      },
      redirect: "manual",
      signal: init.signal ?? AbortSignal.timeout(RUNTIME_OAUTH_TIMEOUT_MS),
    });
  } catch {
    runtimeError("runtime_oauth_http_failed");
  }
  if (!response.ok) runtimeError("runtime_oauth_http_failed");
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > RUNTIME_OAUTH_MAXIMUM_RESPONSE_BYTES
  ) {
    runtimeError("runtime_oauth_http_failed");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > RUNTIME_OAUTH_MAXIMUM_RESPONSE_BYTES) {
    runtimeError("runtime_oauth_http_failed");
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    runtimeError("runtime_oauth_http_failed");
  }
}

async function discoverProtectedResource(
  metadataUrl: string,
  fetchImpl: typeof fetch,
): Promise<ProtectedResourceMetadata> {
  const parsed = await fetchJson(metadataUrl, { method: "GET" }, fetchImpl);
  if (!isRecord(parsed)) runtimeError("runtime_oauth_metadata_invalid");
  const authorizationServers = stringArray(parsed.authorization_servers);
  if (authorizationServers.length !== 1) {
    runtimeError("runtime_oauth_metadata_invalid");
  }
  exactRuntimeScopes(parsed.scopes_supported);
  const bearerMethods = stringArray(parsed.bearer_methods_supported);
  if (!bearerMethods.includes("header")) {
    runtimeError("runtime_oauth_metadata_invalid");
  }
  return {
    authorizationServer: issuerUrl(authorizationServers[0]),
    metadataUrl: secureUrl(metadataUrl),
    resource: secureUrl(parsed.resource),
  };
}

async function discoverAuthorizationServer(
  issuer: string,
  fetchImpl: typeof fetch,
): Promise<AuthorizationServerMetadata> {
  const parsed = await fetchJson(
    authorizationServerMetadataUrl(issuer),
    { method: "GET" },
    fetchImpl,
  );
  if (!isRecord(parsed) || issuerUrl(parsed.issuer) !== issuer) {
    runtimeError("runtime_oauth_metadata_invalid");
  }
  const challengeMethods = stringArray(parsed.code_challenge_methods_supported);
  const grantTypes = stringArray(parsed.grant_types_supported);
  const responseTypes = stringArray(parsed.response_types_supported);
  const tokenAuthMethods = stringArray(
    parsed.token_endpoint_auth_methods_supported,
  );
  if (
    !challengeMethods.includes("S256") ||
    !grantTypes.includes("authorization_code") ||
    !grantTypes.includes("refresh_token") ||
    !responseTypes.includes("code") ||
    !tokenAuthMethods.includes("none")
  ) {
    runtimeError("runtime_oauth_metadata_invalid");
  }
  const supportedScopes = new Set(stringArray(parsed.scopes_supported));
  if (CHANNEL_RUNTIME_SCOPES.some((scope) => !supportedScopes.has(scope))) {
    runtimeError("runtime_oauth_metadata_invalid");
  }
  return {
    authorizationEndpoint: endpointUrl(parsed.authorization_endpoint, issuer),
    issuer,
    registrationEndpoint: endpointUrl(parsed.registration_endpoint, issuer),
    tokenEndpoint: endpointUrl(parsed.token_endpoint, issuer),
  };
}

async function registerRuntimeClient(
  metadata: AuthorizationServerMetadata,
  redirectUri: string,
  resource: string,
  identity: Pick<AuthorizeRuntimeInput, "deviceName" | "installationId">,
  fetchImpl: typeof fetch,
): Promise<string> {
  const parsed = await fetchJson(
    metadata.registrationEndpoint,
    {
      body: JSON.stringify({
        application_type: "native",
        attention_connection_kind: "runtime",
        attention_device_name: identity.deviceName,
        attention_installation_id: identity.installationId,
        client_name: RUNTIME_CLIENT_NAME,
        grant_types: ["authorization_code", "refresh_token"],
        redirect_uris: [redirectUri],
        resource,
        response_types: ["code"],
        scope: RUNTIME_SCOPE,
        software_id: CHANNEL_RUNTIME_RESOURCE,
        software_version: ATTENTION_CLI_VERSION,
        token_endpoint_auth_method: "none",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
    fetchImpl,
  );
  if (!isRecord(parsed) || Object.hasOwn(parsed, "client_secret")) {
    runtimeError("runtime_oauth_registration_invalid");
  }
  const grantTypes = stringArray(
    parsed.grant_types,
    "runtime_oauth_registration_invalid",
  );
  const responseTypes = stringArray(
    parsed.response_types,
    "runtime_oauth_registration_invalid",
  );
  if (
    parsed.application_type !== "native" ||
    typeof parsed.client_id !== "string" ||
    !parsed.client_id ||
    parsed.client_id.length > 256 ||
    parsed.token_endpoint_auth_method !== "none" ||
    !stringArray(
      parsed.redirect_uris,
      "runtime_oauth_registration_invalid",
    ).includes(redirectUri) ||
    grantTypes.length !== 2 ||
    !grantTypes.includes("authorization_code") ||
    !grantTypes.includes("refresh_token") ||
    responseTypes.length !== 1 ||
    responseTypes[0] !== "code"
  ) {
    runtimeError("runtime_oauth_registration_invalid");
  }
  exactRuntimeScopes(parsed.scope, "runtime_oauth_registration_invalid");
  return parsed.client_id;
}

function boundedToken(value: unknown): string {
  if (typeof value !== "string" || value.length < 16 || value.length > 8192) {
    runtimeError("runtime_oauth_token_invalid");
  }
  return value;
}

function parseTokenResponse(value: unknown): RuntimeTokenResponse {
  if (!isRecord(value) || value.token_type !== "Bearer") {
    runtimeError("runtime_oauth_token_invalid");
  }
  exactRuntimeScopes(value.scope, "runtime_oauth_token_invalid");
  if (
    typeof value.expires_in !== "number" ||
    !Number.isInteger(value.expires_in) ||
    value.expires_in <= 0 ||
    value.expires_in > 7 * 24 * 60 * 60
  ) {
    runtimeError("runtime_oauth_token_invalid");
  }
  return {
    accessToken: boundedToken(value.access_token),
    expiresIn: value.expires_in,
    refreshToken: boundedToken(value.refresh_token),
  };
}

async function requestToken(
  tokenEndpoint: string,
  form: URLSearchParams,
  fetchImpl: typeof fetch,
): Promise<RuntimeTokenResponse> {
  const parsed = await fetchJson(
    tokenEndpoint,
    {
      body: form.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    },
    fetchImpl,
  );
  return parseTokenResponse(parsed);
}

function defaultCredentialPath(): string {
  return join(homedir(), ".attention", "runtime", "credentials.json");
}

function credentialPath(options: RuntimeCredentialOptions): string {
  return options.credentialPath ?? defaultCredentialPath();
}

async function restrictedStat(
  path: string,
  expectedKind: "directory" | "file",
): Promise<Awaited<ReturnType<typeof lstat>>> {
  const result = await lstat(path);
  const validKind = expectedKind === "directory"
    ? result.isDirectory()
    : result.isFile();
  if (result.isSymbolicLink() || !validKind) {
    runtimeError("runtime_credential_invalid");
  }
  if (process.platform !== "win32" && (result.mode & 0o077) !== 0) {
    runtimeError("runtime_credential_permissions");
  }
  return result;
}

async function saveRuntimeCredential(
  path: string,
  credential: RuntimeCredential,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { mode: 0o700, recursive: true });
  const directoryStat = await lstat(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    runtimeError("runtime_credential_invalid");
  }
  await chmod(directory, 0o700);
  await restrictedStat(directory, "directory");
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      runtimeError("runtime_credential_invalid");
    }
  } catch (error) {
    if (
      !(error instanceof Error &&
        "code" in error &&
        Reflect.get(error, "code") === "ENOENT")
    ) {
      throw error;
    }
  }
  const temporary = join(
    directory,
    `.credentials-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(credential)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

function credentialKeysAreExact(value: Record<string, unknown>): boolean {
  const expected = [
    "access_token",
    "access_token_expires_at",
    "audience",
    "authorization_server",
    "client_id",
    "protected_resource_metadata_url",
    "refresh_token",
    "resource",
    "scopes",
    "token_type",
    "version",
  ].sort();
  const actual = Object.keys(value).sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function parseCredential(value: unknown): RuntimeCredential {
  if (
    !isRecord(value) ||
    !credentialKeysAreExact(value) ||
    value.version !== RUNTIME_CREDENTIAL_VERSION ||
    value.audience !== CHANNEL_RUNTIME_RESOURCE ||
    value.token_type !== "Bearer" ||
    typeof value.client_id !== "string" ||
    !value.client_id ||
    value.client_id.length > 256 ||
    typeof value.access_token_expires_at !== "string" ||
    !Number.isFinite(Date.parse(value.access_token_expires_at))
  ) {
    runtimeError("runtime_credential_invalid");
  }
  let scopes: readonly ChannelRuntimeScope[];
  let authorizationServer: string;
  let metadataUrl: string;
  let resource: string;
  try {
    scopes = exactRuntimeScopes(value.scopes);
    authorizationServer = issuerUrl(value.authorization_server);
    metadataUrl = secureUrl(value.protected_resource_metadata_url);
    resource = secureUrl(value.resource);
  } catch {
    runtimeError("runtime_credential_invalid");
  }
  if (
    new URL(metadataUrl).pathname !==
      "/.well-known/oauth-protected-resource/api/runtime"
  ) {
    runtimeError("runtime_credential_invalid");
  }
  let accessToken: string;
  let refreshToken: string;
  try {
    accessToken = boundedToken(value.access_token);
    refreshToken = boundedToken(value.refresh_token);
  } catch {
    runtimeError("runtime_credential_invalid");
  }
  return {
    access_token: accessToken,
    access_token_expires_at: value.access_token_expires_at,
    audience: CHANNEL_RUNTIME_RESOURCE,
    authorization_server: authorizationServer,
    client_id: value.client_id,
    protected_resource_metadata_url: metadataUrl,
    refresh_token: refreshToken,
    resource,
    scopes,
    token_type: "Bearer",
    version: RUNTIME_CREDENTIAL_VERSION,
  };
}

export async function loadRuntimeCredential(
  options: RuntimeCredentialOptions = {},
): Promise<RuntimeCredential | null> {
  const path = credentialPath(options);
  let file;
  try {
    await restrictedStat(dirname(path), "directory");
    file = await restrictedStat(path, "file");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      Reflect.get(error, "code") === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
  if (file.size > RUNTIME_CREDENTIAL_MAXIMUM_BYTES) {
    runtimeError("runtime_credential_invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    runtimeError("runtime_credential_invalid");
  }
  return parseCredential(parsed);
}

export async function clearRuntimeCredential(
  options: RuntimeCredentialOptions = {},
): Promise<void> {
  const path = credentialPath(options);
  try {
    const existing = await lstat(path);
    if (existing.isDirectory()) runtimeError("runtime_credential_invalid");
    await rm(path, { force: true });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      Reflect.get(error, "code") === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

async function defaultOpenBrowser(url: string): Promise<void> {
  const invocation = process.platform === "darwin"
    ? { args: [url], executable: "open" }
    : process.platform === "win32"
    ? { args: [url], executable: "explorer.exe" }
    : { args: [url], executable: "xdg-open" };
  const result = await runCommand(invocation, { timeoutMs: 10_000 });
  if (result.exitCode !== 0 || result.timedOut) {
    runtimeError("runtime_oauth_browser_failed");
  }
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

export type RuntimeOAuthCallbackPageState =
  | "received"
  | "cancelled"
  | "invalid"
  | "not_found";

const CALLBACK_PAGE_COPY: Readonly<
  Record<
    RuntimeOAuthCallbackPageState,
    { readonly detail: string; readonly eyebrow: string; readonly title: string }
  >
> = {
  cancelled: {
    detail: "没有保存设备状态同步凭证。你可以关闭此页面，返回终端继续。",
    eyebrow: "授权已结束",
    title: "授权已取消",
  },
  invalid: {
    detail: "请关闭此页面，返回终端重新发起授权。",
    eyebrow: "请求无效",
    title: "无法完成授权",
  },
  not_found: {
    detail: "请关闭此页面，返回终端检查授权流程。",
    eyebrow: "地址无效",
    title: "页面不存在",
  },
  received: {
    detail: "请返回终端完成凭据交换和保存。在终端确认成功前，设备状态同步尚未启用。",
    eyebrow: "授权已返回",
    title: "已收到授权结果",
  },
};

export function renderRuntimeOAuthCallbackPage(
  state: RuntimeOAuthCallbackPageState,
): string {
  const copy = CALLBACK_PAGE_COPY[state];
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${copy.title} · Attention</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif; background: #ffffff; color: #1d1d1f; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: #ffffff; }
    main { width: min(100%, 520px); border: 1px solid #e5e5e7; border-radius: 16px; padding: clamp(28px, 7vw, 48px); box-shadow: 0 16px 48px rgba(0, 0, 0, 0.06); }
    .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 56px; font-size: 18px; font-weight: 650; letter-spacing: -0.02em; }
    .mark { width: 32px; height: 32px; border-radius: 10px; background: #1d1d1f; display: grid; grid-template-columns: 1fr 1fr; place-items: center; padding: 7px; gap: 3px; }
    .mark::before, .mark::after { content: ""; width: 7px; height: 7px; border-radius: 999px; background: #0066ff; }
    .mark::before { background: #ff6b61; }
    .eyebrow { margin: 0 0 12px; color: #6e6e73; font-size: 14px; font-weight: 600; }
    h1 { margin: 0; font-size: clamp(32px, 8vw, 48px); line-height: 1.04; letter-spacing: -0.055em; }
    p { margin: 24px 0 0; color: #6e6e73; font-size: 17px; line-height: 1.6; }
    .signal { width: 40px; height: 3px; margin-top: 40px; border-radius: 999px; background: #0066ff; }
  </style>
</head>
<body>
  <main>
    <div class="brand"><span class="mark" aria-hidden="true"></span>Attention</div>
    <div class="eyebrow">${copy.eyebrow}</div>
    <h1>${copy.title}</h1>
    <p>${copy.detail}</p>
    <div class="signal" aria-hidden="true"></div>
  </main>
</body>
</html>`;
}

export function runtimeOAuthCallbackHeaders(): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "Content-Type": "text/html; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

async function createLoopbackCallbackServer(
  expectedState: string,
): Promise<RuntimeCallbackServer> {
  let resolveCallback: (url: URL) => void = () => undefined;
  let rejectCallback: (error: Error) => void = () => undefined;
  const callback = new Promise<URL>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  let redirectUri = "";
  const server = createServer((request, response) => {
    if (!request.url || !redirectUri) {
      response.writeHead(400, runtimeOAuthCallbackHeaders()).end(
        renderRuntimeOAuthCallbackPage("invalid"),
      );
      return;
    }
    const callbackUrl = new URL(request.url, redirectUri);
    if (callbackUrl.pathname !== "/oauth/callback") {
      response.writeHead(404, runtimeOAuthCallbackHeaders()).end(
        renderRuntimeOAuthCallbackPage("not_found"),
      );
      return;
    }
    const states = callbackUrl.searchParams.getAll("state");
    const stateMatches =
      states.length === 1 && secureStringEqual(states[0] ?? "", expectedState);
    const pageState: RuntimeOAuthCallbackPageState = !stateMatches
      ? "invalid"
      : callbackUrl.searchParams.has("error")
      ? "cancelled"
      : callbackUrl.searchParams.getAll("code").length === 1
      ? "received"
      : "invalid";
    response.writeHead(
      pageState === "invalid" ? 400 : 200,
      runtimeOAuthCallbackHeaders(),
    )
      .end(renderRuntimeOAuthCallbackPage(pageState));
    resolveCallback(callbackUrl);
  });
  server.once("error", (error) => rejectCallback(error));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  }).catch(() => runtimeError("runtime_oauth_callback_failed"));
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    runtimeError("runtime_oauth_callback_failed");
  }
  redirectUri = `http://127.0.0.1:${String(address.port)}/oauth/callback`;
  const timeout = setTimeout(
    () => rejectCallback(new RuntimeOAuthError("runtime_oauth_callback_failed")),
    RUNTIME_CALLBACK_TIMEOUT_MS,
  );
  timeout.unref();
  return {
    close: async () => {
      clearTimeout(timeout);
      await closeServer(server);
    },
    redirectUri,
    waitForCallback: async () => callback,
  };
}

function secureStringEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes);
}

function authorizationCallback(url: URL, expectedState: string): string {
  const states = url.searchParams.getAll("state");
  const codes = url.searchParams.getAll("code");
  const errors = url.searchParams.getAll("error");
  if (
    states.length !== 1 ||
    !secureStringEqual(states[0] ?? "", expectedState)
  ) {
    runtimeError("runtime_oauth_state_mismatch");
  }
  if (errors.length > 0 || codes.length !== 1 || !codes[0]) {
    runtimeError("runtime_oauth_callback_invalid");
  }
  return codes[0];
}

function credentialFromToken(input: {
  authorizationServer: string;
  clientId: string;
  metadataUrl: string;
  now: Date;
  resource: string;
  token: RuntimeTokenResponse;
}): RuntimeCredential {
  return {
    access_token: input.token.accessToken,
    access_token_expires_at: new Date(
      input.now.getTime() + input.token.expiresIn * 1_000,
    ).toISOString(),
    audience: CHANNEL_RUNTIME_RESOURCE,
    authorization_server: input.authorizationServer,
    client_id: input.clientId,
    protected_resource_metadata_url: input.metadataUrl,
    refresh_token: input.token.refreshToken,
    resource: input.resource,
    scopes: [...CHANNEL_RUNTIME_SCOPES],
    token_type: "Bearer",
    version: RUNTIME_CREDENTIAL_VERSION,
  };
}

export const authorizeRuntime: RuntimeAuthorizer = async (
  input,
): Promise<RuntimeCredential> => {
  const fetchImpl = input.fetchImpl ?? fetch;
  const state = randomBytes(32).toString("base64url");
  const callbackServer = await (
    input.createCallbackServer ?? createLoopbackCallbackServer
  )(state);
  try {
    const protectedResource = await discoverProtectedResource(
      runtimeMetadataUrl(input.origin),
      fetchImpl,
    );
    const authorizationServer = await discoverAuthorizationServer(
      protectedResource.authorizationServer,
      fetchImpl,
    );
    const clientId = await registerRuntimeClient(
      authorizationServer,
      callbackServer.redirectUri,
      protectedResource.resource,
      input,
      fetchImpl,
    );
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256")
      .update(verifier)
      .digest("base64url");
    const authorizationUrl = new URL(
      authorizationServer.authorizationEndpoint,
    );
    authorizationUrl.searchParams.set("client_id", clientId);
    authorizationUrl.searchParams.set("code_challenge", challenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    authorizationUrl.searchParams.set("redirect_uri", callbackServer.redirectUri);
    authorizationUrl.searchParams.set("resource", protectedResource.resource);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("scope", RUNTIME_SCOPE);
    authorizationUrl.searchParams.set("state", state);
    await (input.openBrowser ?? defaultOpenBrowser)(authorizationUrl.toString());
    const code = authorizationCallback(
      await callbackServer.waitForCallback(),
      state,
    );
    const token = await requestToken(
      authorizationServer.tokenEndpoint,
      new URLSearchParams({
        client_id: clientId,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: callbackServer.redirectUri,
        resource: protectedResource.resource,
      }),
      fetchImpl,
    );
    const credential = credentialFromToken({
      authorizationServer: authorizationServer.issuer,
      clientId,
      metadataUrl: protectedResource.metadataUrl,
      now: input.now?.() ?? new Date(),
      resource: protectedResource.resource,
      token,
    });
    await saveRuntimeCredential(
      credentialPath(input),
      credential,
    );
    return credential;
  } finally {
    await callbackServer.close();
  }
};

export async function runtimeAccessToken(
  options: RuntimeAccessTokenOptions = {},
): Promise<string> {
  const path = credentialPath(options);
  const existingRefresh = activeRefreshes.get(path);
  if (existingRefresh) return existingRefresh;
  const credential = await loadRuntimeCredential(options);
  if (!credential) runtimeError("runtime_credential_not_configured");
  const now = options.now?.() ?? new Date();
  if (
    !options.forceRefresh &&
    Date.parse(credential.access_token_expires_at) - now.getTime() >
      RUNTIME_ACCESS_TOKEN_SKEW_MS
  ) {
    return credential.access_token;
  }
  const refreshAfterLoad = activeRefreshes.get(path);
  if (refreshAfterLoad) return refreshAfterLoad;
  const refresh = refreshRuntimeAccessToken(options, credential, now, path);
  activeRefreshes.set(path, refresh);
  try {
    return await refresh;
  } finally {
    if (activeRefreshes.get(path) === refresh) activeRefreshes.delete(path);
  }
}

async function refreshRuntimeAccessToken(
  options: RuntimeAccessTokenOptions,
  credential: RuntimeCredential,
  now: Date,
  path: string,
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const protectedResource = await discoverProtectedResource(
    credential.protected_resource_metadata_url,
    fetchImpl,
  );
  if (
    protectedResource.resource !== credential.resource ||
    protectedResource.authorizationServer !== credential.authorization_server
  ) {
    runtimeError("runtime_credential_invalid");
  }
  const authorizationServer = await discoverAuthorizationServer(
    protectedResource.authorizationServer,
    fetchImpl,
  );
  const token = await requestToken(
    authorizationServer.tokenEndpoint,
    new URLSearchParams({
      client_id: credential.client_id,
      grant_type: "refresh_token",
      refresh_token: credential.refresh_token,
      resource: protectedResource.resource,
      scope: RUNTIME_SCOPE,
    }),
    fetchImpl,
  );
  if (token.refreshToken === credential.refresh_token) {
    runtimeError("runtime_oauth_token_invalid");
  }
  const rotated = credentialFromToken({
    authorizationServer: authorizationServer.issuer,
    clientId: credential.client_id,
    metadataUrl: protectedResource.metadataUrl,
    now,
    resource: protectedResource.resource,
    token,
  });
  await saveRuntimeCredential(path, rotated);
  return rotated.access_token;
}
