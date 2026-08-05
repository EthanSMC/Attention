import { redirect } from "next/navigation";
import { safeReturnTo } from "@attention/auth";

import { AuthModal } from "../../../components/auth-modal";
import { EmailLoginForm } from "../../../components/email-login-form";
import { getPagePrincipal } from "../../../server/session";

export const dynamic = "force-dynamic";

export default async function InterceptedLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ return_to?: string }>;
}) {
  const returnTo = safeReturnTo((await searchParams).return_to);
  const principal = await getPagePrincipal();
  if (principal) redirect(returnTo);
  return (
    <AuthModal>
      <p className="login-panel__step">Attention 账号</p>
      <h2>登录</h2>
      <EmailLoginForm presentation="modal" returnTo={returnTo} />
    </AuthModal>
  );
}
