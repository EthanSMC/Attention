export const ENRICHMENT_QUEUE = "content-enrichment";
export const METADATA_TASK_TYPE = "content.metadata.v1";
export const SUMMARY_TASK_TYPE = "content.summary.v1";

export const SUPPORTED_TASK_TYPES = [METADATA_TASK_TYPE, SUMMARY_TASK_TYPE] as const;

export type SupportedTaskType = (typeof SUPPORTED_TASK_TYPES)[number];

export interface ContentJobPayload {
  contentId: string;
}

export interface MetadataResult {
  title: string | null;
  author: string | null;
  publishedAt: Date | null;
  cachedFaviconAssetKey: string | null;
}

export interface SummaryResult {
  summary: string | null;
  status: "ready" | "unavailable";
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function isSupportedTaskType(value: string): value is SupportedTaskType {
  return (SUPPORTED_TASK_TYPES as readonly string[]).includes(value);
}

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * Job payloads intentionally contain only a database identifier. Rejecting
 * extra keys keeps source URLs and their query values out of the queue table.
 */
export function parseContentJobPayload(value: unknown): ContentJobPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid_job_payload");
  }

  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 1 ||
    typeof record.contentId !== "string" ||
    !isUuid(record.contentId)
  ) {
    throw new Error("invalid_job_payload");
  }

  return { contentId: record.contentId };
}
