import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import {
  checkOAuthConnectionName,
  OAuthError,
  validateAuthorizationRequest,
} from "@attention/auth";
import { and, eq, oauthClients } from "@attention/db";

import {
  OAuthAuthorizationForm,
  type OAuthConnectionNameResultClient,
} from "../../../components/oauth-authorization-form";
import { OAuthScopeDisclosure } from "../../../components/oauth-scope-disclosure";
import { PageIntro } from "../../../components/page-intro";
import { accountIdentityLabel } from "../../../lib/attention";
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
  connection_error?: AuthorizationParam;
  connection_label?: AuthorizationParam;
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
    const code = error instanceof OAuthError ? error.code : "invalid_request";
    return <div className="page-shell"><PageIntro eyebrow="OAuth 请求无效" title="无法继续授权" description={<p>{code}。请回到发起授权的客户端重试。</p>} /></div>;
  }
  const principal = await getPagePrincipal();
  if (!principal) {
    redirect(`/auth?return_to=${encodeURIComponent(`/oauth/authorize?${queryString(params)}`)}`);
  }
  const accountLabel = accountIdentityLabel(principal);
  const [clientMetadata] = await database
    .select({
      connectionKind: oauthClients.connectionKind,
      deviceName: oauthClients.deviceName,
    })
    .from(oauthClients)
    .where(
      and(
        eq(oauthClients.clientId, authorization.clientId),
        eq(oauthClients.active, true),
      ),
    )
    .limit(1);
  const submittedLabel = single(params.connection_label);
  const trustedRuntimeDeviceName =
    authorization.audience === "attention-channel-runtime" &&
    clientMetadata?.connectionKind === "runtime"
      ? clientMetadata.deviceName
      : null;
  // A generic client name identifies software, not the user's physical
  // connection. Only trusted Runtime DCR metadata is safe to prefill here.
  const defaultLabel = submittedLabel || trustedRuntimeDeviceName || "";
  let initialNameResult: OAuthConnectionNameResultClient | null = null;
  let initialErrorCode = single(params.connection_error) || null;
  if (defaultLabel.trim()) {
    try {
      const result = await checkOAuthConnectionName(database, {
        accountId: principal.accountId,
        audience: authorization.audience,
        label: defaultLabel,
      });
      initialNameResult = result.status === "available"
        ? result
        : {
            ...result,
            existing: {
              ...result.existing,
              createdAt: result.existing.createdAt.toISOString(),
              lastUsedAt: result.existing.lastUsedAt?.toISOString() ?? null,
            },
          };
    } catch (error) {
      if (error instanceof Error && error.message === "invalid_connection_label") {
        initialErrorCode = "invalid_connection_label";
      } else {
        initialErrorCode = "connection_name_check_failed";
      }
    }
  }
  const authorizationFields = {
    client_id: authorization.clientId,
    code_challenge: authorization.codeChallenge,
    code_challenge_method: "S256",
    redirect_uri: authorization.redirectUri,
    resource: authorization.resource,
    response_type: "code",
    scope: authorization.scopes.join(" "),
    ...(authorization.state ? { state: authorization.state } : {}),
  };
  return (
    <div className="page-shell page-shell--form">
      <PageIntro
        description={<p>你正在以 {accountLabel} 授权；网站 Session 不会交给客户端。</p>}
        eyebrow="OAuth + PKCE"
        title={`连接 ${authorization.clientName}`}
      />
      <section className="authorization-card">
        <div className="authorization-card__client"><span>{authorization.clientName.slice(0, 1).toUpperCase()}</span><div><strong>{authorization.clientName}</strong><small>{authorization.resource}</small></div></div>
        <h2>这个客户端将可以</h2>
        <OAuthScopeDisclosure scopes={authorization.scopes} />
        <p>高级 scope 仍会在每次调用时检查当前会员权益；授权不会自动开通会员。</p>
        <OAuthAuthorizationForm
          cancelHref={`/oauth/authorize/cancel?${queryString(authorizationFields)}`}
          clientId={authorization.clientId}
          defaultLabel={defaultLabel}
          fields={authorizationFields}
          initialErrorCode={initialErrorCode}
          initialNameResult={initialNameResult}
          resource={authorization.resource}
        />
      </section>
    </div>
  );
}
