import { describe, expect, it } from "vitest";

import { decryptCandidateSet, encryptCandidateSet } from "./candidate-vault";

process.env.ATTENTION_HMAC_SECRET ??=
  "attention-candidate-vault-test-secret-at-least-32-characters";

const payload = {
  candidates: [
    {
      candidateId: "00000000-0000-4000-8000-000000000001",
      contentType: "web_page" as const,
      dedupeKey: "generic_web:https://example.org/one",
      displayHost: "example.org",
      source: "generic_web" as const,
      url: "https://example.org/one?ref=observed"
    },
    {
      candidateId: "00000000-0000-4000-8000-000000000002",
      contentType: "note" as const,
      dedupeKey: "xiaohongshu:note:abc123",
      displayHost: "www.xiaohongshu.com",
      source: "xiaohongshu" as const,
      url: "https://www.xiaohongshu.com/explore/abc123?xsec_source=pc_share"
    }
  ],
  selectionToken: "selection-token-fixture-with-at-least-32-characters",
  version: 2 as const,
  visibility: "public" as const
};

describe("candidate vault", () => {
  it("round-trips the candidate identity and original selection token", () => {
    const encrypted = encryptCandidateSet(payload);

    expect(encrypted).not.toContain(payload.selectionToken);
    expect(decryptCandidateSet(encrypted)).toEqual(payload);
  });

  it("rejects authenticated payload tampering", () => {
    const encrypted = encryptCandidateSet(payload);
    const [iv, tag, ciphertext] = encrypted.split(".");
    if (!iv || !tag || !ciphertext) throw new Error("Expected encrypted payload parts");
    const replacement = ciphertext[0] === "A" ? "B" : "A";
    const tampered = `${iv}.${tag}.${replacement}${ciphertext.slice(1)}`;

    expect(() => decryptCandidateSet(tampered)).toThrow();
  });
});
