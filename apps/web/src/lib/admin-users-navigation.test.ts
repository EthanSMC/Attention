import { describe, expect, it } from "vitest";

import {
  adminUsersHref,
  parseAdminUsersTab,
} from "./admin-users-navigation";

describe("admin users navigation", () => {
  it("recognizes the audit tab and falls back safely to users", () => {
    expect(parseAdminUsersTab("audits")).toBe("audits");
    expect(parseAdminUsersTab("users")).toBe("users");
    expect(parseAdminUsersTab("unknown")).toBe("users");
    expect(parseAdminUsersTab(undefined)).toBe("users");
  });

  it("preserves the user-list location when opening an audit", () => {
    expect(
      adminUsersHref(
        { page: 2, query: "reader", tier: "member" },
        {
          auditUser: "11111111-1111-4111-8111-111111111111",
          tab: "audits",
        },
      ),
    ).toBe(
      "/admin/users?q=reader&tier=member&page=2&tab=audits&audit_user=11111111-1111-4111-8111-111111111111",
    );
  });

  it("omits default and audit-only parameters from the users tab", () => {
    expect(
      adminUsersHref(
        { page: 1, query: undefined, tier: undefined },
        {
          auditUser: "11111111-1111-4111-8111-111111111111",
          tab: "users",
        },
      ),
    ).toBe("/admin/users");
  });
});
