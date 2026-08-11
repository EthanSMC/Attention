"use client";

import {
  useEffect,
  useReducer,
  useRef,
  type Dispatch,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from "react";

export type OAuthConnectionNameResultClient =
  | { status: "available"; label: string; normalizedLabel: string }
  | {
      status: "replaceable";
      label: string;
      normalizedLabel: string;
      existing: {
        connectionId: string;
        clientName: string;
        createdAt: string;
        lastUsedAt: string | null;
      };
    };

export interface OAuthAuthorizationFormState {
  confirmationOpen: boolean;
  error: string | null;
  label: string;
  phase: "checking" | "error" | "idle" | "ready";
  result: OAuthConnectionNameResultClient | null;
  touched?: boolean;
}

type OAuthAuthorizationFormAction =
  | { type: "label_changed"; label: string }
  | { type: "validation_started"; label: string }
  | {
      type: "validation_succeeded";
      label: string;
      result: OAuthConnectionNameResultClient;
    }
  | { type: "validation_failed"; label: string; error: string }
  | { type: "replacement_confirmation_opened" }
  | { type: "replacement_confirmation_closed" };

export function oauthAuthorizationFormReducer(
  state: OAuthAuthorizationFormState,
  action: OAuthAuthorizationFormAction,
): OAuthAuthorizationFormState {
  switch (action.type) {
    case "label_changed":
      return {
        confirmationOpen: false,
        error: null,
        label: action.label,
        phase: "checking",
        result: null,
        touched: true,
      };
    case "validation_started":
      if (state.label !== action.label) return state;
      return {
        ...state,
        confirmationOpen: false,
        error: null,
        phase: "checking",
        result: null,
      };
    case "validation_succeeded":
      if (state.label !== action.label) return state;
      return {
        ...state,
        confirmationOpen: false,
        error: null,
        phase: "ready",
        result: action.result,
      };
    case "validation_failed":
      if (state.label !== action.label) return state;
      return {
        ...state,
        confirmationOpen: false,
        error: action.error,
        phase: "error",
        result: null,
      };
    case "replacement_confirmation_opened":
      if (state.phase !== "ready" || state.result?.status !== "replaceable") {
        return state;
      }
      return { ...state, confirmationOpen: true };
    case "replacement_confirmation_closed":
      return { ...state, confirmationOpen: false };
  }
}

interface ConnectionNameCheckInput {
  clientId: string;
  label: string;
  resource: string;
}

interface ConnectionNameValidatorOptions {
  delayMs?: number;
  onError: (label: string, error: unknown) => void;
  onResult: (label: string, result: OAuthConnectionNameResultClient) => void;
  onStart: (label: string) => void;
  request: (
    input: ConnectionNameCheckInput,
    signal: AbortSignal,
  ) => Promise<OAuthConnectionNameResultClient>;
}

export function createOAuthConnectionNameValidator(
  options: ConnectionNameValidatorOptions,
) {
  let controller: AbortController | null = null;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function cancel() {
    generation += 1;
    if (timer) clearTimeout(timer);
    timer = null;
    controller?.abort();
    controller = null;
  }

  function validate(
    label: string,
    config: {
      clientId?: string;
      immediate?: boolean;
      resource?: string;
    } = {},
  ) {
    cancel();
    const currentGeneration = generation;
    options.onStart(label);

    const run = async () => {
      controller = new AbortController();
      const signal = controller.signal;
      try {
        const result = await options.request(
          {
            clientId: config.clientId ?? "client-1",
            label,
            resource: config.resource ?? "https://attention.example/mcp",
          },
          signal,
        );
        if (!signal.aborted && currentGeneration === generation) {
          options.onResult(label, result);
        }
      } catch (error) {
        if (!signal.aborted && currentGeneration === generation) {
          options.onError(label, error);
        }
      }
    };

    if (config.immediate) {
      void run();
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, options.delayMs ?? 350);
  }

  return { cancel, validate };
}

interface OAuthAuthorizationFormFields {
  client_id: string;
  code_challenge: string;
  code_challenge_method: string;
  redirect_uri: string;
  resource: string;
  response_type: string;
  scope: string;
  state?: string;
}

interface OAuthAuthorizationFormProps {
  cancelHref: string;
  clientId: string;
  defaultLabel: string;
  fields: OAuthAuthorizationFormFields;
  initialErrorCode?: string | null;
  initialNameResult: OAuthConnectionNameResultClient | null;
  resource: string;
}

interface OAuthAuthorizationFormPresentationProps
  extends Omit<OAuthAuthorizationFormProps, "defaultLabel" | "initialErrorCode" | "initialNameResult"> {
  dispatch: Dispatch<OAuthAuthorizationFormAction>;
  replacementFocus?: {
    cancelRef: RefObject<HTMLButtonElement | null>;
    confirmRef: RefObject<HTMLButtonElement | null>;
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
    triggerRef: RefObject<HTMLButtonElement | null>;
  };
  state: OAuthAuthorizationFormState;
  submissionGuard: { current: boolean };
}

export function oauthReplacementDialogNavigation({
  activeIndex,
  focusCount,
  key,
  shiftKey,
}: {
  activeIndex: number;
  focusCount: number;
  key: string;
  shiftKey: boolean;
}): { close?: true; focusIndex?: number; preventDefault: boolean } | null {
  if (key === "Escape") return { close: true, preventDefault: true };
  if (key !== "Tab" || focusCount < 1) return null;
  if (shiftKey && activeIndex <= 0) {
    return { focusIndex: focusCount - 1, preventDefault: true };
  }
  if (!shiftKey && (activeIndex < 0 || activeIndex >= focusCount - 1)) {
    return { focusIndex: 0, preventDefault: true };
  }
  return null;
}

function errorMessage(code: unknown): string {
  if (code === "invalid_connection_label") {
    return "请输入 1–80 个可见字符作为连接名称。";
  }
  if (code === "name_conflict") {
    return "连接名称状态已变化，请确认当前同名连接后重试。";
  }
  if (code === "authentication_required") {
    return "登录状态已失效，请重新登录后继续。";
  }
  return "暂时无法检查这个名称，请稍后重试。";
}

function dateLabel(value: string | null): string {
  if (!value) return "暂无使用记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

function isConnectionNameResult(
  value: unknown,
): value is OAuthConnectionNameResultClient {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<OAuthConnectionNameResultClient>;
  if (
    (candidate.status !== "available" && candidate.status !== "replaceable") ||
    typeof candidate.label !== "string" ||
    typeof candidate.normalizedLabel !== "string"
  ) {
    return false;
  }
  if (candidate.status === "available") return true;
  const existing = (candidate as Partial<Extract<
    OAuthConnectionNameResultClient,
    { status: "replaceable" }
  >>).existing;
  return Boolean(
    existing &&
      typeof existing.clientName === "string" &&
      typeof existing.connectionId === "string" &&
      typeof existing.createdAt === "string" &&
      (existing.lastUsedAt === null || typeof existing.lastUsedAt === "string"),
  );
}

async function requestConnectionName(
  input: ConnectionNameCheckInput,
  signal: AbortSignal,
): Promise<OAuthConnectionNameResultClient> {
  const response = await fetch("/api/oauth/connection-name", {
    body: JSON.stringify({
      client_id: input.clientId,
      label: input.label,
      resource: input.resource,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal,
  });
  const body = await response.json() as unknown;
  if (!response.ok) {
    const code = body && typeof body === "object" && "error" in body
      ? (body as { error?: unknown }).error
      : null;
    throw new Error(typeof code === "string" ? code : "connection_name_check_failed");
  }
  if (!isConnectionNameResult(body)) {
    throw new Error("connection_name_check_failed");
  }
  return body;
}

export function OAuthAuthorizationFormPresentation({
  cancelHref,
  dispatch,
  fields,
  replacementFocus,
  state,
  submissionGuard,
}: OAuthAuthorizationFormPresentationProps) {
  const replaceableResult = state.result?.status === "replaceable"
    ? state.result
    : null;
  const canSubmit = state.phase === "ready" && state.result !== null;
  const primaryLabel = replaceableResult ? "继续并替换" : "继续";

  function resetReplacementSubmission(button: HTMLButtonElement | null) {
    submissionGuard.current = false;
    if (!button) return;
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const confirmed = submitter?.dataset.confirmReplacement === "true";
    if (!canSubmit) {
      event.preventDefault();
      if (confirmed) resetReplacementSubmission(submitter);
      return;
    }
    if (replaceableResult && !confirmed) {
      event.preventDefault();
      dispatch({ type: "replacement_confirmation_opened" });
    }
  }

  function onReplacementConfirm(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    const button = event.currentTarget;
    if (!canSubmit || !replaceableResult || submissionGuard.current || !button.form) {
      return;
    }
    submissionGuard.current = true;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try {
      button.form.requestSubmit(button);
    } catch {
      resetReplacementSubmission(button);
    }
  }

  return (
    <form
      action="/oauth/authorize/confirm"
      className="oauth-authorization-form"
      method="post"
      onSubmit={onSubmit}
    >
      {Object.entries(fields).map(([name, value]) =>
        value ? <input key={name} name={name} type="hidden" value={value} /> : null
      )}
      {replaceableResult ? (
        <input
          name="replacement_connection_id"
          type="hidden"
          value={replaceableResult.existing.connectionId}
        />
      ) : null}

      <label className="oauth-authorization-form__field" htmlFor="oauth-connection-label">
        <span>连接名称</span>
        <input
          autoComplete="off"
          id="oauth-connection-label"
          maxLength={80}
          name="connection_label"
          onChange={(event) => dispatch({
            label: event.target.value,
            type: "label_changed",
          })}
          value={state.label}
        />
      </label>
      <p className="oauth-authorization-form__hint">
        使用设备或用途命名，之后可在设置中单独识别和撤销。
      </p>

      <div aria-live="polite" className="oauth-authorization-form__status">
        {!state.touched && !state.label.trim()
          ? "请输入用于识别设备或用途的名称。"
          : state.phase === "checking"
          ? "正在检查名称…"
          : state.result?.status === "available"
            ? "名称可用"
            : state.result?.status === "replaceable"
              ? "该名称已有一个有效连接"
              : null}
      </div>
      {state.error ? (
        <p className="oauth-authorization-form__error" role="alert">{state.error}</p>
      ) : null}

      {replaceableResult ? (
        <section className="oauth-authorization-form__existing" aria-label="现有同名连接">
          <div>
            <strong>{replaceableResult.existing.clientName}</strong>
            <span>授权于 {dateLabel(replaceableResult.existing.createdAt)}</span>
          </div>
          <small>最近使用：{dateLabel(replaceableResult.existing.lastUsedAt)}</small>
        </section>
      ) : null}

      {state.confirmationOpen && replaceableResult ? (
        <div
          aria-labelledby="oauth-replacement-confirmation-title"
          aria-modal="true"
          className="collect-modal oauth-replacement-modal"
          onKeyDown={replacementFocus?.onKeyDown}
          role="dialog"
        >
          <div aria-hidden="true" className="collect-modal__backdrop" />
          <section className="collect-modal__sheet oauth-replacement-modal__sheet">
            <header className="collect-modal__heading">
              <div>
                <p className="eyebrow">替换授权</p>
                <h2 id="oauth-replacement-confirmation-title">替换同名连接？</h2>
              </div>
            </header>
            <p>
              新授权成功后，{replaceableResult.existing.clientName} 的同名旧连接及其令牌将失效。
              如果新授权失败，旧连接保持有效。
            </p>
            <div className="oauth-authorization-form__actions">
              <button
                className="button button--secondary"
                onClick={() => dispatch({ type: "replacement_confirmation_closed" })}
                ref={replacementFocus?.cancelRef}
                type="button"
              >
                返回修改
              </button>
              <button
                className="button button--primary"
                data-confirm-replacement="true"
                onClick={onReplacementConfirm}
                ref={replacementFocus?.confirmRef}
                type="submit"
              >
                确认替换
              </button>
            </div>
          </section>
        </div>
      ) : (
        <div className="oauth-authorization-form__actions">
          <button
            className="button button--primary"
            disabled={!canSubmit}
            ref={replaceableResult ? replacementFocus?.triggerRef : undefined}
            type="submit"
          >
            {primaryLabel}
          </button>
          <a className="button button--secondary" href={cancelHref}>
            取消授权
          </a>
        </div>
      )}
    </form>
  );
}

export function OAuthAuthorizationForm({
  cancelHref,
  clientId,
  defaultLabel,
  fields,
  initialErrorCode = null,
  initialNameResult,
  resource,
}: OAuthAuthorizationFormProps) {
  const [state, dispatch] = useReducer(oauthAuthorizationFormReducer, {
    confirmationOpen: false,
    error: initialErrorCode ? errorMessage(initialErrorCode) : null,
    label: defaultLabel,
    phase: initialNameResult ? "ready" : initialErrorCode ? "error" : "idle",
    result: initialNameResult,
    touched: Boolean(initialErrorCode),
  });
  const validatorRef = useRef<ReturnType<typeof createOAuthConnectionNameValidator> | null>(null);
  const submissionGuard = useRef(false);
  const replacementCancelRef = useRef<HTMLButtonElement | null>(null);
  const replacementConfirmRef = useRef<HTMLButtonElement | null>(null);
  const replacementTriggerRef = useRef<HTMLButtonElement | null>(null);
  const confirmationWasOpenRef = useRef(false);

  useEffect(() => {
    const validator = createOAuthConnectionNameValidator({
      onError: (label, error) => dispatch({
        error: errorMessage(error instanceof Error ? error.message : error),
        label,
        type: "validation_failed",
      }),
      onResult: (label, result) => dispatch({
        label,
        result,
        type: "validation_succeeded",
      }),
      onStart: (label) => dispatch({ label, type: "validation_started" }),
      request: requestConnectionName,
    });
    validatorRef.current = validator;
    if (defaultLabel.trim()) {
      validator.validate(defaultLabel, { clientId, immediate: true, resource });
    }
    return () => {
      validator.cancel();
      validatorRef.current = null;
    };
  }, [clientId, defaultLabel, resource]);

  useEffect(() => {
    if (state.confirmationOpen) {
      confirmationWasOpenRef.current = true;
      const frame = window.requestAnimationFrame(() => {
        replacementCancelRef.current?.focus();
      });
      return () => window.cancelAnimationFrame(frame);
    }
    if (!confirmationWasOpenRef.current) return;
    confirmationWasOpenRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      replacementTriggerRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [state.confirmationOpen]);

  function onReplacementDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const actions = [replacementCancelRef.current, replacementConfirmRef.current]
      .filter((element): element is HTMLButtonElement => element !== null && !element.disabled);
    const navigation = oauthReplacementDialogNavigation({
      activeIndex: actions.indexOf(document.activeElement as HTMLButtonElement),
      focusCount: actions.length,
      key: event.key,
      shiftKey: event.shiftKey,
    });
    if (!navigation) return;
    if (navigation.preventDefault) event.preventDefault();
    if (navigation.close) {
      dispatch({ type: "replacement_confirmation_closed" });
      return;
    }
    if (navigation.focusIndex !== undefined) {
      actions[navigation.focusIndex]?.focus();
    }
  }

  function formDispatch(action: OAuthAuthorizationFormAction) {
    dispatch(action);
    if (action.type !== "label_changed") return;
    const label = action.label;
    if (!label.trim()) {
      validatorRef.current?.cancel();
      dispatch({
        error: errorMessage("invalid_connection_label"),
        label,
        type: "validation_failed",
      });
      return;
    }
    validatorRef.current?.validate(label, { clientId, resource });
  }

  return (
    <OAuthAuthorizationFormPresentation
      cancelHref={cancelHref}
      clientId={clientId}
      dispatch={formDispatch}
      fields={fields}
      replacementFocus={{
        cancelRef: replacementCancelRef,
        confirmRef: replacementConfirmRef,
        onKeyDown: onReplacementDialogKeyDown,
        triggerRef: replacementTriggerRef,
      }}
      resource={resource}
      state={state}
      submissionGuard={submissionGuard}
    />
  );
}
