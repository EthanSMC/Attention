import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LoginModule } from "../../../components/login-module";

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

  it("keeps email-less reauthentication unavailable in the modal", async () => {
    mocks.getPagePrincipal.mockResolvedValue({
      accountId: "10000000-0000-4000-8000-000000000001",
      primaryEmail: null,
    });
    const modal = (await InterceptedLoginPage({
      searchParams: Promise.resolve({ reauth: "1", return_to: "/account/security?edit=1" }),
    })) as ReactElement<{ children: ReactElement }>;

    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(modal.props.children.type).not.toBe(LoginModule);
    expect(renderToStaticMarkup(modal.props.children)).toContain("绑定邮箱后再修改密码");
  });

  it("falls back to ordinary login for an unauthenticated reauthentication URL", async () => {
    mocks.getPagePrincipal.mockResolvedValue(null);
    const modal = (await InterceptedLoginPage({
      searchParams: Promise.resolve({ reauth: "1", return_to: "https://attacker.example/" }),
    })) as ReactElement<{ children: ReactElement }>;
    const login = modal.props.children as ReactElement<{
      defaultEmail?: string;
      forceCodeOnly: boolean;
      returnTo: string;
    }>;

    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(login.type).toBe(LoginModule);
    expect(login.props).toMatchObject({
      forceCodeOnly: false,
      returnTo: "/ai",
    });
    expect(login.props.defaultEmail).toBeUndefined();
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
