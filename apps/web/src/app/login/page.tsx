import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { safeReturnTo } from "@attention/auth";

import { LoginModule, LoginModuleFallback } from "../../components/login-module";
import { getPagePrincipal } from "../../server/session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "登录",
  description: "使用邮箱验证码注册或登录 Attention。",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reauth?: string; return_to?: string }>;
}) {
  const params = await searchParams;
  const returnTo = safeReturnTo(params.return_to);
  const principal = await getPagePrincipal();
  const forceReauth = params.reauth === "1";
  if (principal && !forceReauth) redirect(returnTo);

  return forceReauth && principal ? (
    <div className="page-shell page-shell--form">
      <section aria-label="验证 Attention 邮箱" className="login-panel">
        <LoginModule
          {...(principal.primaryEmail ? { defaultEmail: principal.primaryEmail } : {})}
          forceCodeOnly
          returnTo={returnTo}
        />
      </section>
    </div>
  ) : (
    <LoginModuleFallback returnTo={returnTo} />
  );
}
