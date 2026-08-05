import "server-only";

import {
  resolveApiCredential,
  resolveOAuthAccessToken,
} from "@attention/auth";

import { getWebDatabase } from "./db";

interface CloudPrincipalBase {
  accountId: string;
  isFilter: boolean;
  isMember: boolean;
  scopes: string[];
}

export type CloudPrincipal = CloudPrincipalBase & (
  | {
      clientId: string;
      credentialId: string;
      credentialKind: "oauth";
    }
  | {
      clientId: null;
      credentialId: string;
      credentialKind: "pat";
    }
);

export function readBearerToken(request: Request): string | null {
  const match = /^Bearer ([^\s]+)$/u.exec(request.headers.get("authorization") ?? "");
  return match?.[1] ?? null;
}

export async function resolveCloudPrincipal(
  request: Request,
  audience: "attention-mcp" | "attention-sync",
): Promise<CloudPrincipal | null> {
  const token = readBearerToken(request);
  if (!token) return null;
  if (token.startsWith("att_pat_")) {
    const principal = await resolveApiCredential(getWebDatabase(), token);
    if (!principal) return null;
    return {
      accountId: principal.accountId,
      clientId: null,
      credentialId: principal.credentialId,
      credentialKind: "pat",
      isFilter: principal.isFilter,
      isMember: principal.isMember,
      scopes: principal.scopes,
    };
  }
  const principal = await resolveOAuthAccessToken(getWebDatabase(), token, {
    audience,
  });
  if (!principal) return null;
  return {
    accountId: principal.accountId,
    clientId: principal.clientId,
    credentialId: principal.tokenId,
    credentialKind: "oauth",
    isFilter: principal.isFilter,
    isMember: principal.isMember,
    scopes: principal.scopes,
  };
}
