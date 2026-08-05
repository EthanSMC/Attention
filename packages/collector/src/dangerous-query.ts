import { parseHttpUrl, type UrlInput } from "./url";

export type DangerousQueryReason =
  | "access_token"
  | "account_credential"
  | "private_share_key"
  | "temporary_signature";

export interface DangerousQueryFinding {
  /** Parameter names are safe to audit; values are intentionally omitted. */
  readonly parameter: string;
  readonly reason: DangerousQueryReason;
}

export interface DangerousUrlParameterFinding extends DangerousQueryFinding {
  readonly location: "fragment" | "query";
}

const EXACT_PARAMETER_REASONS = new Map<string, DangerousQueryReason>([
  ["access_token", "access_token"],
  ["auth_token", "access_token"],
  ["id_token", "access_token"],
  ["refresh_token", "access_token"],
  ["token", "access_token"],
  ["xsec_token", "access_token"],
  ["api_key", "account_credential"],
  ["apikey", "account_credential"],
  ["authorization", "account_credential"],
  ["client_secret", "account_credential"],
  ["credential", "account_credential"],
  ["password", "account_credential"],
  ["passwd", "account_credential"],
  ["private_key", "account_credential"],
  ["private_token", "account_credential"],
  ["pwd", "account_credential"],
  ["passcode", "account_credential"],
  ["secret_key", "account_credential"],
  ["access_key", "account_credential"],
  ["session", "account_credential"],
  ["session_id", "account_credential"],
  ["sessionid", "account_credential"],
  ["share_key", "private_share_key"],
  ["share_token", "private_share_key"],
  ["private_share_key", "private_share_key"],
  ["signature", "temporary_signature"],
  ["sig", "temporary_signature"],
  ["x-amz-signature", "temporary_signature"],
  ["x-amz-credential", "account_credential"],
  ["x-amz-security-token", "access_token"],
  ["x-goog-signature", "temporary_signature"],
  ["x-goog-credential", "account_credential"],
  ["awsaccesskeyid", "account_credential"]
]);

const SECRET_NAME_PATTERN =
  /(?:^|[_-])(?:access[_-]?token|auth[_-]?token|token|auth|authorization|credential|password|passwd|secret|private[_-]?key|share[_-]?key|share[_-]?token|session[_-]?id|signature|signed|sig|api[_-]?key|key)(?:$|[_-])/u;

function dangerousReason(parameter: string): DangerousQueryReason | undefined {
  return (
    EXACT_PARAMETER_REASONS.get(parameter) ??
    (SECRET_NAME_PATTERN.test(parameter) ? "account_credential" : undefined)
  );
}

function findingsFromParameters(
  parameters: URLSearchParams,
  location: "fragment" | "query"
): DangerousUrlParameterFinding[] {
  const findings = new Map<string, DangerousUrlParameterFinding>();

  for (const [rawName, value] of parameters) {
    if (value.length === 0) {
      continue;
    }

    const parameter = rawName.trim().toLowerCase();
    const reason = dangerousReason(parameter);
    if (reason !== undefined) {
      findings.set(`${parameter}:${reason}`, { location, parameter, reason });
    }
  }

  return [...findings.values()];
}

function fragmentParameters(url: URL): URLSearchParams[] {
  if (url.hash.length <= 1) {
    return [];
  }

  const raw = url.hash.slice(1);
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // The raw fragment is still safe to inspect when percent decoding fails.
  }

  return [...new Set([raw, decoded])].map((fragment) => {
    const queryStart = fragment.indexOf("?");
    const queryLike = queryStart >= 0 ? fragment.slice(queryStart + 1) : fragment;
    return new URLSearchParams(queryLike.replace(/^[#&?]+/u, ""));
  });
}

export function findDangerousQueryParameters(
  input: UrlInput
): readonly DangerousQueryFinding[] {
  const url = parseHttpUrl(input);
  if (url === null) {
    return [];
  }
  return findingsFromParameters(url.searchParams, "query").map(
    ({ parameter, reason }) => ({ parameter, reason })
  );
}

export function hasDangerousQueryParameters(input: UrlInput): boolean {
  return findDangerousQueryParameters(input).length > 0;
}

/** Inspect both the server-visible query and browser-visible URL fragment. */
export function findDangerousUrlParameters(
  input: UrlInput
): readonly DangerousUrlParameterFinding[] {
  const url = parseHttpUrl(input);
  if (url === null) {
    return [];
  }

  const findings = new Map<string, DangerousUrlParameterFinding>();
  for (const finding of findingsFromParameters(url.searchParams, "query")) {
    findings.set(`${finding.location}:${finding.parameter}:${finding.reason}`, finding);
  }
  for (const parameters of fragmentParameters(url)) {
    for (const finding of findingsFromParameters(parameters, "fragment")) {
      findings.set(`${finding.location}:${finding.parameter}:${finding.reason}`, finding);
    }
  }
  return [...findings.values()];
}

export function hasDangerousUrlParameters(input: UrlInput): boolean {
  return findDangerousUrlParameters(input).length > 0;
}
