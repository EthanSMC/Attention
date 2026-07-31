const DEFAULT_TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

export function createOpaqueToken(bytes = DEFAULT_TOKEN_BYTES): string {
  if (!Number.isInteger(bytes) || bytes < 24 || bytes > 128) {
    throw new RangeError("Token entropy must be between 24 and 128 bytes");
  }
  const entropy = globalThis.crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const value of entropy) {
    binary += String.fromCharCode(value);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function assertOpaqueToken(token: string): void {
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error("Malformed opaque token");
  }
}

export async function hashOpaqueToken(token: string): Promise<string> {
  assertOpaqueToken(token);
  const bytes = new TextEncoder().encode(token);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}
