import "server-only";

import {
  normalizeEmail,
  type SessionPrincipal,
} from "@attention/auth";

export type AdminAccessErrorCode =
  | "admin_configuration_invalid"
  | "admin_required"
  | "authentication_required";

export class AdminAccessError extends Error {
  constructor(readonly code: AdminAccessErrorCode) {
    super(code);
    this.name = "AdminAccessError";
  }
}

export function parseAdminEmailAllowlist(
  rawValue = process.env.ATTENTION_ADMIN_EMAILS,
): ReadonlySet<string> {
  const values = rawValue
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean) ?? [];
  if (values.length === 0) return new Set();

  try {
    return new Set(values.map((value) => normalizeEmail(value)));
  } catch {
    throw new AdminAccessError("admin_configuration_invalid");
  }
}

export function isAdminPrincipal(
  principal: SessionPrincipal | null,
  rawValue = process.env.ATTENTION_ADMIN_EMAILS,
): boolean {
  const allowlist = parseAdminEmailAllowlist(rawValue);
  if (!principal?.primaryEmail || allowlist.size === 0) return false;
  try {
    return allowlist.has(normalizeEmail(principal.primaryEmail));
  } catch {
    return false;
  }
}

export function requireAdminPrincipal(
  principal: SessionPrincipal | null,
  rawValue = process.env.ATTENTION_ADMIN_EMAILS,
): SessionPrincipal {
  if (!principal) throw new AdminAccessError("authentication_required");
  if (!isAdminPrincipal(principal, rawValue)) {
    throw new AdminAccessError("admin_required");
  }
  return principal;
}
