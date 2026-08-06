import { EmailLoginForm } from "./email-login-form";

export function LoginModule({ returnTo }: { returnTo: string }) {
  return (
    <>
      <p className="login-panel__step">Attention 账号</p>
      <h2>登录</h2>
      <p>新邮箱会创建 Free 账号，已有邮箱会回到原来的账号。</p>
      <EmailLoginForm returnTo={returnTo} />
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
