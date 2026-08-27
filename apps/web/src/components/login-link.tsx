import Link from "next/link";
import type { ComponentProps } from "react";

export interface LoginHrefOptions {
  reauthenticate?: boolean;
  returnTo?: string;
}

export function loginHref({
  reauthenticate = false,
  returnTo = "/ai",
}: LoginHrefOptions = {}): string {
  const search = new URLSearchParams({ return_to: returnTo });
  if (reauthenticate) search.set("reauth", "1");
  return `/login?${search.toString()}`;
}

export function LoginLink({
  reauthenticate = false,
  returnTo = "/ai",
  ...props
}: Omit<ComponentProps<typeof Link>, "href"> & LoginHrefOptions) {
  return <Link {...props} href={loginHref({ reauthenticate, returnTo })} />;
}
