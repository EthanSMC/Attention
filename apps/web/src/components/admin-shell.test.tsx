import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AdminShell } from "./admin-shell";

describe("AdminShell", () => {
  it("shows administrator identity and isolated admin navigation", () => {
    const markup = renderToStaticMarkup(
      <AdminShell
        active="audits"
        auditsHref="/admin/users?tab=audits"
        identity={{
          attentionId: "admin_01",
          displayName: "Local Admin",
          primaryEmail: "local-admin@example.com",
        }}
        usersHref="/admin/users"
      >
        <p>Admin content</p>
      </AdminShell>,
    );

    expect(markup).toContain("Local Admin");
    expect(markup).toContain("local-admin@example.com");
    expect(markup).toContain("@admin_01");
    expect(markup).toContain("用户权限");
    expect(markup).toContain("审计记录");
    expect(markup).toContain(
      'aria-current="page" href="/admin/users?tab=audits"',
    );
    expect(markup).not.toContain('href="/account');
    expect(markup).toContain("Admin content");
  });
});
