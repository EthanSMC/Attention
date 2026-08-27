import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LoginLink, loginHref } from "./login-link";

describe("login navigation", () => {
  it("builds one canonical login URL for normal and reauthentication flows", () => {
    expect(loginHref({ returnTo: "/collect" })).toBe(
      "/login?return_to=%2Fcollect",
    );
    expect(
      loginHref({
        reauthenticate: true,
        returnTo: "/account/security?edit=1",
      }),
    ).toBe(
      "/login?return_to=%2Faccount%2Fsecurity%3Fedit%3D1&reauth=1",
    );
  });

  it("renders a Next login link with the canonical target", () => {
    const markup = renderToStaticMarkup(
      <LoginLink className="button" returnTo="/collect">
        登录后收藏
      </LoginLink>,
    );
    expect(markup).toContain('href="/login?return_to=%2Fcollect"');
    expect(markup).toContain(">登录后收藏</a>");
  });
});
