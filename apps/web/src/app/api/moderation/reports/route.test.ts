import { ModerationRepositoryError } from "@attention/db";
import { describe, expect, it } from "vitest";

import { moderationRepositoryErrorResponse } from "./route";

describe("moderation report errors", () => {
  it("returns a stable 429 response with Retry-After for the Filter case-opening limit", async () => {
    const response = moderationRepositoryErrorResponse(
      new ModerationRepositoryError("report_rate_limited", {
        retryAfterSeconds: 321,
      }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("321");
    await expect(response.json()).resolves.toEqual({
      error: { code: "report_rate_limited" },
    });
  });
});
