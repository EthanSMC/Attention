import { describe, expect, it } from "vitest";

import {
  apiKeyManagerReducer,
  createApiKeyManagerState,
} from "./api-key-manager-state";

describe("API Key creation lifecycle", () => {
  it("keeps the plaintext key inside the reveal step and destroys it when the modal closes", () => {
    const initial = createApiKeyManagerState([]);
    const naming = apiKeyManagerReducer(initial, { type: "open" });
    const creating = apiKeyManagerReducer(
      apiKeyManagerReducer(naming, { type: "change_name", value: "Claude on MacBook" }),
      { type: "create_started" },
    );
    const revealed = apiKeyManagerReducer(creating, {
      row: {
        createdAt: "2026-08-06T10:00:00.000Z",
        expiresAt: "2026-11-04T10:00:00.000Z",
        id: "credential-1",
        keyPrefix: "att_pat_example",
        lastUsedAt: null,
        name: "Claude on MacBook",
        needsRotation: false,
        status: "active",
      },
      secret: "att_pat_this-is-the-only-plaintext-copy",
      type: "create_succeeded",
    });

    expect(revealed.modal).toBe("revealed");
    expect(revealed.secret).toBe("att_pat_this-is-the-only-plaintext-copy");
    expect(revealed.rows[0]?.name).toBe("Claude on MacBook");

    const closed = apiKeyManagerReducer(revealed, { type: "close" });

    expect(closed.modal).toBe("closed");
    expect(closed.secret).toBeNull();
    expect(closed.rows).toHaveLength(1);
    expect(closed.rows[0]?.keyPrefix).toBe("att_pat_example");

    const reopened = apiKeyManagerReducer(closed, { type: "open" });
    expect(reopened.modal).toBe("naming");
    expect(reopened.secret).toBeNull();
    expect(reopened.rows[0]?.name).toBe("Claude on MacBook");
  });

  it("keeps the name and does not add a row after a failed request", () => {
    const initial = createApiKeyManagerState([]);
    const naming = apiKeyManagerReducer(
      apiKeyManagerReducer(initial, { type: "open" }),
      { type: "change_name", value: "My local Agent" },
    );
    const failed = apiKeyManagerReducer(
      apiKeyManagerReducer(naming, { type: "create_started" }),
      { message: "API Key 没有创建，请重试。", type: "create_failed" },
    );

    expect(failed.modal).toBe("naming");
    expect(failed.name).toBe("My local Agent");
    expect(failed.rows).toEqual([]);
    expect(failed.error).toBe("API Key 没有创建，请重试。");
  });

  it("marks a network-interrupted creation as uncertain so the UI must refresh before retrying", () => {
    const naming = apiKeyManagerReducer(
      apiKeyManagerReducer(createApiKeyManagerState([]), { type: "open" }),
      { type: "create_started" },
    );
    const uncertain = apiKeyManagerReducer(naming, {
      message: "创建结果无法确认。",
      type: "create_unknown",
    });

    expect(uncertain.busy).toBe(false);
    expect(uncertain.uncertain).toBe(true);
    expect(uncertain.rows).toEqual([]);
  });
});
