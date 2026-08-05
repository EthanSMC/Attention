import type { SessionPrincipal } from "@attention/auth";

const defaultPreviewLimit = 20;
const maximumPreviewLimit = 200;

export function publicFeedPreviewLimit(): number {
  const configured = Number.parseInt(
    process.env.PUBLIC_FEED_PREVIEW_LIMIT ?? String(defaultPreviewLimit),
    10,
  );
  if (!Number.isFinite(configured) || configured < 1) return defaultPreviewLimit;
  return Math.min(configured, maximumPreviewLimit);
}

export function hasCompletePublicAccess(
  principal: Pick<SessionPrincipal, "isMember"> | null,
): boolean {
  return principal?.isMember === true;
}
