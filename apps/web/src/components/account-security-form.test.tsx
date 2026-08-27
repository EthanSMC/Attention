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

  it("keeps password modification unavailable until an email is bound", () => {
    const markup = renderToStaticMarkup(<AccountSecurityForm email={null} hasPassword />);

    expect(markup).not.toContain("reauth=1");
    expect(markup).not.toContain(">修改密码</a>");
    expect(markup).toContain("绑定邮箱后再修改密码");
  });
});
