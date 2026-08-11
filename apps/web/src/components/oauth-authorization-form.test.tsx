import {
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createOAuthConnectionNameValidator,
  OAuthAuthorizationForm,
  OAuthAuthorizationFormPresentation,
  oauthReplacementDialogNavigation,
  oauthAuthorizationFormReducer,
  type OAuthAuthorizationFormState,
} from "./oauth-authorization-form";

const available = {
  label: "Office MacBook",
  normalizedLabel: "office macbook",
  status: "available" as const,
};
const replaceable = {
  existing: {
    clientName: "Codex",
    connectionId: "20000000-0000-4000-8000-000000000002",
    createdAt: "2026-08-10T10:00:00.000Z",
    lastUsedAt: "2026-08-11T10:00:00.000Z",
  },
  label: "Office MacBook",
  normalizedLabel: "office macbook",
  status: "replaceable" as const,
};

const fields = {
  client_id: "client-1",
  code_challenge: "a".repeat(43),
  code_challenge_method: "S256",
  redirect_uri: "http://127.0.0.1:43820/callback",
  resource: "https://attention.example/mcp",
  response_type: "code",
  scope: "profile:read",
  state: "opaque-state",
};

const formProps = {
  cancelHref: "/oauth/authorize/cancel?client_id=client-1",
  clientId: "client-1",
  defaultLabel: "Office MacBook",
  fields,
  resource: "https://attention.example/mcp",
};

function actionCount(markup: string): number {
  return (markup.match(/<(?:a|button)\b/gu) ?? []).length;
}

function findElement(
  node: ReactNode,
  predicate: (element: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, unknown>> | null {
  if (!isValidElement<Record<string, unknown>>(node)) return null;
  if (predicate(node)) return node;
  const children = node.props.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const match = findElement(child as ReactNode, predicate);
      if (match) return match;
    }
    return null;
  }
  return findElement(children as ReactNode, predicate);
}

describe("OAuthAuthorizationForm", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("checks the initial default immediately and debounces edits by 350ms", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => available);
    const states: string[] = [];
    const validator = createOAuthConnectionNameValidator({
      onError: () => states.push("error"),
      onResult: (_label, result) => states.push(result.status),
      onStart: () => states.push("checking"),
      request,
    });

    validator.validate("Office MacBook", { immediate: true });
    await vi.runAllTicks();
    expect(request).toHaveBeenCalledTimes(1);

    validator.validate("Studio Mac");
    await vi.advanceTimersByTimeAsync(349);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(states).toEqual([
      "checking",
      "available",
      "checking",
      "available",
    ]);
  });

  it("aborts an in-flight request and ignores its stale result after an edit", async () => {
    vi.useFakeTimers();
    const resolvers: Array<(value: typeof available) => void> = [];
    const signals: AbortSignal[] = [];
    const results: string[] = [];
    const validator = createOAuthConnectionNameValidator({
      onError: () => results.push("error"),
      onResult: (label) => results.push(label),
      onStart: () => undefined,
      request: vi.fn((_input, signal) => {
        signals.push(signal);
        return new Promise<typeof available>((resolve) => resolvers.push(resolve));
      }),
    });

    validator.validate("Old label", { immediate: true });
    validator.validate("New label");
    expect(signals[0]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(350);
    resolvers[0]!(available);
    resolvers[1]!(available);
    await vi.runAllTicks();

    expect(results).toEqual(["New label"]);
  });

  it("renders exactly Continue and Cancel Authorization for an available name", () => {
    const markup = renderToStaticMarkup(createElement(OAuthAuthorizationForm, {
      ...formProps,
      initialNameResult: available,
    }));

    expect(markup).toContain(">继续</button>");
    expect(markup).toContain(">取消授权</a>");
    expect(markup).not.toContain("继续并替换");
    expect(actionCount(markup)).toBe(2);
  });

  it("disables the primary action while a name is being checked", () => {
    const markup = renderToStaticMarkup(createElement(OAuthAuthorizationForm, {
      ...formProps,
      initialNameResult: null,
    }));

    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>继续<\/button>/u);
    expect(actionCount(markup)).toBe(2);
  });

  it("keeps an untouched empty name neutral until the user interacts", () => {
    const markup = renderToStaticMarkup(createElement(OAuthAuthorizationForm, {
      ...formProps,
      defaultLabel: "",
      initialNameResult: null,
    }));

    expect(markup).toContain("请输入用于识别设备或用途的名称");
    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toContain("请输入 1–80 个可见字符");
  });

  it("shows a concise old-connection summary and replacement action for a duplicate", () => {
    const markup = renderToStaticMarkup(createElement(OAuthAuthorizationForm, {
      ...formProps,
      initialNameResult: replaceable,
    }));

    expect(markup).toContain("Codex");
    expect(markup).toContain("2026年8月10日");
    expect(markup).toContain("继续并替换");
    expect(markup).toContain("取消授权");
    expect(markup).toContain(`value="${replaceable.existing.connectionId}"`);
    expect(actionCount(markup)).toBe(2);
  });

  it("removes stale duplicate state while checking an edited name, then shows Continue", () => {
    const duplicateState: OAuthAuthorizationFormState = {
      confirmationOpen: false,
      error: null,
      label: "Office MacBook",
      phase: "ready",
      result: replaceable,
    };
    const checking = oauthAuthorizationFormReducer(duplicateState, {
      label: "Studio Mac",
      type: "label_changed",
    });
    const unique = oauthAuthorizationFormReducer(checking, {
      label: "Studio Mac",
      result: { ...available, label: "Studio Mac", normalizedLabel: "studio mac" },
      type: "validation_succeeded",
    });
    const markup = renderToStaticMarkup(createElement(
      OAuthAuthorizationFormPresentation,
      {
        ...formProps,
        dispatch: () => undefined,
        state: unique,
        submissionGuard: { current: false },
      },
    ));

    expect(checking.result).toBeNull();
    expect(unique.result?.status).toBe("available");
    expect(markup).toContain(">继续</button>");
    expect(markup).not.toContain("Codex");
    expect(markup).not.toContain("replacement_connection_id");
  });

  it("opens a two-action confirmation modal before replacement submission", () => {
    const duplicateState: OAuthAuthorizationFormState = {
      confirmationOpen: false,
      error: null,
      label: "Office MacBook",
      phase: "ready",
      result: replaceable,
    };
    const confirming = oauthAuthorizationFormReducer(duplicateState, {
      type: "replacement_confirmation_opened",
    });
    const markup = renderToStaticMarkup(createElement(
      OAuthAuthorizationFormPresentation,
      {
        ...formProps,
        dispatch: () => undefined,
        state: confirming,
        submissionGuard: { current: false },
      },
    ));

    expect(confirming.confirmationOpen).toBe(true);
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("确认替换");
    expect(markup).toContain("返回修改");
    expect(markup).not.toContain("取消授权</a>");
    expect(actionCount(markup)).toBe(2);

    const closed = oauthAuthorizationFormReducer(confirming, {
      type: "replacement_confirmation_closed",
    });
    const closedMarkup = renderToStaticMarkup(createElement(
      OAuthAuthorizationFormPresentation,
      {
        ...formProps,
        dispatch: () => undefined,
        state: closed,
        submissionGuard: { current: false },
      },
    ));
    expect(closed.confirmationOpen).toBe(false);
    expect(closedMarkup).toContain("继续并替换");
    expect(closedMarkup).toContain("取消授权");
    expect(actionCount(closedMarkup)).toBe(2);
  });

  it("accepts only one synchronous click on the replacement confirmation", () => {
    const confirming: OAuthAuthorizationFormState = {
      confirmationOpen: true,
      error: null,
      label: "Office MacBook",
      phase: "ready",
      result: replaceable,
    };
    const submissionGuard = { current: false };
    const tree = OAuthAuthorizationFormPresentation({
      ...formProps,
      dispatch: () => undefined,
      state: confirming,
      submissionGuard,
    });
    const confirmButton = findElement(
      tree,
      (element) => element.type === "button" &&
        element.props.children === "确认替换",
    );
    const onClick = confirmButton?.props.onClick as ((event: unknown) => void) | undefined;
    const requestSubmit = vi.fn();
    const attributes = new Map<string, string>();
    const button = {
      disabled: false,
      form: { requestSubmit },
      setAttribute: (name: string, value: string) => attributes.set(name, value),
    };
    const preventDefault = vi.fn();

    expect(onClick).toBeTypeOf("function");
    onClick?.({ currentTarget: button, preventDefault });
    onClick?.({ currentTarget: button, preventDefault });

    expect(requestSubmit).toHaveBeenCalledTimes(1);
    expect(requestSubmit).toHaveBeenCalledWith(button);
    expect(button.disabled).toBe(true);
    expect(attributes.get("aria-busy")).toBe("true");
    expect(actionCount(renderToStaticMarkup(tree))).toBe(2);
  });

  it("defines a two-action keyboard loop and Escape close behavior", () => {
    expect(oauthReplacementDialogNavigation({
      activeIndex: 0,
      focusCount: 2,
      key: "Tab",
      shiftKey: true,
    })).toEqual({ focusIndex: 1, preventDefault: true });
    expect(oauthReplacementDialogNavigation({
      activeIndex: 1,
      focusCount: 2,
      key: "Tab",
      shiftKey: false,
    })).toEqual({ focusIndex: 0, preventDefault: true });
    expect(oauthReplacementDialogNavigation({
      activeIndex: 0,
      focusCount: 2,
      key: "Escape",
      shiftKey: false,
    })).toEqual({ close: true, preventDefault: true });
  });
});
