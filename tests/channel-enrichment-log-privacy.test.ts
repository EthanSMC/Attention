import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
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
const repositoryRoot = new URL("../", import.meta.url).pathname;
const roots: string[] = [];

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "attention-channel-privacy-"));
  roots.push(root);
  return root;
}

function run(platform: "linux" | "macos", input: {
  env?: Record<string, string>;
  home: string;
  path?: string;
}) {
  return spawnSync("bash", [script, platform], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...input.env,
      E2E_PAGE_SENTINEL: "private page sentinel",
      E2E_SUMMARY_SENTINEL: "private summary sentinel",
      E2E_TAG_SENTINEL: "private-tag-sentinel",
      E2E_TEST_URL: "https://privacy-test.invalid/private-path",
      E2E_TITLE_SENTINEL: "private title sentinel",
      E2E_LOG_SINCE:
        input.env?.E2E_LOG_SINCE ?? "2026-08-12 10:00:00",
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

  it("fails when a macOS log leaks the fetched title", () => {
    const home = temporaryDirectory();
    const logDirectory = join(home, ".attention/channel");
    mkdirSync(logDirectory, { recursive: true });
    writeFileSync(join(logDirectory, "service.log"), "private title sentinel\n");
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

  it("fails closed when journalctl succeeds without runtime evidence", () => {
    const home = temporaryDirectory();
    const bin = join(home, "bin");
    mkdirSync(bin);
    const fakeJournalctl = join(bin, "journalctl");
    writeFileSync(fakeJournalctl, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeJournalctl, 0o700);

    const result = run("linux", {
      env: { E2E_LOG_SINCE: "2026-08-12 10:00:00" },
      home,
      path: `${bin}:/usr/bin:/bin`,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("provided no runtime evidence");
    expect(result.stdout).not.toContain("ok:");
  });

  it("does not treat the journalctl no-entries banner as runtime evidence", () => {
    const home = temporaryDirectory();
    const bin = join(home, "bin");
    mkdirSync(bin);
    const fakeJournalctl = join(bin, "journalctl");
    writeFileSync(
      fakeJournalctl,
      "#!/bin/sh\nprintf '%s\\n' '-- No entries --'\n",
    );
    chmodSync(fakeJournalctl, 0o700);

    const result = run("linux", {
      home,
      path: `${bin}:/usr/bin:/bin`,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("provided no runtime evidence");
    expect(result.stdout).not.toContain("ok:");
  });

  it("accepts only positive Linux evidence from the expected unit and bounded window", () => {
    const home = temporaryDirectory();
    const bin = join(home, "bin");
    mkdirSync(bin);
    const argumentsFile = join(home, "journalctl-arguments");
    const fakeJournalctl = join(bin, "journalctl");
    writeFileSync(
      fakeJournalctl,
      "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$E2E_JOURNAL_ARGUMENTS_FILE\"\nprintf 'attention channel runtime checkpoint\\n'\n",
    );
    chmodSync(fakeJournalctl, 0o700);

    const result = run("linux", {
      env: {
        E2E_JOURNAL_ARGUMENTS_FILE: argumentsFile,
        E2E_LOG_SINCE: "2026-08-12 10:00:00",
      },
      home,
      path: `${bin}:/usr/bin:/bin`,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ok: Linux channel journal contain no enrichment content");
    expect(readFileSync(argumentsFile, "utf8").trim().split("\n")).toEqual([
      "--user",
      "--unit=attention-channel.service",
      "--since",
      "2026-08-12 10:00:00",
      "--no-pager",
      "--output=cat",
      "--quiet",
    ]);
  });

  it("preserves checker failure through the documented wrapper", () => {
    const home = temporaryDirectory();
    const bin = join(home, "bin");
    mkdirSync(bin);
    const fakeUname = join(bin, "uname");
    writeFileSync(fakeUname, "#!/bin/sh\nprintf 'Darwin\\n'\n");
    chmodSync(fakeUname, 0o700);
    const acceptance = readFileSync(
      join(repositoryRoot, "docs/local-agent-wechat-device-acceptance.md"),
      "utf8",
    );
    const wrapper = acceptance.match(
      /验收完成后检查后台服务日志[\s\S]*?```bash\n(?<script>[\s\S]*?)\n```/u,
    )?.groups?.script;

    expect(wrapper).toBeTruthy();
    const result = spawnSync("bash", ["-c", wrapper ?? ""], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("cannot read expected macOS channel log");
    expect(result.stdout).not.toContain("ok:");
  });
});
