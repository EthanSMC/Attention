# Attention dedicated browser capability — implementation in progress

This package is not yet connected to the installed WeChat Codex runtime.
Importing its library entry point neither starts a browser nor grants access.
Do not advertise this as an installed or working end-to-end article reader.

The independent browser task manager enforces authority checks before and after
reading, bounded task lifetime, cancellation, one active page, and explicit
separation of status-only calls from fresh reads. Its Playwright adapter uses a
dedicated profile and an authenticated loopback egress proxy with public-address
validation and pinned destination sockets.

The MCP wrapper exposes only open/read/status/show/scroll/close. It does not
expose arbitrary evaluation, downloads, uploads, cookies, or general navigation.
Article evidence is private and paginated; later pages require the same SHA.

Workflow intended after explicit enablement and end-to-end acceptance:

1. Open a collection using an Attention-issued grant, then read its article.
2. A verification result: show the task window, end the Agent turn, and read
   again after the owner says verification is complete in that dedicated window.
3. Query status without retrying; close cancels the task but preserves profile.

Implemented locally: server grant issuance/revalidation, account-private summary
persistence/readback, explicit consent bound to the built artifact, optional
Codex MCP registration, and non-blocking message reception with serial Agent work.
Browser-enabled sessions exclude the shared content-enrichment writer: browser
evidence must use the private collection writer. Existing non-browser sessions
retain their previous tool list. Revoking the local receipt closes the active
browser; removing MCP registration takes effect on the next Bridge start.

Development requirements: macOS, Node >=24, frozen workspace dependencies and
the matching Playwright Chromium installation. The CLI itself still supports
Node >=22.16, but will reject browser configuration on a runtime below 24.
The service is default-off (`ATTENTION_DEDICATED_BROWSER_ENABLED` on the server)
and requires explicit local consent; building does not enable either side.

Remaining before enablement: actual browser-to-WeChat-to-private-save acceptance,
safe progress forwarding, bounded transient-read retry, and final concurrency /
network review. Human challenge compatibility must be tested: the present adapter
deliberately blocks POST, subframes and undeclared challenge resources, so support
for a particular verification flow is not assumed. Popup initial-request coverage
and revocation races also require final review before enablement.

The first real article smoke on 2026-09-11 failed: system DNS returned a 198.18.*
fake-IP through the machine's proxy configuration. Public-address validation
correctly rejected it. No article body was obtained and no live collection was
written. Upstream proxy support is not implemented or authorized by the existing
browser consent. Do not allow private/fake-IP addresses to make the test pass.

Never publish this development package or use a fabricated grant authority for
the running Bridge. Unit fixtures are for isolated tests only.
