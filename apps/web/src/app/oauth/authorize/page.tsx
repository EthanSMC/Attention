import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import {
  OAuthError,
  validateAuthorizationRequest,
} from "@attention/auth";

import { PageIntro } from "../../../components/page-intro";
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

const scopeLabels: Record<string, string> = {
  "ai:search": "使用托管 AI 检索（需要实时 Member 权益）",
  "collection:read": "读取你的个人收藏",
  "collection:write": "替你新增私人收藏",
  "profile:read": "读取 @handle 和会员状态",
  "public:full": "读取完整公开流（需要实时 Member 权益）",
  "public:read": "读取当前可见的公开内容",
  "subscription:read": "读取订阅状态",
  "sync:read": "下载你的同步变更",
  "sync:write": "上传你的同步变更",
};

export default async function OAuthAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<AuthorizationParams>;
}) {
  const params = await searchParams;
  let authorization;
  try {
    const origin = await authorizationOrigin();
    authorization = await validateAuthorizationRequest(getWebDatabase(), {
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
  return (
    <div className="page-shell page-shell--form">
      <PageIntro
        description={<p>你正在以 @{principal.stableHandle} 授权；网站 Session 不会交给客户端。</p>}
        eyebrow="OAuth + PKCE"
        title={`连接 ${authorization.clientName}`}
      />
      <section className="authorization-card">
        <div className="authorization-card__client"><span>{authorization.clientName.slice(0, 1).toUpperCase()}</span><div><strong>{authorization.clientName}</strong><small>{authorization.resource}</small></div></div>
        <h2>这个客户端将可以</h2>
        <ul>{authorization.scopes.map((scope) => <li key={scope}>{scopeLabels[scope] ?? scope}</li>)}</ul>
        <p>高级 scope 仍会在每次调用时检查当前会员权益；授权不会自动开通会员。</p>
        <form action="/oauth/authorize/confirm" method="post">
          <input name="client_id" type="hidden" value={authorization.clientId} />
          <input name="code_challenge" type="hidden" value={authorization.codeChallenge} />
          <input name="code_challenge_method" type="hidden" value="S256" />
          <input name="redirect_uri" type="hidden" value={authorization.redirectUri} />
          <input name="resource" type="hidden" value={authorization.resource} />
          <input name="response_type" type="hidden" value="code" />
          <input name="scope" type="hidden" value={authorization.scopes.join(" ")} />
          {authorization.state ? <input name="state" type="hidden" value={authorization.state} /> : null}
          <button className="button button--primary" type="submit">允许连接</button>
          <a
            className="button button--secondary"
            href={`/oauth/authorize/cancel?${queryString(params)}`}
          >
            取消
          </a>
        </form>
      </section>
    </div>
  );
}
