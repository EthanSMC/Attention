import type { SessionPrincipal } from "./sessions";

export type AuthorizationErrorCode = "authentication_required" | "member_required" | "filter_required";

export class AuthorizationError extends Error {
  readonly code: AuthorizationErrorCode;

  constructor(code: AuthorizationErrorCode) {
    super(code);
    this.name = "AuthorizationError";
    this.code = code;
  }
}

export function requireAccount(principal: SessionPrincipal | null): SessionPrincipal {
  if (!principal) {
    throw new AuthorizationError("authentication_required");
  }
  return principal;
}

export function requireMember(principal: SessionPrincipal | null): SessionPrincipal {
  const account = requireAccount(principal);
  if (!account.isMember) {
    throw new AuthorizationError("member_required");
  }
  return account;
}

export function requireFilter(principal: SessionPrincipal | null): SessionPrincipal {
  const account = requireAccount(principal);
  if (!account.isFilter) {
    throw new AuthorizationError("filter_required");
  }
  return account;
}
