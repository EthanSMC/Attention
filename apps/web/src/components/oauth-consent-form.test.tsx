import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  OAuthConsentForm,
  OAuthConsentFormPresentation,
} from "./oauth-consent-form";

const fields = {
  client_id: "client-1",
  code_challenge: "a".repeat(43),
  code_challenge_method: "S256" as const,
  redirect_uri: "http://127.0.0.1:43820/callback",
  resource: "https://attention.example/mcp",
  response_type: "code" as const,
  scope: "profile:read",
  state: "opaque-state",
};

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

describe("OAuthConsentForm", () => {
  it("renders only the exact allow and refuse actions", () => {
    const markup = renderToStaticMarkup(
      <OAuthConsentForm
        cancelHref="/oauth/authorize/cancel?client_id=client-1"
        fields={fields}
      />,
    );

    expect(markup).toContain(">允许并连接</button>");
    expect(markup).toContain(">拒绝</a>");
    expect(markup.match(/<(?:a|button)\b/gu)).toHaveLength(2);
    expect(markup).not.toContain("connection_label");
    expect(markup).not.toContain("replacement_connection_id");
  });

  it("accepts only the first synchronous submission", () => {
    const onPending = vi.fn();
    const submissionGuard = { current: false };
    const tree = OAuthConsentFormPresentation({
      cancelHref: "/oauth/authorize/cancel?client_id=client-1",
      fields,
      onPending,
      pending: false,
      submissionGuard,
    });
    const form = findElement(tree, (element) => element.type === "form");
    const onSubmit = form?.props.onSubmit as ((event: unknown) => void) | undefined;
    const attributes = new Map<string, string>();
    const submitter = {
      disabled: false,
      setAttribute: (name: string, value: string) => attributes.set(name, value),
    };
    const preventDefault = vi.fn();
    const event = {
      nativeEvent: { submitter },
      preventDefault,
    };

    expect(onSubmit).toBeTypeOf("function");
    onSubmit?.(event);
    onSubmit?.(event);

    expect(onPending).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(submitter.disabled).toBe(true);
    expect(attributes.get("aria-busy")).toBe("true");
  });

  it("announces and disables the allow action while connecting", () => {
    const markup = renderToStaticMarkup(
      <OAuthConsentFormPresentation
        cancelHref="/oauth/authorize/cancel?client_id=client-1"
        fields={fields}
        onPending={() => undefined}
        pending
        submissionGuard={{ current: true }}
      />,
    );

    expect(markup).toMatch(/<form[^>]*aria-busy="true"/u);
    expect(markup).toMatch(/<button[^>]*aria-busy="true"[^>]*disabled=""/u);
    expect(markup).toContain("正在连接…");
    expect(markup).toContain('role="status"');
  });
});
