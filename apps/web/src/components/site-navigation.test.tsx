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

  it.each(["/oauth/authorize", "/oauth/authorize/cancel", "/admin/users"])(
    "hides all product navigation on %s",
    (oauthPath) => {
      pathname = oauthPath;

      expect(renderToStaticMarkup(<SiteHeader identity={null} />)).toBe("");
      expect(renderToStaticMarkup(<MobileNavigation />)).toBe("");
    },
  );

  it("keeps collection actions on collection-oriented pages only", () => {
    expect(shouldShowCollectAction("/ai")).toBe(true);
    expect(shouldShowCollectAction("/account")).toBe(true);
    expect(shouldShowCollectAction("/account/settings")).toBe(false);
    expect(shouldShowCollectAction("/membership")).toBe(false);
    expect(shouldShowCollectAction("/auth")).toBe(false);
    expect(shouldShowCollectAction("/login")).toBe(false);
    expect(shouldShowCollectAction("/oauth/authorize")).toBe(false);
    expect(shouldShowCollectAction("/admin/users")).toBe(false);
  });

  it("keeps the header, collection action, and mobile navigation on product pages", () => {
    const header = renderToStaticMarkup(<SiteHeader identity={null} />);
    const mobile = renderToStaticMarkup(<MobileNavigation />);

    expect(header).toContain('class="site-header');
    expect(header).toContain('class="collect-fab"');
    expect(mobile).toContain('class="mobile-nav"');
  });
});
