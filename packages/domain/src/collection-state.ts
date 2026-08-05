export type CollectionStatus = "active" | "deleted";
export type ModerationStatus = "blocked" | "clear";
export type Visibility = "private" | "public";

export interface ActorCapabilities {
  filterActive: boolean;
  memberActive: boolean;
}

export interface CollectionState {
  collectedAt: Date;
  collectionStatus: CollectionStatus;
  filterRevokedAt: Date | null;
  moderationStatus: ModerationStatus;
  publicSince: Date | null;
  visibility: Visibility;
}

export interface ContentPublicationState {
  communityModerationStatus: "clear" | "hidden" | "pending_review";
  contentStatus: "active" | "merged";
  publicSafetyStatus: "allowed" | "blocked";
  takedownStatus: "none" | "removed";
}

export class DomainPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainPermissionError";
  }
}

export function createCollectionState(
  actor: ActorCapabilities,
  now: Date,
  requestedVisibility?: Visibility
): CollectionState {
  if (!actor.memberActive && !actor.filterActive) {
    throw new DomainPermissionError("An active member capability is required");
  }

  const visibility: Visibility = actor.filterActive
    ? (requestedVisibility ?? "public")
    : "private";

  return {
    collectedAt: now,
    collectionStatus: "active",
    filterRevokedAt: null,
    moderationStatus: "clear",
    publicSince: visibility === "public" ? now : null,
    visibility
  };
}

export function isEffectivelyPublic(
  collection: CollectionState,
  actor: ActorCapabilities,
  content: ContentPublicationState
): boolean {
  return (
    collection.collectionStatus === "active" &&
    collection.visibility === "public" &&
    collection.filterRevokedAt === null &&
    collection.moderationStatus === "clear" &&
    actor.filterActive &&
    content.communityModerationStatus === "clear" &&
    content.contentStatus === "active" &&
    content.publicSafetyStatus === "allowed" &&
    content.takedownStatus === "none"
  );
}

export function setCollectionVisibility(
  state: CollectionState,
  actor: ActorCapabilities,
  visibility: Visibility,
  now: Date
): CollectionState {
  if (state.collectionStatus !== "active") {
    throw new DomainPermissionError("A deleted collection must be restored first");
  }
  if (visibility === "public" && !actor.filterActive) {
    throw new DomainPermissionError("Only an active filter can publish a collection");
  }

  if (visibility === state.visibility && state.filterRevokedAt === null) {
    return state;
  }

  return {
    ...state,
    filterRevokedAt: visibility === "public" ? null : state.filterRevokedAt,
    publicSince: visibility === "public" ? now : null,
    visibility
  };
}

export function revokeFilterPublication(state: CollectionState, now: Date): CollectionState {
  if (state.collectionStatus !== "active" || state.visibility !== "public") {
    return state;
  }
  return { ...state, filterRevokedAt: now };
}

export function setCollectionModeration(
  state: CollectionState,
  moderationStatus: ModerationStatus
): CollectionState {
  return { ...state, moderationStatus };
}

export function deleteCollection(state: CollectionState): CollectionState {
  if (state.collectionStatus === "deleted") return state;
  return { ...state, collectionStatus: "deleted", publicSince: null };
}

export function restoreDeletedCollection(
  state: CollectionState,
  actor: ActorCapabilities,
  now: Date,
  requestedVisibility?: Visibility
): CollectionState {
  if (state.collectionStatus !== "deleted") {
    return state;
  }
  if (!actor.memberActive && !actor.filterActive) {
    throw new DomainPermissionError("An active member capability is required");
  }

  const visibility: Visibility = actor.filterActive
    ? (requestedVisibility ?? "public")
    : "private";

  return {
    ...state,
    collectedAt: now,
    collectionStatus: "active",
    filterRevokedAt: actor.filterActive ? null : state.filterRevokedAt,
    publicSince: visibility === "public" ? now : null,
    visibility
  };
}
