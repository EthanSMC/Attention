import {describe, expect, it} from "vitest";

describe("production route export boundaries", () => {
  it.each([
    ["moderation", () => import("./api/moderation/reports/route"), ["POST", "dynamic", "runtime"]],
    ["MCP", () => import("./mcp/route"), ["DELETE", "GET", "OPTIONS", "POST", "dynamic", "runtime"]],
    ["OAuth registration", () => import("./oauth/register/route"), ["POST", "dynamic", "runtime"]],
    ["OAuth revocation", () => import("./oauth/revoke/route"), ["POST", "dynamic", "runtime"]],
    ["OAuth token", () => import("./oauth/token/route"), ["POST", "dynamic", "runtime"]],
  ] as const)("%s exposes only supported Next entries and configuration", async (_name, load, names) => {
    expect(Object.keys(await load()).sort()).toEqual(names);
  });
});
