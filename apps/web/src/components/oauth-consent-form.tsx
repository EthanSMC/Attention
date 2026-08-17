"use client";

import { useRef, useState, type FormEvent, type MutableRefObject } from "react";

export interface OAuthConsentFields {
  client_id: string;
  code_challenge: string;
  code_challenge_method: "S256";
  redirect_uri: string;
  resource: string;
  response_type: "code";
  scope: string;
  state?: string;
}

interface OAuthConsentFormProps {
  cancelHref: string;
  fields: OAuthConsentFields;
}

interface OAuthConsentFormPresentationProps extends OAuthConsentFormProps {
  onPending: () => void;
  pending: boolean;
  submissionGuard: MutableRefObject<boolean>;
}

export function OAuthConsentFormPresentation({
  cancelHref,
  fields,
  onPending,
  pending,
  submissionGuard,
}: OAuthConsentFormPresentationProps) {
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    if (submissionGuard.current) {
      event.preventDefault();
      return;
    }

    submissionGuard.current = true;
    const submitter = (event.nativeEvent as SubmitEvent)
      .submitter as HTMLButtonElement | null;
    if (submitter) {
      submitter.disabled = true;
      submitter.setAttribute("aria-busy", "true");
    }
    onPending();
  }

  return (
    <form
      action="/oauth/authorize/confirm"
      aria-busy={pending}
      className="oauth-consent-form"
      method="post"
      onSubmit={onSubmit}
    >
      {Object.entries(fields).map(([name, value]) =>
        value ? <input key={name} name={name} type="hidden" value={value} /> : null
      )}
      <div className="oauth-consent__actions">
        <button
          aria-busy={pending}
          className="button button--primary"
          disabled={pending}
          type="submit"
        >
          {pending ? "正在连接…" : "允许并连接"}
        </button>
        <a className="button button--secondary" href={cancelHref}>
          拒绝
        </a>
      </div>
      <span aria-live="polite" className="sr-only" role="status">
        {pending ? "正在连接客户端，请稍候。" : ""}
      </span>
    </form>
  );
}

export function OAuthConsentForm(props: OAuthConsentFormProps) {
  const [pending, setPending] = useState(false);
  const submissionGuard = useRef(false);

  return (
    <OAuthConsentFormPresentation
      {...props}
      onPending={() => setPending(true)}
      pending={pending}
      submissionGuard={submissionGuard}
    />
  );
}
