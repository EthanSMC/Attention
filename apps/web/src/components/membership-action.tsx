import { LoginLink } from "./login-link";

export function MembershipAction({
  isAuthenticated,
  isMember,
  providerAvailable,
  returnTo,
}: {
  isAuthenticated: boolean;
  isMember: boolean;
  providerAvailable: boolean;
  returnTo: string;
}) {
  if (isMember) return <span className="membership-current">当前已拥有完整 Member 权益</span>;
  if (!isAuthenticated) {
    return (
      <LoginLink
        className="button button--primary"
        returnTo={`/membership?return_to=${encodeURIComponent(returnTo)}`}
      >
        登录后开通
      </LoginLink>
    );
  }
  return providerAvailable
    ? <a className="button button--primary" href={`/membership/checkout?return_to=${encodeURIComponent(returnTo)}`}>查看扣费日期并继续</a>
    : <button className="button button--primary" disabled type="button">暂未开放购买</button>;
}
