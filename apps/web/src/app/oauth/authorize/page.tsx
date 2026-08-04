import type { Metadata } from "next";
import { redirect } from "next/navigation";

import {
  OAuthError,
  validateAuthorizationRequest,
} from "@attention/auth";

import { PageIntro } from "../../../components/page-intro";
import { getWebDatabase } from "../../../server/db";
import { getPagePrincipal } from "../../../server/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "授权 Agent" };

interface AuthorizationParams {
  audience?: string;
  client_id?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  redirect_uri?: string;
  response_type?: string;
  scope?: string;
  state?: string;
}

function queryString(params: AuthorizationParams): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
  return query.toString();
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
    authorization = await validateAuthorizationRequest(getWebDatabase(), {
      audience: params.audience ?? "",
      clientId: params.client_id ?? "",
      codeChallenge: params.code_challenge ?? "",
      codeChallengeMethod: params.code_challenge_method ?? "",
      redirectUri: params.redirect_uri ?? "",
      responseType: params.response_type ?? "",
      scope: params.scope ?? "",
      ...(params.state ? { state: params.state } : {}),
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
        <div className="authorization-card__client"><span>{authorization.clientName.slice(0, 1).toUpperCase()}</span><div><strong>{authorization.clientName}</strong><small>{authorization.audience}</small></div></div>
        <h2>这个客户端将可以</h2>
        <ul>{authorization.scopes.map((scope) => <li key={scope}>{scopeLabels[scope] ?? scope}</li>)}</ul>
        <p>高级 scope 仍会在每次调用时检查当前会员权益；授权不会自动开通会员。</p>
        <form action="/oauth/authorize/confirm" method="post">
          <input name="audience" type="hidden" value={authorization.audience} />
          <input name="client_id" type="hidden" value={authorization.clientId} />
          <input name="code_challenge" type="hidden" value={authorization.codeChallenge} />
          <input name="code_challenge_method" type="hidden" value="S256" />
          <input name="redirect_uri" type="hidden" value={authorization.redirectUri} />
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
