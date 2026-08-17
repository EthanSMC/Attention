import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const navigationState = vi.hoisted(() => ({ pathname: "/oauth/authorize" }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigationState.pathname,
}));

import { MobileNavigation, SiteHeader } from "./site-navigation";

describe("standalone navigation paths", () => {
  it.each(["/oauth/authorize", "/oauth/authorize/cancel"])(
    "hides all product navigation on %s",
    (pathname) => {
      navigationState.pathname = pathname;

      expect(renderToStaticMarkup(<SiteHeader identity={null} />)).toBe("");
      expect(renderToStaticMarkup(<MobileNavigation />)).toBe("");
    },
  );

  it("keeps the header, collection action, and mobile navigation on product pages", () => {
    navigationState.pathname = "/ai";

    const header = renderToStaticMarkup(<SiteHeader identity={null} />);
    const mobile = renderToStaticMarkup(<MobileNavigation />);

    expect(header).toContain('class="site-header');
    expect(header).toContain('class="collect-fab"');
    expect(mobile).toContain('class="mobile-nav"');
  });
});
