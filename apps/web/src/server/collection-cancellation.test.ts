import type { AttentionDatabase } from "@attention/db";
import { describe, expect, it, vi } from "vitest";

import { assertCollectionAuthority, collectFromWeb } from "./collection-service";

const accountId = "00000000-0000-4000-8000-000000000001";
const principal = { accountId, isMember: true, isFilter: false };

describe("collection request cancellation and live authority", () => {
  it("does not start an input attempt after the caller has cancelled", async () => {
    const transaction = vi.fn(); const controller = new AbortController(); controller.abort();
    await expect(collectFromWeb({ transaction } as unknown as AttentionDatabase, { ...principal, signal: controller.signal },
      { raw_input: "https://example.com/fixture", visibility: "private", idempotency_key: "cancelled-fixture" })).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });
  it.each([null, { ...principal, accountId: "other", scopes: ["collection:write"] }, { ...principal, scopes: ["collection:read"] }])("does not proceed on revoked or changed authority: %s", async current => {
      await expect(assertCollectionAuthority({ ...principal, revalidate: async () => current }, "private")).rejects.toThrow("permission_revoked");
    });
  it("rechecks cancellation after asynchronous permission resolution", async () => {
    const controller = new AbortController();
    await expect(assertCollectionAuthority({ ...principal, signal: controller.signal, revalidate: async () => {
      controller.abort(); return { ...principal, scopes: ["collection:write"] };
    } }, "private")).rejects.toThrow();
  });
});
