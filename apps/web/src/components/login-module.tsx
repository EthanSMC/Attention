import { EmailLoginForm } from "./email-login-form";

export function LoginModule({
  defaultEmail,
  forceCodeOnly = false,
  returnTo,
}: {
  defaultEmail?: string;
  forceCodeOnly?: boolean;
  returnTo: string;
}) {
  return (
    <>
      <p className="login-panel__step">Attention 账号</p>
      <h2>{forceCodeOnly ? "验证邮箱" : "登录"}</h2>
      <p>{forceCodeOnly ? "修改密码前，请先确认当前账号的绑定邮箱。" : "新邮箱会创建 Member 账号，已有邮箱会回到原来的账号。"}</p>
      <EmailLoginForm
        {...(defaultEmail ? { defaultEmail } : {})}
        forceCodeOnly={forceCodeOnly}
        returnTo={returnTo}
      />
    </>
  );
}

export function LoginModuleFallback({ returnTo }: { returnTo: string }) {
  return (
    <div className="page-shell page-shell--form">
      <section aria-label="登录 Attention" className="login-panel">
        <LoginModule returnTo={returnTo} />
      </section>
    </div>
  );
}
