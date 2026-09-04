export const BRIDGE_UPDATE_INTERVAL_MS = 60 * 60 * 1_000;

export function initialBridgeUpdateCheckAt(): number {
  return 0;
}

export function nextBridgeUpdateCheckAt(checkedAt: number): number {
  return checkedAt + BRIDGE_UPDATE_INTERVAL_MS;
}
