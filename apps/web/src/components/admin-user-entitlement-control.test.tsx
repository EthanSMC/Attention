import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import {
  AdminEntitlementConfirmation,
  AdminUserEntitlementControl,
  isValidAdminEntitlementReason,
} from "./admin-user-entitlement-control";

describe("admin user entitlement controls", () => {
  it("requires a normalized 3–500 character reason", () => {
    expect(isValidAdminEntitlementReason("no")).toBe(false);
    expect(isValidAdminEntitlementReason("  approved  ")).toBe(true);
    expect(isValidAdminEntitlementReason("x".repeat(500))).toBe(true);
    expect(isValidAdminEntitlementReason("x".repeat(501))).toBe(false);
  });

  it("starts with all available actions gated by the empty reason", () => {
    const markup = renderToStaticMarkup(
      <AdminUserEntitlementControl
        currentTier="member"
        targetAccountId="11111111-1111-4111-8111-111111111111"
        targetLabel="member@example.com"
      />,
    );

    expect(markup).toContain("变更原因");
    expect(markup).toContain("设为 Filter");
    expect(markup).toContain("撤销 Filter");
    expect(markup.match(/disabled=""/gu)?.length).toBeGreaterThanOrEqual(2);
  });

  it("makes explicit confirmation restate the target, action, and reason", () => {
    const markup = renderToStaticMarkup(
      <AdminEntitlementConfirmation
        action="set_filter"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        pending={false}
        reason="Approved for curation"
        targetLabel="member@example.com"
      />,
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("member@example.com");
    expect(markup).toContain("设为 Filter");
    expect(markup).toContain("Approved for curation");
    expect(markup).toContain("确认并执行");
    expect(markup).toContain("取消");
  });
});
