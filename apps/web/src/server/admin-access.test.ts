import type { SessionPrincipal } from "@attention/auth";
import { describe, expect, it } from "vitest";

import type { AdminAccessError } from "./admin-access";
import {
  isAdminPrincipal,
  parseAdminEmailAllowlist,
  requireAdminPrincipal,
} from "./admin-access";

function principal(primaryEmail: string | null): SessionPrincipal {
  return {
    accountId: "11111111-1111-4111-8111-111111111111",
    attentionId: "admin_01",
    authenticatedAt: new Date("2026-08-27T00:00:00.000Z"),
    displayName: "Administrator",
    expiresAt: new Date("2026-09-27T00:00:00.000Z"),
    isFilter: false,
    isMember: true,
    primaryEmail,
    sessionId: "22222222-2222-4222-8222-222222222222",
    signupSource: "direct",
  };
}

describe("admin email allowlist", () => {
  it("normalizes, trims, and deduplicates configured emails", () => {
    expect([
      ...parseAdminEmailAllowlist(
        " Admin@One.Example,second@example.com,admin@one.example ",
      ),
    ]).toEqual(["admin@one.example", "second@example.com"]);
  });

  it("fails closed for missing or blank configuration", () => {
    expect(parseAdminEmailAllowlist()).toEqual(new Set());
    expect(parseAdminEmailAllowlist(" , ")).toEqual(new Set());
    expect(isAdminPrincipal(principal("admin@example.com"), "")).toBe(false);
  });

  it("rejects the entire configuration when any entry is invalid", () => {
    expect(() =>
      parseAdminEmailAllowlist("admin@example.com,not-an-email"),
    ).toThrowError(
      expect.objectContaining<Partial<AdminAccessError>>({
        code: "admin_configuration_invalid",
      }),
    );
  });

  it("allows only a principal with an exact normalized email match", () => {
    const configured = "owner@example.com,backup@example.com";

    expect(isAdminPrincipal(principal("OWNER@example.com"), configured)).toBe(
      true,
    );
    expect(isAdminPrincipal(principal("other@example.com"), configured)).toBe(
      false,
    );
    expect(isAdminPrincipal(principal(null), configured)).toBe(false);
    expect(isAdminPrincipal(null, configured)).toBe(false);
  });

  it("distinguishes authentication from authorization without leaking emails", () => {
    expect(() => requireAdminPrincipal(null, "owner@example.com")).toThrowError(
      expect.objectContaining<Partial<AdminAccessError>>({
        code: "authentication_required",
        message: "authentication_required",
      }),
    );
    expect(() =>
      requireAdminPrincipal(principal("other@example.com"), "owner@example.com"),
    ).toThrowError(
      expect.objectContaining<Partial<AdminAccessError>>({
        code: "admin_required",
        message: "admin_required",
      }),
    );
  });
});
