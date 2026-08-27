/**
 * Local iLink credential persistence.
 *
 * Stores iLink tokens on the device. Never uploads credentials.
 * Uses DSH's configuration store when available.
 */

import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export interface ChannelState {
  readonly token: {
    readonly accessToken: string;
    readonly refreshToken: string;
    readonly expiresAt: number;
  } | null;
  readonly sessionFingerprint: string | null;
  readonly updatedAt: string;
}

const STATE_FILENAME = "attention-channel-state.json";

function stateDirectory(): string {
  const home = homedir();
  return join(home, ".attention", "channel");
}

function statePath(): string {
  return join(stateDirectory(), STATE_FILENAME);
}

export async function loadChannelState(): Promise<ChannelState> {
  try {
    const raw = await readFile(statePath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const record = parsed as Record<string, unknown>;
    return {
      token: record.token
        ? {
            accessToken: String(
              (record.token as Record<string, unknown>).accessToken ?? "",
            ),
            refreshToken: String(
              (record.token as Record<string, unknown>).refreshToken ?? "",
            ),
            expiresAt: Number(
              (record.token as Record<string, unknown>).expiresAt ?? 0,
            ),
          }
        : null,
      sessionFingerprint:
        typeof record.sessionFingerprint === "string"
          ? record.sessionFingerprint
          : null,
      updatedAt:
        typeof record.updatedAt === "string"
          ? record.updatedAt
          : new Date(0).toISOString(),
    };
  } catch {
    return {
      token: null,
      sessionFingerprint: null,
      updatedAt: new Date(0).toISOString(),
    };
  }
}

export async function saveChannelState(
  state: ChannelState,
): Promise<void> {
  const dir = stateDirectory();
  await mkdir(dir, { mode: 0o700, recursive: true });
  const tmp = statePath() + ".tmp-" + crypto.randomUUID();
  try {
    await writeFile(tmp, JSON.stringify(state, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    await writeFile(statePath(), JSON.stringify(state, null, 2), {
      mode: 0o600,
    });
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

export async function clearChannelState(): Promise<void> {
  try {
    await rm(statePath(), { force: true });
  } catch {
    // Already gone.
  }
}
