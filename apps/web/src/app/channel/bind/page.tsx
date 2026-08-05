import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  ChannelBindingError,
  inspectChannelBindIntent,
} from "@attention/auth";

import { PageIntro } from "../../../components/page-intro";
import { accountIdentityLabel } from "../../../lib/attention";
import { getWebDatabase } from "../../../server/db";
import { getPagePrincipal } from "../../../server/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "绑定 Channel" };

export default async function ChannelBindPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const token = (await searchParams).token ?? "";
  let preview;
  try { preview = await inspectChannelBindIntent(getWebDatabase(), token); }
  catch (error) {
    const message = error instanceof ChannelBindingError && error.code === "binding_expired" ? "绑定链接已过期，请回到消息入口重新发送。" : "这个绑定链接无效或已经使用。";
    return <div className="page-shell"><PageIntro eyebrow="Channel 绑定" title="无法继续绑定" description={<p>{message}</p>} /></div>;
  }
  const principal = await getPagePrincipal();
  const returnTo = `/channel/bind?token=${encodeURIComponent(token)}`;
  if (!principal) redirect(`/auth?return_to=${encodeURIComponent(returnTo)}`);
  const accountLabel = accountIdentityLabel(principal);
  return (
    <div className="page-shell page-shell--form">
      <PageIntro
        description={<p>绑定只影响 {preview.provider} 的这个 Channel 身份，不会共享网站 Session 或 OAuth token。</p>}
        eyebrow="一次性绑定"
        title={`绑定到 ${accountLabel}`}
      />
      {!principal.isMember ? (
        <section className="receipt receipt--neutral"><h2>Hosted Channel 需要 Member</h2><p>开通后会回到这里，明确确认账号后再继续原消息。</p><Link className="button button--primary" href={`/membership?return_to=${encodeURIComponent(returnTo)}`}>查看会员方案</Link></section>
      ) : (
        <section className="authorization-card">
          <h2>确认绑定 {preview.provider}</h2>
          <p>应用标识：{preview.appId}</p>
          <p>确认后，刚才的{preview.action === "collect" ? "收藏" : "检索"}消息会自动继续。已绑定其他账号时系统会阻止换绑。</p>
          <form action="/api/channels/bind" method="post"><input name="token" type="hidden" value={token} /><button className="button button--primary" type="submit">确认绑定到 {accountLabel}</button><Link className="button button--secondary" href="/account/connections">取消</Link></form>
        </section>
      )}
    </div>
  );
}
