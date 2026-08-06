import { redirect } from "next/navigation";
import { safeReturnTo } from "@attention/auth";

import { AuthModal } from "../../../components/auth-modal";
import { LoginModule } from "../../../components/login-module";
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
      <LoginModule returnTo={returnTo} />
    </AuthModal>
  );
}
