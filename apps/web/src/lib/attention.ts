export type Visibility = "public" | "private";

export type EnrichmentStatus = "processing" | "ready" | "unavailable";

export type EffectiveVisibility =
  | "public"
  | "private"
  | "paused"
  | "blocked";

export type SourceTone = "indigo" | "coral" | "mint" | "gold";

export interface ContentPreview {
  id: string;
  title: string;
  source: string;
  host: string;
  sourceInitial: string;
}

export interface PublicFilter {
  attentionId: string | null;
  displayName: string;
  initials: string;
}

export function accountIdentityLabel(input: {
  attentionId: string | null;
  displayName: string;
  primaryEmail: string | null;
}): string {
  const fallback =
    input.displayName.trim() || input.primaryEmail?.trim() || "当前账号";
  return input.attentionId ? `${fallback} (@${input.attentionId})` : fallback;
}

export function publicCollectorLabel(
  filter: Pick<PublicFilter, "attentionId" | "displayName">,
): string {
  return filter.attentionId ? `@${filter.attentionId}` : filter.displayName;
}

export interface PublicContent {
  id: string;
  title: string;
  summary: string | null;
  summaryStatus: EnrichmentStatus;
  source: string;
  sourceInitial: string;
  sourceTone: SourceTone;
  author: string | null;
  publishedAt: string | null;
  firstPublicAt: string;
  tags: string[];
  filters: PublicFilter[];
  outboundHref: string | null;
}

export interface CollectionItem extends PublicContent {
  collectedAt: string;
  visibility: Visibility;
  effectiveVisibility: EffectiveVisibility;
}

export interface CollectInput {
  rawInput: string;
  visibility: Visibility;
  idempotencyKey: string;
}

export interface AcceptedCollectResult {
  status: "accepted" | "merged_with_existing_content";
  visibility: Visibility;
  content: ContentPreview;
}

export interface AlreadyCollectedResult {
  status: "already_collected";
  visibility: Visibility;
  content: ContentPreview;
}

export interface AmbiguousCandidate extends ContentPreview {
  candidateId: string;
}

export interface AmbiguousCollectResult {
  status: "ambiguous";
  selectionToken: string;
  candidates: AmbiguousCandidate[];
}

export interface ResolutionPendingResult {
  status: "resolution_pending";
  host: string;
}

export interface InvalidCollectResult {
  status: "invalid";
  reason: string;
}

export interface UnsafeCollectResult {
  status: "unsafe";
  reason: string;
}

export type CollectResult =
  | AcceptedCollectResult
  | AlreadyCollectedResult
  | AmbiguousCollectResult
  | ResolutionPendingResult
  | InvalidCollectResult
  | UnsafeCollectResult;

export interface CollectAdapter {
  submit(input: CollectInput): Promise<CollectResult>;
  selectCandidate(input: {
    selectionToken: string;
    candidateId: string;
    visibility: Visibility;
  }): Promise<AcceptedCollectResult | AlreadyCollectedResult>;
  updateVisibility(input: {
    collectionId: string;
    visibility: Visibility;
  }): Promise<Visibility>;
}
