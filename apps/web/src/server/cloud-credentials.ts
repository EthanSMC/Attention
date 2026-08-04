import "server-only";

import {
  resolveApiCredential,
  resolveOAuthAccessToken,
} from "@attention/auth";

import { getWebDatabase } from "./db";

export interface CloudPrincipal {
  accountId: string;
  isFilter: boolean;
  isMember: boolean;
  scopes: string[];
}

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
    return resolveApiCredential(getWebDatabase(), token);
  }
  return resolveOAuthAccessToken(getWebDatabase(), token, { audience });
}
