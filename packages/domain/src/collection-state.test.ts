import { describe, expect, it } from "vitest";

import {
  createCollectionState,
  deleteCollection,
  isEffectivelyPublic,
  restoreDeletedCollection,
  setCollectionModeration,
  setCollectionVisibility
} from "./collection-state";

const now = new Date("2026-07-31T08:00:00.000Z");
const filter = { filterActive: true, memberActive: true };
const member = { filterActive: false, memberActive: true };
const safeContent = {
  communityModerationStatus: "clear" as const,
  contentStatus: "active" as const,
  publicSafetyStatus: "allowed" as const,
  takedownStatus: "none" as const
};

describe("collection state", () => {
  it("defaults a filter collection to public", () => {
    const state = createCollectionState(filter, now);
    expect(state.visibility).toBe("public");
    expect(isEffectivelyPublic(state, filter, safeContent)).toBe(true);
  });

  it("forces a regular member collection to private", () => {
    const state = createCollectionState(member, now, "public");
    expect(state.visibility).toBe("private");
    expect(isEffectivelyPublic(state, member, safeContent)).toBe(false);
  });

  it("does not change an active private collection on resubmission", () => {
    const original = createCollectionState(filter, now, "private");
    expect(restoreDeletedCollection(original, filter, new Date(), "public")).toBe(original);
  });

  it("restores a deleted collection as a new cycle", () => {
    const deleted = deleteCollection(createCollectionState(filter, now, "private"));
    const restoredAt = new Date("2026-07-31T09:00:00.000Z");
    const restored = restoreDeletedCollection(deleted, filter, restoredAt);

    expect(restored.collectionStatus).toBe("active");
    expect(restored.visibility).toBe("public");
    expect(restored.collectedAt).toEqual(restoredAt);
    expect(restored.publicSince).toEqual(restoredAt);
  });

  it("never lets visibility changes clear a moderation block", () => {
    const blocked = setCollectionModeration(createCollectionState(filter, now), "blocked");
    const republished = setCollectionVisibility(blocked, filter, "public", new Date());

    expect(republished.moderationStatus).toBe("blocked");
    expect(isEffectivelyPublic(republished, filter, safeContent)).toBe(false);
  });

  it("keeps pending-review and hidden content off public surfaces", () => {
    const collection = createCollectionState(filter, now, "public");
    expect(
      isEffectivelyPublic(collection, filter, {
        ...safeContent,
        communityModerationStatus: "pending_review",
      }),
    ).toBe(false);
    expect(
      isEffectivelyPublic(collection, filter, {
        ...safeContent,
        communityModerationStatus: "hidden",
      }),
    ).toBe(false);
  });

  it("requires safe active content for public eligibility", () => {
    const state = createCollectionState(filter, now);
    expect(
      isEffectivelyPublic(state, filter, {
        ...safeContent,
        publicSafetyStatus: "blocked"
      })
    ).toBe(false);
  });
});
