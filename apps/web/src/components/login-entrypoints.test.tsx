import {
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { describe, expect, it } from "vitest";

import { CollectLoginPrompt } from "./collect-modal";
import { LoginLink } from "./login-link";
import { MembershipAction } from "./membership-action";
import { PublicFeed } from "./public-feed";

type LoginElement = ReactElement<{
  children?: ReactNode;
  returnTo?: string;
}>;

function loginLinks(node: ReactNode): LoginElement[] {
  const matches: LoginElement[] = [];
  function visit(value: ReactNode): void {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isValidElement<{ children?: ReactNode; returnTo?: string }>(value)) {
      return;
    }
    if (value.type === LoginLink) matches.push(value);
    visit(value.props.children);
  }
  visit(node);
  return matches;
}

function expectLoginTarget(node: ReactNode, returnTo: string): void {
  const matches = loginLinks(node);
  expect(matches).toHaveLength(1);
  expect(matches[0]?.props.returnTo).toBe(returnTo);
}

describe("login entrypoints", () => {
  it("keeps the collection login action inside intercepted navigation", () => {
    expectLoginTarget(CollectLoginPrompt(), "/collect");
  });

  it("keeps the membership login action inside intercepted navigation", () => {
    expectLoginTarget(
      MembershipAction({
        isAuthenticated: false,
        isMember: false,
        providerAvailable: true,
        returnTo: "/ai",
      }),
      "/membership?return_to=%2Fai",
    );
  });

  it("keeps the public-feed paywall login inside intercepted navigation", () => {
    expectLoginTarget(
      PublicFeed({
        contents: [],
        isAuthenticated: false,
        isLimited: true,
        previewLimit: 20,
        view: "cards",
      }),
      "/membership?return_to=%2Fai",
    );
  });
});
