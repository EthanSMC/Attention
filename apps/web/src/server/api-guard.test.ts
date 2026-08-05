import { describe, expect, it } from "vitest";

import { mutationRequestError } from "./api-guard";

function requestWithLength(contentLength: number): Request {
  return new Request("https://attention.example.test/api/account/profile", {
    headers: {
      "content-length": String(contentLength),
      origin: "https://attention.example.test",
      "sec-fetch-site": "same-origin",
    },
    method: "PATCH",
  });
}

describe("mutationRequestError", () => {
  it("keeps the conservative default request limit", () => {
    expect(mutationRequestError(requestWithLength(40_961))).toBe(
      "request_too_large",
    );
  });

  it("allows a route to declare a larger bounded request", () => {
    expect(
      mutationRequestError(requestWithLength(64_456), {
        maxContentLengthBytes: 512 * 1024,
      }),
    ).toBeNull();
  });

  it("enforces the route-specific request limit", () => {
    expect(
      mutationRequestError(requestWithLength(512 * 1024 + 1), {
        maxContentLengthBytes: 512 * 1024,
      }),
    ).toBe("request_too_large");
  });
});
