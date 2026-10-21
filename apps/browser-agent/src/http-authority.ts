import { BrowserGrantSchema, BrowserTaskError, type BrowserGrant } from "./contracts.js";
import type { BrowserAuthority } from "./task-manager.js";
import { bounded } from "./task-manager.js";

/** Origin is installation configuration, not part of a grant or model input.
 * A grant authorizes this one service call only; no OAuth/browser credential is
 * copied into the local MCP process. Redirects never receive the grant. */
export class HttpBrowserAuthority implements BrowserAuthority {
  private readonly endpoint: string;
  constructor(serviceOrigin: string, private readonly accountId: string | null,
    private readonly fetcher: typeof fetch = fetch) {
    const origin = new URL(serviceOrigin);
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" ||
      origin.search || origin.hash || origin.port) throw new BrowserTaskError("invalid_request");
    this.endpoint = new URL("/api/browser/grants/resolve", origin).toString();
  }
  async resolve(grant: string, signal: AbortSignal): Promise<BrowserGrant> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
    const response = await bounded(this.fetcher(this.endpoint, {
      method: "POST", headers: { authorization: "Bearer " + grant, "content-type": "application/json" },
      body: "{}", redirect: "error", signal: deadline,
    }), deadline);
    if (!response.ok || !response.body) throw new BrowserTaskError("permission_revoked");
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const chunk = await bounded(reader.read(), deadline);
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > 8192) throw new BrowserTaskError("permission_revoked");
        chunks.push(chunk.value);
      }
      const value = BrowserGrantSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (this.accountId !== null && value.account_id !== this.accountId) throw new BrowserTaskError("permission_revoked");
      return value;
    } finally { await reader.cancel().catch(() => {}); }
  }
}
