import type { OAuthAudience, OAuthResourceMap } from "@attention/auth";

export function publicWebOrigin(request: Request): string {
  return process.env.NEXT_PUBLIC_APP_URL
    ? new URL(process.env.NEXT_PUBLIC_APP_URL).origin
    : new URL(request.url).origin;
}

export function oauthResourceMapFromOrigin(originValue: string): OAuthResourceMap {
  const origin = new URL(originValue).origin;
  return {
    "attention-channel-runtime":
      process.env.ATTENTION_CHANNEL_RUNTIME_PUBLIC_URL ?? `${origin}/api/runtime`,
    "attention-mcp": process.env.ATTENTION_MCP_PUBLIC_URL ?? `${origin}/mcp`,
    "attention-sync": process.env.ATTENTION_SYNC_PUBLIC_URL ?? `${origin}/api/sync`,
  };
}

export function oauthResourceMap(request: Request): OAuthResourceMap {
  return oauthResourceMapFromOrigin(publicWebOrigin(request));
}

export function oauthResourceMetadataUrl(
  request: Request,
  audience: OAuthAudience,
): string {
  const origin = publicWebOrigin(request);
  const paths = {
    "attention-channel-runtime":
      "/.well-known/oauth-protected-resource/api/runtime",
    "attention-mcp": "/.well-known/oauth-protected-resource",
    "attention-sync": "/.well-known/oauth-protected-resource/api/sync",
  } as const satisfies Record<OAuthAudience, string>;
  return `${origin}${paths[audience]}`;
}
