import { stat } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BRAIN_HISTORY_TURNS, PROCESSED_MESSAGE_RING_SIZE } from "./limits";
import {
  appendHistory,
  channelStatePath,
  clearChannelState,
  defaultChannelState,
  loadChannelState,
  rememberProcessedMessage,
  saveChannelState,
} from "./state";

describe("channel state persistence", () => {
  const tempDirs: string[] = [];

  const makeTempBase = async (): Promise<string> => {
    const directory = await mkdtemp(join(tmpdir(), "attention-channel-test-"));
    tempDirs.push(directory);
    return directory;
  };

  afterEach(async () => {
    for (const directory of tempDirs.splice(0)) {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("returns defaults when no state file exists", async () => {
    const base = await makeTempBase();
    const state = await loadChannelState(base);
    expect(state).toEqual(defaultChannelState());
  });

  it("round-trips state through disk", async () => {
    const base = await makeTempBase();
    const state = defaultChannelState();
    state.token = "ilink-token";
    state.accountId = "account-1";
    state.syncBuf = "cursor";
    state.contextTokens = { owner: "ctx" };
    state.ownerUserId = "owner";
    state.brainSession = {
      hostId: "claude-code",
      sessionId: "session-1",
      updatedAt: "2026-08-08T00:00:00.000Z",
    };
    state.history = [{ content: "hi", role: "user" }];
    state.processedMessageIds = ["m-1"];
    await saveChannelState(state, base);

    const loaded = await loadChannelState(base);
    expect(loaded).toEqual(state);
  });

  it("writes the state file with restrictive permissions", async () => {
    const base = await makeTempBase();
    await saveChannelState(defaultChannelState(), base);
    const info = await stat(channelStatePath(base));
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("rejects corrupted state files instead of guessing", async () => {
    const base = await makeTempBase();
    const corrupted = defaultChannelState();
    await saveChannelState(corrupted, base);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(channelStatePath(base), "{not-json", "utf8");
    await expect(loadChannelState(base)).rejects.toThrow();
  });

  it("normalizes unknown session hosts away", async () => {
    const base = await makeTempBase();
    const state = defaultChannelState();
    state.brainSession = {
      hostId: "claude-code",
      sessionId: "s",
      updatedAt: "now",
    };
    await saveChannelState(state, base);
    const { readFile, writeFile } = await import("node:fs/promises");
    const raw = JSON.parse(
      await readFile(channelStatePath(base), "utf8"),
    ) as Record<string, unknown>;
    raw.brainSession = { hostId: "other", sessionId: "s" };
    await writeFile(channelStatePath(base), JSON.stringify(raw), "utf8");
    const loaded = await loadChannelState(base);
    expect(loaded.brainSession).toBeNull();
  });

  it("does not reload a persisted non-WeChat base URL", async () => {
    const base = await makeTempBase();
    const state = defaultChannelState();
    state.baseUrl = "https://credential-stealer.example";
    await saveChannelState(state, base);
    expect((await loadChannelState(base)).baseUrl).toBe(
      "https://ilinkai.weixin.qq.com",
    );
  });

  it("clears the state file on logout", async () => {
    const base = await makeTempBase();
    await saveChannelState(defaultChannelState(), base);
    await clearChannelState(base);
    expect(await loadChannelState(base)).toEqual(defaultChannelState());
    // Clearing twice must not throw.
    await clearChannelState(base);
  });

  it("bounds the processed-message ring", () => {
    const state = defaultChannelState();
    for (let index = 0; index < PROCESSED_MESSAGE_RING_SIZE + 50; index += 1) {
      rememberProcessedMessage(state, `m-${index}`);
    }
    expect(state.processedMessageIds).toHaveLength(
      PROCESSED_MESSAGE_RING_SIZE,
    );
    expect(state.processedMessageIds.at(-1)).toBe(
      `m-${PROCESSED_MESSAGE_RING_SIZE + 49}`,
    );
    expect(state.processedMessageIds[0]).toBe("m-50");
  });

  it("bounds the rolling history to the configured turns", () => {
    const state = defaultChannelState();
    for (let index = 0; index < BRAIN_HISTORY_TURNS + 10; index += 1) {
      appendHistory(state, `q${index}`, `a${index}`);
    }
    expect(state.history).toHaveLength(BRAIN_HISTORY_TURNS * 2);
    expect(state.history[0]).toEqual({
      content: "q10",
      role: "user",
    });
  });
});
