import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AccountSecurityForm } from "./account-security-form";

describe("account security login navigation", () => {
  it("opens password reauthentication through the intercepted login route", () => {
    const markup = renderToStaticMarkup(
      <AccountSecurityForm
        email="member@example.com"
        hasPassword
      />,
    );
    expect(markup).toContain(
      'href="/login?return_to=%2Faccount%2Fsecurity%3Fedit%3D1&amp;reauth=1"',
    );
    expect(markup).toContain(">修改密码</a>");
  });
});
