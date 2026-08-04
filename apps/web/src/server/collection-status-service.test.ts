import { describe, expect, it } from "vitest";

import {
  collectionStatusRequestSchema,
  CollectionStatusServiceError,
  updateCollectionVisibilityRequestSchema,
} from "./collection-status-service";

const firstId = "00000000-0000-4000-8000-000000000001";
const secondId = "00000000-0000-4000-8000-000000000002";

describe("collection status service contract", () => {
  it("requires exactly one owner-scoped status reference", () => {
    expect(
      collectionStatusRequestSchema.parse({ attempt_id: firstId }),
    ).toEqual({ attempt_id: firstId });
    expect(
      collectionStatusRequestSchema.parse({ collection_id: secondId }),
    ).toEqual({ collection_id: secondId });
    expect(collectionStatusRequestSchema.safeParse({}).success).toBe(false);
    expect(
      collectionStatusRequestSchema.safeParse({
        attempt_id: firstId,
        collection_id: secondId,
      }).success,
    ).toBe(false);
  });

  it("keeps visibility updates strict and exposes stable service errors", () => {
    expect(
      updateCollectionVisibilityRequestSchema.parse({
        collection_id: firstId,
        visibility: "private",
      }),
    ).toEqual({ collection_id: firstId, visibility: "private" });
    expect(
      updateCollectionVisibilityRequestSchema.safeParse({
        collection_id: firstId,
        visibility: "public",
        account_id: secondId,
      }).success,
    ).toBe(false);

    const error = new CollectionStatusServiceError("filter_required", 403);
    expect(error).toMatchObject({
      code: "filter_required",
      httpStatus: 403,
      message: "filter_required",
      name: "CollectionStatusServiceError",
    });
  });
});
