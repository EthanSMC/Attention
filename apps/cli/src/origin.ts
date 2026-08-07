export const ATTENTION_ORIGIN_ENV = "ATTENTION_ORIGIN" as const;

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

export function normalizeAttentionOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      `Invalid Attention origin: ${value}. Use an absolute HTTPS origin, for example https://attention.example.com.`,
    );
  }

  if (parsed.username || parsed.password) {
    throw new Error("Attention origin must not contain credentials.");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("Attention origin must not contain a query or fragment.");
  }
  if (parsed.pathname !== "/") {
    throw new Error(
      "Attention origin must not contain a path. Pass only the scheme, hostname, and optional port.",
    );
  }
  if (parsed.protocol !== "https:" && !isLoopbackHostname(parsed.hostname)) {
    throw new Error(
      "Attention origin must use HTTPS. Plain HTTP is accepted only for a loopback development server.",
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Attention origin must use HTTP or HTTPS.");
  }

  return parsed.origin;
}

export function requireAttentionOrigin(
  optionValue: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const value = optionValue ?? environment[ATTENTION_ORIGIN_ENV];
  if (!value) {
    throw new Error(
      `Missing Attention origin. Pass --origin <https-origin> or set ${ATTENTION_ORIGIN_ENV}.`,
    );
  }
  return normalizeAttentionOrigin(value);
}

export function resolveAttentionPublicUrl(
  origin: string,
  pathOrTemplate: string,
): string {
  const replaced = pathOrTemplate.replaceAll("{attention_origin}", origin);
  return new URL(replaced, `${origin}/`).toString();
}
