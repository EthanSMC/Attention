import { redirect } from "next/navigation";
import { safeReturnTo } from "@attention/auth";

import { AuthModal } from "../../../components/auth-modal";
import { LoginModule } from "../../../components/login-module";
import { getPagePrincipal } from "../../../server/session";

export const dynamic = "force-dynamic";

export default async function InterceptedLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reauth?: string; return_to?: string }>;
}) {
  const params = await searchParams;
  const returnTo = safeReturnTo(params.return_to);
  const forceReauth = params.reauth === "1";
  const principal = await getPagePrincipal();
  if (principal && !forceReauth) redirect(returnTo);
  return (
    <AuthModal>
      <LoginModule
        {...(forceReauth && principal?.primaryEmail
          ? { defaultEmail: principal.primaryEmail }
          : {})}
        forceCodeOnly={forceReauth && Boolean(principal?.primaryEmail)}
        returnTo={returnTo}
      />
    </AuthModal>
  );
}
