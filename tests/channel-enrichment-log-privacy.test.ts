import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const script = new URL(
  "../scripts/check-channel-enrichment-log-privacy.sh",
  import.meta.url,
).pathname;
const roots: string[] = [];

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "attention-channel-privacy-"));
  roots.push(root);
  return root;
}

function run(platform: "linux" | "macos", input: {
  home: string;
  path?: string;
}) {
  return spawnSync("bash", [script, platform], {
    encoding: "utf8",
    env: {
      ...process.env,
      E2E_PAGE_SENTINEL: "private page sentinel",
      E2E_SUMMARY_SENTINEL: "private summary sentinel",
      E2E_TAG_SENTINEL: "private-tag-sentinel",
      E2E_TEST_URL: "https://privacy-test.invalid/private-path",
      HOME: input.home,
      PATH: input.path ?? process.env.PATH,
    },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("channel enrichment log privacy acceptance", () => {
  it("fails closed when expected macOS logs are missing", () => {
    const result = run("macos", { home: temporaryDirectory() });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("cannot read expected macOS channel log");
    expect(result.stdout).not.toContain("ok:");
  });

  it("fails with a final nonzero status when a macOS log leaks content", () => {
    const home = temporaryDirectory();
    const logDirectory = join(home, ".attention/channel");
    mkdirSync(logDirectory, { recursive: true });
    writeFileSync(join(logDirectory, "service.log"), "private-tag-sentinel\n");
    writeFileSync(join(logDirectory, "service-error.log"), "clean\n");

    const result = run("macos", { home });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("leaked enrichment content");
    expect(result.stdout).not.toContain("ok:");
  });

  it("passes only after reading clean macOS logs", () => {
    const home = temporaryDirectory();
    const logDirectory = join(home, ".attention/channel");
    mkdirSync(logDirectory, { recursive: true });
    writeFileSync(join(logDirectory, "service.log"), "bridge started\n");
    writeFileSync(join(logDirectory, "service-error.log"), "no errors\n");

    const result = run("macos", { home });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ok: macOS channel logs contain no enrichment content");
  });

  it("fails closed when journalctl cannot provide Linux evidence", () => {
    const home = temporaryDirectory();
    const bin = join(home, "bin");
    mkdirSync(bin);
    const fakeJournalctl = join(bin, "journalctl");
    writeFileSync(fakeJournalctl, "#!/bin/sh\nexit 3\n");
    chmodSync(fakeJournalctl, 0o700);

    const result = run("linux", { home, path: `${bin}:/usr/bin:/bin` });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("could not read Linux channel journal");
    expect(result.stdout).not.toContain("ok:");
  });
});
