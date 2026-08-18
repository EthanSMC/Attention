export interface EnrichmentDecisionContent {
  aiSummary: string | null;
  communityModerationStatus: "clear" | "hidden" | "pending_review";
  contentStatus: "active" | "merged";
  publicSafetyStatus: "allowed" | "blocked";
  summaryStatus: "failed" | "hidden" | "pending" | "ready" | "unavailable";
  takedownStatus: "none" | "removed";
}

export interface EnrichmentResponseFields {
  enrichment_action: "reuse_summary" | "generate_summary" | "none";
  public_read_url: string | null;
  summary_status: "ready" | "pending" | "unavailable" | "hidden";
}

export function enrichmentResponseFields(
  content: EnrichmentDecisionContent,
  publicReadUrl: string,
): EnrichmentResponseFields {
  const ineligible =
    content.contentStatus !== "active" ||
    content.publicSafetyStatus !== "allowed" ||
    content.takedownStatus !== "none" ||
    content.communityModerationStatus !== "clear";
  if (content.summaryStatus === "hidden" || ineligible) {
    return {
      enrichment_action: "none",
      public_read_url: null,
      summary_status: "hidden",
    };
  }
  if (content.summaryStatus === "ready") {
    return {
      enrichment_action: "reuse_summary",
      public_read_url: null,
      summary_status: "ready",
    };
  }
  if (
    content.summaryStatus === "unavailable" ||
    content.summaryStatus === "failed"
  ) {
    return {
      enrichment_action: "none",
      public_read_url: null,
      summary_status: "unavailable",
    };
  }
  const enrichmentAction =
    content.aiSummary === null || content.aiSummary.trim() === ""
      ? "generate_summary"
      : "none";
  return {
    enrichment_action: enrichmentAction,
    public_read_url:
      enrichmentAction === "generate_summary" ? publicReadUrl : null,
    summary_status: content.summaryStatus,
  };
}
