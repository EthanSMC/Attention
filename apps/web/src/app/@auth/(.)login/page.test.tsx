import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPagePrincipal: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("../../../server/session", () => ({
  getPagePrincipal: mocks.getPagePrincipal,
}));

import InterceptedLoginPage from "./page";

describe("intercepted login", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows code-only reauthentication for the current account", async () => {
    mocks.getPagePrincipal.mockResolvedValue({
      accountId: "10000000-0000-4000-8000-000000000001",
      primaryEmail: "member@example.com",
    });
    const modal = (await InterceptedLoginPage({
      searchParams: Promise.resolve({
        reauth: "1",
        return_to: "/account/security?edit=1",
      }),
    })) as ReactElement<{ children: ReactElement }>;
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(modal.props.children.props).toMatchObject({
      defaultEmail: "member@example.com",
      forceCodeOnly: true,
      returnTo: "/account/security?edit=1",
    });
  });

  it("still redirects an authenticated ordinary login", async () => {
    mocks.getPagePrincipal.mockResolvedValue({
      accountId: "10000000-0000-4000-8000-000000000001",
      primaryEmail: "member@example.com",
    });
    await InterceptedLoginPage({
      searchParams: Promise.resolve({ return_to: "/collect" }),
    });
    expect(mocks.redirect).toHaveBeenCalledWith("/collect");
  });
});
