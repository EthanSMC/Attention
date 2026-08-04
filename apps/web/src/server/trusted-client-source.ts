import "server-only";

const headerNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const sourcePattern = /^[\x20-\x7E]{1,255}$/u;
const disallowedHeaderNames = new Set([
  "authorization",
  "cf-connecting-ip",
  "cookie",
  "fastly-client-ip",
  "forwarded",
  "true-client-ip",
  "x-forwarded-for",
  "x-real-ip",
]);

export class TrustedClientSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrustedClientSourceError";
  }
}

function configuredHeaderName(environment: NodeJS.ProcessEnv): string | null {
  const value = environment.ATTENTION_TRUSTED_CLIENT_SOURCE_HEADER?.trim().toLowerCase();
  if (!value) return null;
  if (!headerNamePattern.test(value) || disallowedHeaderNames.has(value)) {
    throw new TrustedClientSourceError(
      "ATTENTION_TRUSTED_CLIENT_SOURCE_HEADER must be a safe dedicated header name",
    );
  }
  return value;
}

/**
 * Returns an ingress-authenticated network source, never a client-controlled
 * forwarding header. Production ingress must strip the configured header from
 * the incoming request and overwrite it with its own remote-address value.
 */
export function trustedClientSource(
  request: Request,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const headerName = configuredHeaderName(environment);
  if (!headerName) {
    if (environment.NODE_ENV === "production") {
      throw new TrustedClientSourceError(
        "ATTENTION_TRUSTED_CLIENT_SOURCE_HEADER is required in production",
      );
    }
    return "local-development";
  }

  const source = request.headers.get(headerName)?.trim() ?? "";
  if (!sourcePattern.test(source)) {
    throw new TrustedClientSourceError("Trusted client source header is missing or invalid");
  }
  return source;
}
