import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import {
  adminEntitlementActionDisabledReason,
  adminEntitlementReasonMessage,
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

  it("explains how much reason text is still required", () => {
    expect(adminEntitlementReasonMessage("")).toBe(
      "先填写至少 3 个字符的变更原因。",
    );
    expect(adminEntitlementReasonMessage("好")).toBe(
      "还需填写 2 个字符，才能选择操作。",
    );
    expect(adminEntitlementReasonMessage("通过了")).toBe(
      "原因已满足要求，请选择操作。",
    );
  });

  it("distinguishes reason gates from actions the current tier cannot use", () => {
    expect(
      adminEntitlementActionDisabledReason({
        action: "set_member",
        currentTier: "member",
        pending: false,
        reason: "通过了",
      }),
    ).toBe("当前已是 Member。");
    expect(
      adminEntitlementActionDisabledReason({
        action: "revoke_filter",
        currentTier: "member",
        pending: false,
        reason: "通过了",
      }),
    ).toBe("仅当前为 Filter 时可撤销。");
    expect(
      adminEntitlementActionDisabledReason({
        action: "set_filter",
        currentTier: "member",
        pending: false,
        reason: "短",
      }),
    ).toBe("还需填写 2 个字符，才能选择操作。");
    expect(
      adminEntitlementActionDisabledReason({
        action: "set_filter",
        currentTier: "member",
        pending: false,
        reason: "审核通过",
      }),
    ).toBeNull();
    expect(
      adminEntitlementActionDisabledReason({
        action: "set_filter",
        currentTier: "member",
        pending: true,
        reason: "审核通过",
      }),
    ).toBe("正在执行权益变更。");
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
    expect(markup).toContain("先填写至少 3 个字符的变更原因。");
    expect(markup).toContain("设为 Filter");
    expect(markup).toContain("撤销 Filter");
    expect(markup.match(/disabled=""/gu)?.length).toBeGreaterThanOrEqual(2);
    expect(markup).toContain(
      'aria-describedby="admin-entitlement-reason-help-11111111-1111-4111-8111-111111111111 admin-entitlement-action-state-11111111-1111-4111-8111-111111111111"',
    );
    expect(markup).toContain('title="当前已是 Member。"');
    expect(markup).toContain("当前不可用：当前已是 Member；仅当前为 Filter 时可撤销。");
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
