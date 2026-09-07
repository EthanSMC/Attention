import { describe, expect, it } from "vitest";

import { classifyDocument } from "./document-classifier";

const input = {
  finalUrl: "https://example.com/a",
  sourceKind: "generic_web",
  status: 200,
} as const;

describe("document classification", () => {
  it.each([
    ['<html><head><title>Sign in to continue</title></head><body><article><h1>Sign in to continue</h1><p>Sign in is required to read this article. Please sign in to continue reading.</p><a href="/login">Sign in</a></article></body></html>', "login_required"],
    ['<html><head><script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":false}</script></head><body><article><h1>Subscribe to continue reading</h1><p>A subscription is required to read this article.</p><a href="/subscribe">Subscribe</a></article></body></html>', "access_denied"],
  ])("blocks explicit primary link-only access gates", (html, code) => {
    expect(classifyDocument({...input, html})).toMatchObject({kind: "blocked", code, text: null});
  });
  it.each([
    '<article><h1>How sign-in and subscription payments work</h1><p>Sign in to continue is a common notice. This article explains login protocols and payment subscriptions.</p><a href="/login">Sign in</a></article>',
    '<article><h1>Sign in to continue</h1><p>This essay examines the design and usability of authentication notices.</p><aside><a href="/login">Sign in</a></aside></article>',
    '<article><h1>Subscribe to continue reading</h1><p>This study examines subscription notices and their effect on readers.</p><a hidden href="/subscribe">Subscribe</a></article>',
    '<article><h1>Public findings</h1><p>The experiment measured a reproducible improvement under controlled conditions.</p></article><aside><h1>Subscribe to continue reading</h1><p>A subscription is required to read this article.</p><a href="/subscribe">Subscribe</a></aside>',
    '<article><h1>Public findings</h1><p>The experiment measured a reproducible improvement under controlled conditions.</p></article><aside><h1>Sign in to continue</h1><p>Please sign in to continue reading.</p><a href="/login">Sign in</a></aside>',
  ])("retains real article evidence with access-related discussion or sidebar notices", html => {
    expect(classifyDocument({...input, html})).toMatchObject({kind: "article", code: null});
  });
  it("blocks a primary-content login notice even when its paragraph survives extraction", () => {
    expect(classifyDocument({
      ...input,
      html: '<html><head><title>Member account</title></head><body><main><p>Sign in to continue reading this article.</p><form action="/login"><input type="password"><button>Sign in</button></form></main></body></html>',
    })).toMatchObject({ kind: "blocked", code: "login_required", text: null });
  });

  it.each([
    '<article hidden>Not visible article</article>',
    '<article style="display:none">Not visible article</article>',
    '<form><article>Form contents</article></form>',
    '<aside><article>Sidebar contents</article></aside>',
    '<article></article>',
  ])("does not borrow article status from removed or empty structures: %s", (removed) => {
    expect(classifyDocument({
      ...input,
      html: `<html><body>${removed}<div>Home Subscribe Contact</div></body></html>`,
    })).toMatchObject({ kind: "empty", code: "evidence_insufficient", text: null });
  });

  it("accepts substantive extracted article text in an ordinary div", () => {
    const result = classifyDocument({
      ...input,
      html: '<html><body><div id="js_content"><h1>Controlled experiment report</h1><p>The researchers randomly assigned participants to two groups and measured response times under identical conditions. Each group completed the same series of tasks over six weeks.</p><p>The treatment group showed a consistent improvement in response time compared with the control group. The report describes the measurement procedure and explains the remaining uncertainty.</p></div></body></html>',
    });
    expect(result).toMatchObject({ kind: "article", code: null });
    expect(result.text).toContain("randomly assigned participants");
    expect(result.text).toContain("remaining uncertainty");
  });

  it("does not promote a long div of navigation links through the substantive-text fallback", () => {
    expect(classifyDocument({
      ...input,
      html: `<html><body><div>${'<a href="/archive">Browse the complete research archive. Subscribe to receive future reports.</a>'.repeat(8)}</div></body></html>`,
    })).toMatchObject({ kind: "empty", code: "evidence_insufficient", text: null });
  });

  it("recognizes a page-level verification notice without a form", () => {
    expect(classifyDocument({
      ...input,
      html: "<html><head><title>Verify you are human</title></head><body><main>Please complete the security check to continue.</main></body></html>",
    })).toMatchObject({ kind: "blocked", code: "verification_required", text: null });
  });

  it("classifies a structured verification page as blocked", () => {
    expect(classifyDocument({
      ...input,
      html: `<html><head><title>Verify you are human</title></head><body>
        <main><form id="challenge-form" action="/challenge"><h1>Security check</h1>
        <p>Please complete the security check to continue.</p>
        <input name="cf-turnstile-response"></form></main></body></html>`,
    })).toMatchObject({ kind: "blocked", code: "verification_required", text: null });
  });

  it("classifies a login form as blocked without treating its description as article evidence", () => {
    expect(classifyDocument({
      ...input,
      html: `<html><head><meta name="description" content="Sign in to continue reading"></head>
        <body><main><form action="/login"><label>Email<input type="email" name="email"></label>
        <label>Password<input type="password" name="password"></label><button>Sign in</button>
        </form></main></body></html>`,
    })).toMatchObject({
      code: "login_required",
      description: "Sign in to continue reading",
      kind: "blocked",
      text: null,
    });
  });

  it("keeps a metadata-only rendering shell out of article evidence", () => {
    expect(classifyDocument({
      ...input,
      html: `<html><head><title>Research notes</title>
        <meta name="description" content="A preview supplied before the application renders.">
        </head><body><div id="app"></div><script src="/bundle.js"></script></body></html>`,
    })).toMatchObject({
      code: "render_required",
      description: "A preview supplied before the application renders.",
      extractionMethod: "metadata",
      kind: "metadata_only",
      text: null,
    });
  });

  it("does not block a short article that discusses CAPTCHA", () => {
    expect(classifyDocument({
      ...input,
      html: `<article><h1>How CAPTCHA works</h1><p>CAPTCHA uses challenge-response tests.
        This article explains their accessibility costs.</p></article>`,
    })).toMatchObject({
      code: null,
      extractionMethod: "readability",
      kind: "article",
    });
  });

  it("keeps article evidence when CAPTCHA terminology is only a CSS class", () => {
    expect(classifyDocument({
      ...input,
      html: '<article class="captcha-explainer"><h1>How CAPTCHA works</h1><p>CAPTCHA uses challenge-response tests. This article explains their accessibility costs.</p></article>',
    })).toMatchObject({ kind: "article", code: null });
  });

  it("keeps a readable article when an incidental sign-in form appears beside it", () => {
    expect(classifyDocument({
      ...input,
      html: '<html><body><article><h1>Public research notes</h1><p>The public research report describes a controlled experiment with concrete findings.</p></article><aside><form action="/login"><input type="password"></form></aside></body></html>',
    })).toMatchObject({ kind: "article", code: null });
  });

  it("rejects conflicting JSON-LD and visible article bodies as insufficient evidence", () => {
    expect(classifyDocument({
      ...input,
      html: `<html><head><script type="application/ld+json">{
        "@type":"Article","headline":"Quarterly report",
        "articleBody":"Revenue increased after the product launch in the eastern region."
      }</script></head><body><article><h1>Quarterly report</h1>
        <p>The championship final ended after a penalty shootout in the national stadium.</p>
      </article></body></html>`,
    })).toMatchObject({
      code: "evidence_insufficient",
      kind: "metadata_only",
      text: null,
    });
  });

  it("marks body truncation while preserving the article source", () => {
    const result = classifyDocument({
      ...input,
      html: `<article><h1>Long report</h1><p>${"Grounded sentence with concrete evidence. ".repeat(500)}</p></article>`,
    });
    expect(result).toMatchObject({
      code: null,
      extractionMethod: "readability",
      kind: "article",
      truncated: true,
    });
    expect(result.text).toHaveLength(12_000);
  });

  it("does not promote arbitrary nonempty body text to article evidence", () => {
    expect(classifyDocument({
      ...input,
      html: "<html><body><div>Home Subscribe Contact</div></body></html>",
    })).toMatchObject({ kind: "empty", text: null });
  });

  it.each([
    [403, "access_denied"],
    [404, "source_not_found"],
    [410, "source_gone"],
    [429, "rate_limited"],
    [503, "upstream_5xx"],
  ] as const)("classifies HTTP %i before article extraction", (status, code) => {
    expect(classifyDocument({
      ...input,
      status,
      html: "<article><p>This must not become article evidence.</p></article>",
    })).toMatchObject({ code, kind: "blocked", text: null });
  });
});
