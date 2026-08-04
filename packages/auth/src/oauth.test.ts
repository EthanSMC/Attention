import { describe, expect, it } from "vitest";

import { resolveOAuthResource } from "./oauth";

const resources = {
  "attention-mcp": "https://attention.example/mcp",
  "attention-sync": "https://attention.example/api/sync",
} as const;

describe("OAuth resource indicators", () => {
  it("maps canonical resource URIs to separate MCP and sync audiences", () => {
    expect(resolveOAuthResource("HTTPS://ATTENTION.EXAMPLE/mcp", resources)).toEqual({
      audience: "attention-mcp",
      resource: resources["attention-mcp"],
    });
    expect(resolveOAuthResource(resources["attention-sync"], resources)).toEqual({
      audience: "attention-sync",
      resource: resources["attention-sync"],
    });
  });

  it.each([
    "",
    "attention.example/mcp",
    "https://attention.example/mcp#fragment",
    "http://attention.example/mcp",
    "https://attention.example/unknown",
  ])("rejects invalid or unknown resource %s", (resource) => {
    expect(() => resolveOAuthResource(resource, resources)).toThrowError(
      expect.objectContaining({ code: "invalid_target" }),
    );
  });

  it("allows loopback HTTP for local MCP development only", () => {
    const localResources = {
      "attention-mcp": "http://127.0.0.1:3000/mcp",
      "attention-sync": "http://localhost:3000/api/sync",
    } as const;
    expect(resolveOAuthResource(localResources["attention-mcp"], localResources).audience)
      .toBe("attention-mcp");
  });
});
