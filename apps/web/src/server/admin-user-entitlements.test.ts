import { describe, expect, it } from "vitest";

import {
  parseAdminEntitlementChangeInput,
  parseAdminUserListInput,
} from "./admin-user-entitlements";

describe("admin user entitlement input", () => {
  it("normalizes bounded search and pagination input", () => {
    expect(
      parseAdminUserListInput({
        page: "2",
        pageSize: "50",
        query: "  Ａｄｍｉｎ  ",
        tier: "member",
      }),
    ).toEqual({
      page: 2,
      pageSize: 50,
      query: "Admin",
      tier: "member",
    });
    expect(parseAdminUserListInput({})).toEqual({
      page: 1,
      pageSize: 25,
    });
  });

  it.each([
    { page: "0" },
    { page: "1.5" },
    { pageSize: "101" },
    { query: "x".repeat(101) },
    { tier: "administrator" },
  ])("rejects unsafe list input: %o", (input) => {
    expect(() => parseAdminUserListInput(input)).toThrow();
  });

  it("trims a confirmed single-user entitlement change", () => {
    expect(
      parseAdminEntitlementChangeInput({
        action: "set_filter",
        reason: "  approved for source review  ",
        requestId: "request:admin-1",
        source: "admin_console",
        targetAccountId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toEqual({
      action: "set_filter",
      reason: "approved for source review",
      requestId: "request:admin-1",
      source: "admin_console",
      targetAccountId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it.each([
    { reason: "no", requestId: "request-1" },
    { reason: "valid reason", requestId: "has whitespace" },
    { reason: "valid reason", requestId: "x".repeat(129) },
    { action: "make_admin", reason: "valid reason", requestId: "request-1" },
    { reason: "valid reason", requestId: "request-1", source: "browser" },
    { reason: "valid reason", requestId: "request-1", targetAccountId: "not-a-uuid" },
  ])("rejects an invalid mutation envelope: %o", (override) => {
    expect(() =>
      parseAdminEntitlementChangeInput(
        Object.assign(
          {
            action: "set_member",
            reason: "valid reason",
            requestId: "request-1",
            source: "admin_console",
            targetAccountId: "11111111-1111-4111-8111-111111111111",
          },
          override,
        ),
      ),
    ).toThrow();
  });
});
