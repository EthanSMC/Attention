import {
  findDangerousQueryParameters,
  findDangerousUrlParameters,
  hasDangerousQueryParameters
} from "@attention/collector";
import { describe, expect, it } from "vitest";

describe("dangerous query detection", () => {
  it("detects access tokens, credentials and temporary signatures", () => {
    const findings = findDangerousQueryParameters(
      "https://example.com/file?access_token=access-value-987&X-Amz-Signature=signed-value-654&client_secret=client-value-321"
    );

    expect(findings).toEqual([
      { parameter: "access_token", reason: "access_token" },
      { parameter: "x-amz-signature", reason: "temporary_signature" },
      { parameter: "client_secret", reason: "account_credential" }
    ]);
    for (const finding of findings) {
      expect(finding).not.toHaveProperty("value");
    }
    expect(JSON.stringify(findings)).not.toContain("access-value-987");
    expect(JSON.stringify(findings)).not.toContain("signed-value-654");
    expect(JSON.stringify(findings)).not.toContain("client-value-321");
  });

  it("marks platform token-shaped parameters for adapter policy review", () => {
    expect(
      hasDangerousQueryParameters(
        "https://www.xiaohongshu.com/explore/abcdef12?xsec_token=fixture"
      )
    ).toBe(true);
  });

  it("does not treat ordinary tracking and article identity as credentials", () => {
    expect(
      findDangerousQueryParameters(
        "https://mp.weixin.qq.com/s?__biz=x&mid=1&idx=1&sn=public&utm_source=share"
      )
    ).toEqual([]);
  });

  it("does not report empty secret-looking values", () => {
    expect(
      findDangerousQueryParameters("https://example.com/?token=&signature=")
    ).toEqual([]);
  });

  it.each([
    "https://example.com/callback#access_token=fragment-secret",
    "https://example.com/callback#/done?id_token=fragment-secret",
    "https://example.com/callback#%61ccess_token%3Dfragment-secret"
  ])("detects credential-shaped fragment parameters in %s", (url) => {
    expect(findDangerousQueryParameters(url)).toEqual([]);
    expect(findDangerousUrlParameters(url)).toContainEqual({
      location: "fragment",
      parameter: expect.stringMatching(/^(?:access_token|id_token)$/u),
      reason: "access_token"
    });
  });

  it("reports whether a credential came from query or fragment", () => {
    expect(
      findDangerousUrlParameters(
        "https://example.com/?client_secret=query-secret#share_token=fragment-secret"
      )
    ).toEqual([
      {
        location: "query",
        parameter: "client_secret",
        reason: "account_credential"
      },
      {
        location: "fragment",
        parameter: "share_token",
        reason: "private_share_key"
      }
    ]);
  });
});
