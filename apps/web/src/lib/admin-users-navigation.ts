export type AdminUsersTab = "audits" | "users";

export interface AdminUsersListLocation {
  page: number;
  query?: string;
  tier?: "filter" | "free" | "member";
}

export interface AdminUsersHrefOptions {
  auditUser?: string;
  tab?: AdminUsersTab;
}

export function parseAdminUsersTab(value: string | undefined): AdminUsersTab {
  return value === "audits" ? "audits" : "users";
}

export function adminUsersHref(
  input: AdminUsersListLocation,
  options: AdminUsersHrefOptions = {},
): string {
  const params = new URLSearchParams();
  if (input.query) params.set("q", input.query);
  if (input.tier) params.set("tier", input.tier);
  if (input.page > 1) params.set("page", String(input.page));
  if (options.tab === "audits") {
    params.set("tab", "audits");
    if (options.auditUser) params.set("audit_user", options.auditUser);
  }
  const query = params.toString();
  return query ? `/admin/users?${query}` : "/admin/users";
}
