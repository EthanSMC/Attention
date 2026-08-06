import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { safeReturnTo } from "@attention/auth";

import { LoginModuleFallback } from "../../components/login-module";
import { getPagePrincipal } from "../../server/session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "登录",
  description: "使用邮箱验证码注册或登录 Attention。",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ return_to?: string }>;
}) {
  const params = await searchParams;
  const returnTo = safeReturnTo(params.return_to);
  const principal = await getPagePrincipal();
  if (principal) redirect(returnTo);

  return <LoginModuleFallback returnTo={returnTo} />;
}
