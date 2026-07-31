export type FetcherErrorCode =
  | "invalid_url"
  | "unsupported_protocol"
  | "unsupported_port"
  | "unsafe_credentials"
  | "unsafe_hostname"
  | "unsafe_address"
  | "dns_failure"
  | "redirect_missing_location"
  | "redirect_limit"
  | "https_downgrade"
  | "unsupported_content_type"
  | "response_too_large"
  | "timeout"
  | "fetch_failed";

export class FetcherError extends Error {
  readonly code: FetcherErrorCode;

  constructor(code: FetcherErrorCode, message: string) {
    super(message);
    this.name = "FetcherError";
    this.code = code;
  }
}
