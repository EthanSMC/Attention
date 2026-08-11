import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CHANNEL_RUNTIME_SCOPES } from "@attention/contracts";

import {
  authorizeRuntime,
  clearRuntimeCredential,
  loadRuntimeCredential,
  runtimeAccessToken,
} from "./runtime-oauth";

const temporaryDirectories: string[] = [];
const protectedResourceMetadataUrl =
  "https://attention.example/.well-known/oauth-protected-resource/api/runtime";
const resource = "https://runtime.attention.example/control-plane";
const authorizationServer = "https://login.attention.example";
const authorizationServerMetadataUrl =
  "https://login.attention.example/.well-known/oauth-authorization-server";
const authorizationEndpoint = "https://login.attention.example/interactive/authorize";
const registrationEndpoint = "https://login.attention.example/clients/register";
const tokenEndpoint = "https://login.attention.example/tokens/exchange";
const redirectUri = "http://127.0.0.1:49152/oauth/callback";
const runtimeScope = CHANNEL_RUNTIME_SCOPES.join(" ");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (input instanceof URL) return input.toString();
  return typeof input === "string" ? input : input.url;
}

function requestForm(init: RequestInit | undefined): URLSearchParams {
  if (typeof init?.body !== "string") {
    throw new Error("expected URL-encoded request body");
  }
  return new URLSearchParams(init.body);
}

function oauthHarness(options: {
  callbackState?: "correct" | "wrong";
  failRefresh?: boolean;
  refreshDelayMs?: number;
  resourceScopes?: readonly string[];
  rotateRefreshToken?: boolean;
} = {}) {
  let openedAuthorizationUrl: URL | null = null;
  const registrationBodies: Array<Record<string, unknown>> = [];
  const tokenForms: URLSearchParams[] = [];
  const requestedUrls: string[] = [];
  const userAgents: string[] = [];
  const close = vi.fn(async () => undefined);

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = requestUrl(input);
    requestedUrls.push(url);
    userAgents.push(new Headers(init?.headers).get("user-agent") ?? "");
    if (url === protectedResourceMetadataUrl) {
      return json({
        authorization_servers: [authorizationServer],
        bearer_methods_supported: ["header"],
        resource,
        scopes_supported: options.resourceScopes ?? [...CHANNEL_RUNTIME_SCOPES],
      });
    }
    if (url === authorizationServerMetadataUrl) {
      return json({
        authorization_endpoint: authorizationEndpoint,
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        issuer: authorizationServer,
        registration_endpoint: registrationEndpoint,
        response_types_supported: ["code"],
        scopes_supported: ["profile:read", ...CHANNEL_RUNTIME_SCOPES],
        token_endpoint: tokenEndpoint,
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url === registrationEndpoint) {
      registrationBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json({
        application_type: "native",
        client_id: "runtime-client-id",
        grant_types: ["authorization_code", "refresh_token"],
        redirect_uris: [redirectUri],
        response_types: ["code"],
        scope: [...CHANNEL_RUNTIME_SCOPES].reverse().join(" "),
        token_endpoint_auth_method: "none",
      }, 201);
    }
    if (url === tokenEndpoint) {
      const form = requestForm(init);
      tokenForms.push(form);
      if (form.get("grant_type") === "refresh_token") {
        if (options.refreshDelayMs) {
          await new Promise((resolve) =>
            setTimeout(resolve, options.refreshDelayMs),
          );
        }
        if (options.failRefresh) {
          return json({
            error: "invalid_grant",
            error_description: "runtime-refresh-token-one must not leak",
          }, 400);
        }
        return json({
          access_token: "runtime-access-token-two",
          expires_in: 3600,
          refresh_token: options.rotateRefreshToken === false
            ? form.get("refresh_token")
            : "runtime-refresh-token-two",
          scope: runtimeScope,
          token_type: "Bearer",
        });
      }
      return json({
        access_token: "runtime-access-token-one",
        expires_in: 3600,
        refresh_token: "runtime-refresh-token-one",
        scope: runtimeScope,
        token_type: "Bearer",
      });
    }
    throw new Error(`unexpected request ${url}`);
  };

  return {
    callbackServer: {
      close,
      redirectUri,
      waitForCallback: async () => {
        if (!openedAuthorizationUrl) {
          throw new Error("browser was not opened before waiting for callback");
        }
        const state = options.callbackState === "wrong"
          ? "wrong-state"
          : openedAuthorizationUrl.searchParams.get("state");
        return new URL(`${redirectUri}?code=runtime-code&state=${state ?? ""}`);
      },
    },
    close,
    fetchImpl,
    openBrowser: vi.fn(async (url: string) => {
      openedAuthorizationUrl = new URL(url);
    }),
    openedAuthorizationUrl: () => openedAuthorizationUrl,
    registrationBodies,
    requestedUrls,
    tokenForms,
    userAgents,
  };
}

async function credentialPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "attention-runtime-oauth-"));
  temporaryDirectories.push(directory);
  return join(directory, "runtime", "credentials.json");
}

describe("dedicated Runtime OAuth", () => {
  it("discovers the runtime resource, uses DCR and S256 PKCE, and stores restricted credentials", async () => {
    const path = await credentialPath();
    const harness = oauthHarness();
    const credential = await authorizeRuntime({
      createCallbackServer: async () => harness.callbackServer,
      credentialPath: path,
      fetchImpl: harness.fetchImpl,
      now: () => new Date("2026-08-10T10:00:00.000Z"),
      openBrowser: harness.openBrowser,
      origin: "https://attention.example",
    });

    expect(harness.requestedUrls.slice(0, 3)).toEqual([
      protectedResourceMetadataUrl,
      authorizationServerMetadataUrl,
      registrationEndpoint,
    ]);
    expect(new Set(harness.userAgents)).toEqual(
      new Set(["attention-cli/0.2.1"]),
    );
    expect(harness.registrationBodies).toEqual([{
      application_type: "native",
      client_name: "Attention Local Channel Runtime",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [redirectUri],
      resource,
      response_types: ["code"],
      scope: runtimeScope,
      software_id: "attention-channel-runtime",
      software_version: "0.2.1",
      token_endpoint_auth_method: "none",
    }]);
    const authorizeUrl = harness.openedAuthorizationUrl();
    expect(authorizeUrl).not.toBeNull();
    expect(`${authorizeUrl!.origin}${authorizeUrl!.pathname}`).toBe(
      authorizationEndpoint,
    );
    expect(authorizeUrl?.searchParams.get("resource")).toBe(resource);
    expect(new Set(authorizeUrl?.searchParams.get("scope")?.split(" "))).toEqual(
      new Set(CHANNEL_RUNTIME_SCOPES),
    );
    expect(authorizeUrl?.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizeUrl?.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const exchange = harness.tokenForms[0];
    expect(exchange?.get("grant_type")).toBe("authorization_code");
    expect(exchange?.get("resource")).toBe(resource);
    expect(exchange?.get("client_id")).toBe("runtime-client-id");
    expect(exchange?.get("redirect_uri")).toBe(redirectUri);
    const verifier = exchange?.get("code_verifier") ?? "";
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(
      createHash("sha256").update(verifier).digest("base64url"),
    ).toBe(authorizeUrl?.searchParams.get("code_challenge"));

    expect(credential).toMatchObject({
      access_token: "runtime-access-token-one",
      audience: "attention-channel-runtime",
      authorization_server: authorizationServer,
      client_id: "runtime-client-id",
      protected_resource_metadata_url: protectedResourceMetadataUrl,
      refresh_token: "runtime-refresh-token-one",
      resource,
      scopes: [...CHANNEL_RUNTIME_SCOPES],
    });
    expect(await loadRuntimeCredential({ credentialPath: path })).toEqual(
      credential,
    );
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(dirname(path))).toEqual(["credentials.json"]);
    expect(harness.close).toHaveBeenCalledOnce();
    await chmod(path, 0o644);
    await expect(loadRuntimeCredential({ credentialPath: path })).rejects
      .toMatchObject({ code: "runtime_credential_permissions" });
  });

  it("rejects a callback with the wrong state before exchanging a token", async () => {
    const path = await credentialPath();
    const harness = oauthHarness({ callbackState: "wrong" });

    await expect(authorizeRuntime({
      createCallbackServer: async () => harness.callbackServer,
      credentialPath: path,
      fetchImpl: harness.fetchImpl,
      openBrowser: harness.openBrowser,
      origin: "https://attention.example",
    })).rejects.toMatchObject({ code: "runtime_oauth_state_mismatch" });
    expect(harness.tokenForms).toHaveLength(0);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it("rejects mixed protected-resource scopes before registering a client", async () => {
    const path = await credentialPath();
    const harness = oauthHarness({
      resourceScopes: [...CHANNEL_RUNTIME_SCOPES, "profile:read"],
    });

    await expect(authorizeRuntime({
      createCallbackServer: async () => harness.callbackServer,
      credentialPath: path,
      fetchImpl: harness.fetchImpl,
      openBrowser: harness.openBrowser,
      origin: "https://attention.example",
    })).rejects.toMatchObject({ code: "runtime_oauth_metadata_invalid" });
    expect(harness.registrationBodies).toHaveLength(0);
    expect(harness.openBrowser).not.toHaveBeenCalled();
  });

  it("rotates an expired refresh token for the same discovered runtime resource", async () => {
    const path = await credentialPath();
    const harness = oauthHarness();
    await authorizeRuntime({
      createCallbackServer: async () => harness.callbackServer,
      credentialPath: path,
      fetchImpl: harness.fetchImpl,
      now: () => new Date("2026-08-10T10:00:00.000Z"),
      openBrowser: harness.openBrowser,
      origin: "https://attention.example",
    });

    await expect(runtimeAccessToken({
      credentialPath: path,
      fetchImpl: harness.fetchImpl,
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    })).resolves.toBe("runtime-access-token-two");
    const refresh = harness.tokenForms.at(-1);
    expect(refresh?.get("grant_type")).toBe("refresh_token");
    expect(refresh?.get("refresh_token")).toBe("runtime-refresh-token-one");
    expect(refresh?.get("resource")).toBe(resource);
    expect(new Set(refresh?.get("scope")?.split(" "))).toEqual(
      new Set(CHANNEL_RUNTIME_SCOPES),
    );
    expect(await loadRuntimeCredential({ credentialPath: path })).toMatchObject({
      access_token: "runtime-access-token-two",
      refresh_token: "runtime-refresh-token-two",
    });
    expect(await readFile(path, "utf8")).not.toContain(
      "runtime-refresh-token-one",
    );
  });

  it("can force a refresh after a runtime API rejects an otherwise live token", async () => {
    const path = await credentialPath();
    const harness = oauthHarness();
    await authorizeRuntime({
      createCallbackServer: async () => harness.callbackServer,
      credentialPath: path,
      fetchImpl: harness.fetchImpl,
      now: () => new Date("2026-08-10T10:00:00.000Z"),
      openBrowser: harness.openBrowser,
      origin: "https://attention.example",
    });

    await expect(runtimeAccessToken({
      credentialPath: path,
      fetchImpl: harness.fetchImpl,
      forceRefresh: true,
      now: () => new Date("2026-08-10T10:01:00.000Z"),
    })).resolves.toBe("runtime-access-token-two");
    expect(harness.tokenForms.at(-1)?.get("grant_type")).toBe("refresh_token");
  });

  it("serializes concurrent refreshes and requires refresh-token rotation", async () => {
    const path = await credentialPath();
    const harness = oauthHarness({ refreshDelayMs: 10 });
    await authorizeRuntime({
      createCallbackServer: async () => harness.callbackServer,
      credentialPath: path,
      fetchImpl: harness.fetchImpl,
      now: () => new Date("2026-08-10T10:00:00.000Z"),
      openBrowser: harness.openBrowser,
      origin: "https://attention.example",
    });

    await expect(Promise.all([
      runtimeAccessToken({
        credentialPath: path,
        fetchImpl: harness.fetchImpl,
        now: () => new Date("2026-08-10T12:00:00.000Z"),
      }),
      runtimeAccessToken({
        credentialPath: path,
        fetchImpl: harness.fetchImpl,
        now: () => new Date("2026-08-10T12:00:00.000Z"),
      }),
    ])).resolves.toEqual([
      "runtime-access-token-two",
      "runtime-access-token-two",
    ]);
    expect(
      harness.tokenForms.filter(
        (form) => form.get("grant_type") === "refresh_token",
      ),
    ).toHaveLength(1);

    const nonRotating = oauthHarness({ rotateRefreshToken: false });
    await expect(runtimeAccessToken({
      credentialPath: path,
      fetchImpl: nonRotating.fetchImpl,
      now: () => new Date("2026-08-10T14:00:00.000Z"),
    })).rejects.toMatchObject({ code: "runtime_oauth_token_invalid" });
  });

  it("rejects a business-MCP-shaped credential and never returns its token", async () => {
    const path = await credentialPath();
    await mkdir(dirname(path), { mode: 0o700, recursive: true });
    await writeFile(path, JSON.stringify({
      access_token: "business-mcp-access-token",
      access_token_expires_at: "2026-08-10T12:00:00.000Z",
      audience: "attention-mcp",
      authorization_server: authorizationServer,
      client_id: "mcp-client-id",
      protected_resource_metadata_url: protectedResourceMetadataUrl,
      refresh_token: "business-mcp-refresh-token",
      resource: "https://attention.example/mcp",
      scopes: ["profile:read"],
      token_type: "Bearer",
      version: 1,
    }), { mode: 0o600 });
    await chmod(path, 0o600);

    await expect(loadRuntimeCredential({ credentialPath: path })).rejects
      .toMatchObject({ code: "runtime_credential_invalid" });
    await expect(runtimeAccessToken({ credentialPath: path })).rejects
      .toMatchObject({ code: "runtime_credential_invalid" });
  });

  it("redacts refresh failures and clears only the dedicated credential", async () => {
    const path = await credentialPath();
    const harness = oauthHarness({ failRefresh: true });
    await authorizeRuntime({
      createCallbackServer: async () => harness.callbackServer,
      credentialPath: path,
      fetchImpl: harness.fetchImpl,
      now: () => new Date("2026-08-10T10:00:00.000Z"),
      openBrowser: harness.openBrowser,
      origin: "https://attention.example",
    });

    const error = await runtimeAccessToken({
      credentialPath: path,
      fetchImpl: harness.fetchImpl,
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("runtime-refresh-token-one");
    expect(String(error)).not.toContain("error_description");

    await clearRuntimeCredential({ credentialPath: path });
    await expect(loadRuntimeCredential({ credentialPath: path })).resolves.toBeNull();
  });
});
