import {
  identifyGenericWeb,
  identifyXiaohongshu,
} from "@attention/collector";
import { describe, expect, it } from "vitest";

import { selectCandidateOutboundUrl } from "./collection-service";

describe("collection candidate outbound URL", () => {
  it("keeps Xiaohongshu access parameters while identity remains query-free", () => {
    const observedUrl =
      "https://www.xiaohongshu.com/discovery/item/64abcdef1234" +
      "?app_platform=ios&shareRedId=tracking" +
      "&xsec_source=app_share&xsec_token=public-access-token#tracking";
    const identity = identifyXiaohongshu(observedUrl);

    expect(identity).not.toBeNull();
    expect(identity?.normalizedUrl).toBe(
      "https://www.xiaohongshu.com/explore/64abcdef1234",
    );
    expect(selectCandidateOutboundUrl(identity!, observedUrl)).toBe(
      "https://www.xiaohongshu.com/explore/64abcdef1234" +
        "?xsec_source=app_share&xsec_token=public-access-token",
    );
  });

  it("uses normalized identity for non-Xiaohongshu sources", () => {
    const observedUrl = "https://Example.com/article?utm_source=share";
    const identity = identifyGenericWeb(observedUrl);

    expect(identity).not.toBeNull();
    expect(selectCandidateOutboundUrl(identity!, observedUrl)).toBe(
      identity?.normalizedUrl,
    );
  });
});
