const MIN_DIGEST_WINDOW_MINUTES = 15;
const MAX_DIGEST_WINDOW_MINUTES = 240;
const MINUTES_PER_DAY = 24 * 60;

export function latestDigestWindowStart(windowMinutes: number): string {
  if (
    !Number.isInteger(windowMinutes) ||
    windowMinutes < MIN_DIGEST_WINDOW_MINUTES ||
    windowMinutes > MAX_DIGEST_WINDOW_MINUTES
  ) {
    throw new RangeError("invalid_digest_window_minutes");
  }
  const latestStartMinute = MINUTES_PER_DAY - windowMinutes;
  const hour = Math.floor(latestStartMinute / 60).toString().padStart(2, "0");
  const minute = (latestStartMinute % 60).toString().padStart(2, "0");
  return `${hour}:${minute}`;
}
