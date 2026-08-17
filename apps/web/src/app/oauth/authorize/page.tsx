import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import {
  validateAuthorizationRequest,
} from "@attention/auth";

import {
  OAuthConsentPanel,
} from "../../../components/oauth-consent-panel";
import { accountIdentityLabel } from "../../../lib/attention";
import {
  buildOAuthConsentPresentation,
  OAuthConsentPresentationError,
} from "../../../lib/oauth-consent-presentation";
import { getWebDatabase } from "../../../server/db";
import { oauthResourceMapFromOrigin } from "../../../server/oauth-resources";
import { getPagePrincipal } from "../../../server/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "授权 Agent" };

type AuthorizationParam = string | string[] | undefined;

interface AuthorizationParams {
  client_id?: AuthorizationParam;
  code_challenge?: AuthorizationParam;
  code_challenge_method?: AuthorizationParam;
  redirect_uri?: AuthorizationParam;
  resource?: AuthorizationParam;
  response_type?: AuthorizationParam;
  scope?: AuthorizationParam;
  state?: AuthorizationParam;
}

function queryString(params: AuthorizationParams): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" && value) query.set(key, value);
  }
  return query.toString();
}

function single(value: AuthorizationParam): string {
  return typeof value === "string" ? value : "";
}

async function authorizationOrigin(): Promise<string> {
  if (process.env.NEXT_PUBLIC_APP_URL) return new URL(process.env.NEXT_PUBLIC_APP_URL).origin;
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  if (!host) throw new Error("OAuth authorization requires NEXT_PUBLIC_APP_URL or a Host header");
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto")?.split(",", 1)[0]?.trim();
  const protocol = forwardedProtocol || (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  return new URL(`${protocol}://${host}`).origin;
}

export default async function OAuthAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<AuthorizationParams>;
}) {
  const params = await searchParams;
  const database = getWebDatabase();
  let authorization;
  try {
    const origin = await authorizationOrigin();
    authorization = await validateAuthorizationRequest(database, {
      clientId: single(params.client_id),
      codeChallenge: single(params.code_challenge),
      codeChallengeMethod: single(params.code_challenge_method),
      redirectUri: single(params.redirect_uri),
      resource: single(params.resource),
      resources: oauthResourceMapFromOrigin(origin),
      responseType: single(params.response_type),
      scope: single(params.scope),
      ...(single(params.state) ? { state: single(params.state) } : {}),
    });
  } catch (error) {
    return (
      <div className="oauth-consent-shell">
        <section className="oauth-consent oauth-consent--error">
          <h1>暂时无法显示这个授权请求</h1>
          <p>请求可能已失效或不受支持。请回到发起连接的客户端重试。</p>
        </section>
      </div>
    );
  }
  const authorizationFields = {
    client_id: authorization.clientId,
    code_challenge: authorization.codeChallenge,
    code_challenge_method: "S256" as const,
    redirect_uri: authorization.redirectUri,
    resource: authorization.resource,
    response_type: "code" as const,
    scope: authorization.scopes.join(" "),
    ...(authorization.state ? { state: authorization.state } : {}),
  };
  const principal = await getPagePrincipal();
  if (!principal) {
    redirect(
      `/auth?return_to=${encodeURIComponent(`/oauth/authorize?${queryString(authorizationFields)}`)}`,
    );
  }
  const accountLabel = accountIdentityLabel(principal);
  let presentation;
  try {
    presentation = buildOAuthConsentPresentation(
      authorization.audience,
      authorization.scopes,
    );
  } catch (error) {
    if (!(error instanceof OAuthConsentPresentationError)) throw error;
    return (
      <div className="oauth-consent-shell">
        <section className="oauth-consent oauth-consent--error">
          <h1>暂时无法显示这个授权请求</h1>
          <p>这个客户端请求了尚未支持的权限，请回到客户端重试。</p>
        </section>
      </div>
    );
  }

  return (
    <div className="oauth-consent-shell">
      <OAuthConsentPanel
        accountLabel={accountLabel}
        cancelHref={`/oauth/authorize/cancel?${queryString(authorizationFields)}`}
        clientName={authorization.clientName}
        fields={authorizationFields}
        presentation={presentation}
      />
    </div>
  );
}
