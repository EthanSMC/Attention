import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

let pathname = "/ai";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));

import {
  MobileNavigation,
  shouldShowCollectAction,
  SiteHeader,
} from "./site-navigation";

describe("SiteHeader", () => {
  beforeEach(() => {
    pathname = "/ai";
  });

  it("uses focused brand-only chrome for every OAuth route", () => {
    pathname = "/oauth/authorize";
    const header = renderToStaticMarkup(createElement(SiteHeader, { identity: null }));
    const mobile = renderToStaticMarkup(createElement(MobileNavigation));

    expect(header).toContain("Attention");
    expect(header).toContain("返回 Attention");
    expect(header).not.toContain('aria-label="主导航"');
    expect(header).not.toContain("收藏链接");
    expect(mobile).toBe("");
  });

  it("keeps collection actions on collection-oriented pages only", () => {
    expect(shouldShowCollectAction("/ai")).toBe(true);
    expect(shouldShowCollectAction("/account")).toBe(true);
    expect(shouldShowCollectAction("/account/settings")).toBe(false);
    expect(shouldShowCollectAction("/membership")).toBe(false);
    expect(shouldShowCollectAction("/auth")).toBe(false);
    expect(shouldShowCollectAction("/login")).toBe(false);
    expect(shouldShowCollectAction("/oauth/authorize")).toBe(false);
  });
});
