import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getWebDatabase: vi.fn(() => ({})),
  resolveApiCredential: vi.fn(),
  resolveOAuthAccessToken: vi.fn(),
}));

vi.mock("@attention/auth", () => ({
  resolveApiCredential: mocks.resolveApiCredential,
  resolveOAuthAccessToken: mocks.resolveOAuthAccessToken,
}));
vi.mock("./db", () => ({ getWebDatabase: mocks.getWebDatabase }));

import {
  resolveCloudPrincipal,
  resolveRuntimePrincipal,
} from "./cloud-credentials";

describe("cloud credential provenance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves OAuth client and token provenance", async () => {
    mocks.resolveOAuthAccessToken.mockResolvedValue({
      accountId: "account-1",
      audience: "attention-mcp",
      clientId: "client-1",
      isFilter: false,
      isMember: true,
      scopes: ["collection:read"],
      tokenId: "token-1",
    });

    await expect(
      resolveCloudPrincipal(
        new Request("https://attention.example/mcp", {
          headers: { authorization: "Bearer oauth-token-value" },
        }),
        "attention-mcp",
      ),
    ).resolves.toMatchObject({
      clientId: "client-1",
      credentialId: "token-1",
      credentialKind: "oauth",
    });
    expect(mocks.resolveOAuthAccessToken).toHaveBeenCalledWith(
      {},
      "oauth-token-value",
      { audience: "attention-mcp" },
    );
  });

  it("preserves PAT credential provenance without inventing a client", async () => {
    mocks.resolveApiCredential.mockResolvedValue({
      accountId: "account-1",
      credentialId: "pat-1",
      isFilter: true,
      isMember: true,
      scopes: ["collection:write"],
    });

    await expect(
      resolveCloudPrincipal(
        new Request("https://attention.example/mcp", {
          headers: { authorization: `Bearer att_pat_${"a".repeat(43)}` },
        }),
        "attention-mcp",
      ),
    ).resolves.toMatchObject({
      clientId: null,
      credentialId: "pat-1",
      credentialKind: "pat",
    });
    expect(mocks.resolveOAuthAccessToken).not.toHaveBeenCalled();
  });

  it("resolves runtime credentials only against the runtime OAuth audience", async () => {
    mocks.resolveOAuthAccessToken.mockResolvedValue({
      accountId: "account-1",
      audience: "attention-channel-runtime",
      clientId: "runtime-client-1",
      isFilter: false,
      isMember: false,
      scopes: ["runtime:register"],
      tokenId: "runtime-token-1",
    });

    await expect(
      resolveRuntimePrincipal(
        new Request("https://attention.example/api/runtime", {
          headers: { authorization: "Bearer runtime-oauth-token" },
        }),
      ),
    ).resolves.toMatchObject({
      clientId: "runtime-client-1",
      credentialId: "runtime-token-1",
      credentialKind: "oauth",
    });
    expect(mocks.resolveOAuthAccessToken).toHaveBeenCalledWith(
      {},
      "runtime-oauth-token",
      { audience: "attention-channel-runtime" },
    );
  });

  it("rejects PAT credentials at the runtime control plane", async () => {
    await expect(
      resolveRuntimePrincipal(
        new Request("https://attention.example/api/runtime", {
          headers: { authorization: `Bearer att_pat_${"a".repeat(43)}` },
        }),
      ),
    ).resolves.toBeNull();
    expect(mocks.resolveApiCredential).not.toHaveBeenCalled();
    expect(mocks.resolveOAuthAccessToken).not.toHaveBeenCalled();
  });
});
