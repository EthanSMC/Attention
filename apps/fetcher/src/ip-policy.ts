import { isIP } from "node:net";

import ipaddr from "ipaddr.js";

const DENIED_RANGES = new Set([
  "unspecified",
  "broadcast",
  "multicast",
  "linkLocal",
  "loopback",
  "private",
  "reserved",
  "carrierGradeNat",
  "uniqueLocal",
  "ipv4Mapped",
  "rfc6145",
  "rfc6052",
  "6to4",
  "teredo",
  "benchmarking",
  "amt"
]);

function stripZone(address: string): string {
  const zoneIndex = address.indexOf("%");
  return zoneIndex === -1 ? address : address.slice(0, zoneIndex);
}

export function isPublicAddress(address: string): boolean {
  const normalized = stripZone(address);
  if (isIP(normalized) === 0 || !ipaddr.isValid(normalized)) {
    return false;
  }

  const parsed = ipaddr.parse(normalized);
  if (parsed.kind() === "ipv6") {
    const ipv6 = parsed as ipaddr.IPv6;
    if (ipv6.isIPv4MappedAddress()) {
      return isPublicAddress(ipv6.toIPv4Address().toString());
    }
  }

  return !DENIED_RANGES.has(parsed.range());
}

export function isUnsafeHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".home") ||
    normalized.endsWith(".lan")
  );
}
