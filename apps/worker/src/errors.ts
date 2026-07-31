const SAFE_ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,99}$/u;

export interface SafeJobFailure {
  code: string;
  retryable: boolean;
}

export class JobExecutionError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, options: { retryable: boolean }) {
    const safeCode = isSafeErrorCode(code) ? code : "internal_error";
    super(safeCode);
    this.name = "JobExecutionError";
    this.code = safeCode;
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

/** Never derive persisted/logged data from an arbitrary Error message. */
export function toSafeJobFailure(error: unknown): SafeJobFailure {
  if (error instanceof JobExecutionError) {
    return { code: error.code, retryable: error.retryable };
  }

  return { code: "internal_error", retryable: true };
}
