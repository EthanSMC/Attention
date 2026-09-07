import { isReaderFailureCode, type ReadFailureCode } from "@attention/content-reader-contracts";

const SAFE_ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,99}$/u;

export interface SafeJobFailure {
  code: string;
  readerFailure: boolean;
  retryAfterMs: number | null;
  retryable: boolean;
}

export class JobExecutionError extends Error {
  readonly code: string;
  readonly readerFailure: boolean;
  readonly retryAfterMs: number | null;
  readonly retryable: boolean;

  constructor(code: string, options: { retryAfterMs?: number | null; retryable: boolean }) {
    const safeCode = isSafeErrorCode(code) ? code : "internal_error";
    super(safeCode);
    this.name = "JobExecutionError";
    this.code = safeCode;
    this.readerFailure = isReaderFailureCode(safeCode);
    this.retryAfterMs = boundedRetryAfter(options.retryAfterMs);
    this.retryable = options.retryable;
  }
}

export class LostLeaseError extends Error {
  constructor() {
    super("lease_lost");
    this.name = "LostLeaseError";
  }
}

export function isSafeErrorCode(value: string): boolean {
  return SAFE_ERROR_CODE_PATTERN.test(value);
}

function boundedRetryAfter(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0
    ? Math.min(value, 900_000)
    : null;
}

export function isReaderJobFailureCode(value: string): value is ReadFailureCode {
  return isReaderFailureCode(value);
}

export function preservesContentStateOnFailure(value: string): boolean {
  return value === "lease_expired" || isReaderJobFailureCode(value) ||
    [
      "summary_handler_not_configured",
      "ai_invalid_response", "ai_request_aborted", "ai_provider_unavailable",
      "ai_provider_unauthorized", "ai_provider_rejected", "ai_provider_failed",
    ].includes(value);
}

/** Never derive persisted/logged data from an arbitrary Error message. */
export function toSafeJobFailure(error: unknown): SafeJobFailure {
  if (error instanceof JobExecutionError) {
    return {
      code: error.code,
      readerFailure: error.readerFailure,
      retryAfterMs: error.retryAfterMs,
      retryable: error.retryable,
    };
  }

  return {
    code: "internal_error",
    readerFailure: false,
    retryAfterMs: null,
    retryable: true,
  };
}
