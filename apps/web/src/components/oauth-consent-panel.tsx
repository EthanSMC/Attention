import type { OAuthConsentPresentation } from "../lib/oauth-consent-presentation";
import {
  OAuthConsentForm,
  type OAuthConsentFields,
} from "./oauth-consent-form";

export function OAuthConsentPanel({
  accountLabel,
  cancelHref,
  clientName,
  fields,
  presentation,
}: {
  accountLabel: string;
  cancelHref: string;
  clientName: string;
  fields: OAuthConsentFields;
  presentation: OAuthConsentPresentation;
}) {
  return (
    <article className="oauth-consent">
      <header className="oauth-consent__header">
        <h1>{clientName} 想要访问你的 Attention</h1>
        <p>{presentation.audienceSummary}</p>
        <p className="oauth-consent__account">当前使用 {accountLabel}</p>
      </header>

      <section aria-labelledby="oauth-permissions-title">
        <h2 id="oauth-permissions-title">允许后，{clientName} 可以</h2>
        <div className="oauth-consent__permissions">
          {presentation.permissionGroups.map((group) => (
            <section
              className="oauth-permission"
              data-risk={group.risk}
              key={group.id}
            >
              <h3>{group.title}</h3>
              <p>{group.description}</p>
            </section>
          ))}
        </div>
      </section>

      <section
        aria-labelledby="oauth-data-title"
        className="oauth-consent__data"
      >
        <h2 id="oauth-data-title">授权后可能接触的数据</h2>
        <ul>
          {presentation.dataItems.map((item) => <li key={item}>{item}</li>)}
        </ul>
      </section>

      <section
        aria-labelledby="oauth-assurances-title"
        className="oauth-consent__assurances"
      >
        <h2 id="oauth-assurances-title">安全与控制</h2>
        <p>
          <strong>Attention 登录 Session 不会交给 {clientName}</strong>；客户端只会获得你在这里允许的访问权限。
        </p>
        <p>
          你可以随时前往<a href="/account/connections">连接与授权</a>撤销访问。
        </p>
      </section>

      <p className="oauth-consent__privacy">
        继续即表示你已了解 Attention 如何处理授权数据。查看
        <a href="/privacy" rel="noreferrer" target="_blank">
          Attention 隐私政策（在新窗口打开）
        </a>
        。
      </p>

      <OAuthConsentForm cancelHref={cancelHref} fields={fields} />
    </article>
  );
}
