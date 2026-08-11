import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createOAuthConnectionNameValidator,
  OAuthAuthorizationForm,
  OAuthAuthorizationFormPresentation,
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
      },
    ));

    expect(confirming.confirmationOpen).toBe(true);
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("确认替换");
    expect(markup).toContain("返回修改");
    expect(markup).not.toContain("取消授权</a>");
    expect(actionCount(markup)).toBe(2);
  });
});
