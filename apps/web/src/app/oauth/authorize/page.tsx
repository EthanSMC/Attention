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

const scopeLabels: Record<string, string> = {
  "ai:search": "使用托管 AI 检索（需要实时 Member 权益）",
  "channel:bind:report": "报告本地渠道绑定与验证结果",
  "channel:disconnect:report": "报告本地渠道断开与凭证删除结果",
  "collection:read": "读取你的个人收藏",
  "collection:write": "替你新增私人收藏",
  "digest:read": "读取你的日报订阅与发送时间",
  "digest:write": "修改你的日报订阅与发送时间",
  "moderation:write": "按你的要求举报公开内容",
  "moderation:court:read": "读取 Filter 小法庭的当前案件与票数",
  "moderation:court:vote": "在你逐次明确确认后提交不可更改的小法庭投票",
  "profile:read": "读取你的公开资料和会员状态",
  "public:full": "读取完整公开流（需要实时 Member 权益）",
  "public:read": "读取当前可见的公开内容",
  "runtime:heartbeat": "上报本地 Runtime 与渠道健康状态",
  "runtime:register": "注册当前本地 Agent 安装",
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
        <ul>{authorization.scopes.map((scope) => <li key={scope}>{scopeLabels[scope] ?? scope}</li>)}</ul>
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
