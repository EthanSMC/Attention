import { expect, it, vi } from "vitest";
import { SerialBackgroundWork } from "./serial-background-work";

it("does not serialize receiving behind a held turn, but never runs two Agent jobs", async () => {
  const work = new SerialBackgroundWork(); let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const first = vi.fn(async () => held), second = vi.fn(async () => {});
  work.kick(first); await work.settleWithin(5); work.kick(second);
  expect(first).toHaveBeenCalledTimes(1); expect(second).not.toHaveBeenCalled(); expect(work.running).toBe(true);
  release(); await work.settleWithin(20); work.kick(second); await work.drain();
  expect(second).toHaveBeenCalledTimes(1); expect(work.running).toBe(false);
});
it("observes job failures without unhandled rejections and stops starting work after drain", async () => {
  const work = new SerialBackgroundWork(); work.kick(async () => { throw new Error("job_failed"); });
  await expect(work.settleWithin()).rejects.toThrow("job_failed");
  await expect(work.drain()).rejects.toThrow("job_failed");
  const idle = new SerialBackgroundWork(); await idle.drain(); const next = vi.fn(); idle.kick(next); expect(next).not.toHaveBeenCalled();
});
