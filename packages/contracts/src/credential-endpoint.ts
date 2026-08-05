/**
 * Normalize an endpoint that will receive a service credential. Remote
 * clear-text HTTP is rejected; loopback HTTP remains available for local
 * development and contract tests.
 */
export function normalizeCredentialEndpoint(
  rawValue: string,
  name: string,
  options: { allowedInsecureHosts?: readonly string[] } = {},
): string {
  let url: URL;
  try {
    url = new URL(rawValue);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  const loopback = url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]";
  const explicitlyAllowed = options.allowedInsecureHosts?.includes(url.hostname) ?? false;
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && (loopback || explicitlyAllowed)))
  ) {
    throw new Error(
      `${name} must use HTTPS without credentials, query or fragment (HTTP is loopback-only)`,
    );
  }
  return url.toString().replace(/\/+$/u, "");
}
