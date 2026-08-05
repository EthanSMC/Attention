import { classifySourceUrl } from "./adapters/registry";
import { canonicalHostname, parseHttpUrl, type UrlInput } from "./url";

const APP_DOWNLOAD_HOSTS = new Set([
  "apps.apple.com",
  "itunes.apple.com",
  "play.google.com"
]);

/** A small, explicit filter. It intentionally never uses substring matching. */
export function isKnownNonContentCandidate(input: UrlInput): boolean {
  const url = parseHttpUrl(input);
  if (url === null) {
    return true;
  }

  if (APP_DOWNLOAD_HOSTS.has(canonicalHostname(url.hostname))) {
    return true;
  }

  const match = classifySourceUrl(url);
  return (
    match?.classification.kind === "download" ||
    match?.classification.kind === "marketing"
  );
}
