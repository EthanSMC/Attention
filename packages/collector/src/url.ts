export type UrlInput = string | URL;

const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

function hasUnsafeUrlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      character === "\\" ||
      codePoint === undefined ||
      codePoint <= 0x1f ||
      codePoint === 0x7f
    ) {
      return true;
    }
  }
  return false;
}

export function canonicalHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/u, "");
}

/**
 * Parse with the same URL implementation used by every collector adapter.
 * Credentials and parser-differential characters are rejected before an
 * adapter sees the URL.
 */
export function parseHttpUrl(input: UrlInput): URL | null {
  const serialized = typeof input === "string" ? input : input.href;

  if (
    serialized.length === 0 ||
    serialized.length > 4_096 ||
    hasUnsafeUrlCharacters(serialized)
  ) {
    return null;
  }

  try {
    const url = new URL(serialized);

    if (
      !HTTP_PROTOCOLS.has(url.protocol) ||
      url.hostname.length === 0 ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      return null;
    }

    const hostname = canonicalHostname(url.hostname);
    if (hostname.length === 0) {
      return null;
    }

    url.hostname = hostname;
    if (
      (url.protocol === "http:" && url.port === "80") ||
      (url.protocol === "https:" && url.port === "443")
    ) {
      url.port = "";
    }

    return url;
  } catch {
    return null;
  }
}

export function hostnameIs(url: URL, allowedHostname: string): boolean {
  return canonicalHostname(url.hostname) === canonicalHostname(allowedHostname);
}

export function hostnameIsOneOf(
  url: URL,
  allowedHostnames: ReadonlySet<string>
): boolean {
  return allowedHostnames.has(canonicalHostname(url.hostname));
}

/**
 * Generic normalization deliberately under-deduplicates. Query ordering,
 * unknown parameters, path case, percent encoding and fragments are retained.
 */
export function normalizeGenericUrl(input: UrlInput): string | null {
  const url = parseHttpUrl(input);
  return url?.href ?? null;
}
