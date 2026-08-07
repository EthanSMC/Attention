const SECRET_KEY_PATTERN =
  /((?:access|refresh|id)?_?token|authorization|api[_-]?key|client[_-]?secret|password)\s*([:=])\s*(["']?)([^\s,"'}]+)/gi;
const BEARER_PATTERN = /\bBearer\s+\S+/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const COMMON_KEY_PATTERN = /\b(?:sk|re)_[A-Za-z0-9_-]{16,}\b/g;
const URL_SECRET_PATTERN =
  /([?&](?:access_token|refresh_token|token|code|client_secret)=)[^&#\s]+/gi;

export function redactSecrets(value: string): string {
  return value
    .replace(BEARER_PATTERN, "Bearer [REDACTED]")
    .replace(JWT_PATTERN, "[REDACTED_JWT]")
    .replace(COMMON_KEY_PATTERN, "[REDACTED_KEY]")
    .replace(URL_SECRET_PATTERN, "$1[REDACTED]")
    .replace(SECRET_KEY_PATTERN, "$1$2$3[REDACTED]");
}

export function boundedDiagnosticOutput(
  value: string,
  maximumCharacters = 4_000,
): string {
  const redacted = redactSecrets(value).trim();
  if (redacted.length <= maximumCharacters) return redacted;
  return `${redacted.slice(0, maximumCharacters)}\n… output truncated`;
}
