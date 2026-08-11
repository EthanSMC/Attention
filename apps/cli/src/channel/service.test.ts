import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildChannelServicePlan,
  buildChannelServiceRemovalPlan,
  installChannelService,
  isChannelServiceConfigured,
} from "./service";

const input = {
  cliScript: "/Users/me/.local/share/attention/attention-0.1.0.mjs",
  environmentPath: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
  homeDirectory: "/Users/me",
  hostId: "codex" as const,
  nodeExecutable: "/usr/local/bin/node",
  origin: "https://attention.example",
  uid: 501,
};

describe("background channel service plans", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    for (const directory of temporaryDirectories.splice(0)) {
      await rm(directory, { force: true, recursive: true });
    }
  });
  it("builds a macOS user LaunchAgent that restarts failures", () => {
    const plan = buildChannelServicePlan({ ...input, platform: "darwin" });
    expect(plan.files[0]?.path).toBe(
      "/Users/me/Library/LaunchAgents/cn.noveltystudio.attention.channel.plist",
    );
    expect(plan.files[0]?.contents).toContain("<key>SuccessfulExit</key>");
    expect(plan.files[0]?.contents).toContain("--service");
    expect(plan.files[0]?.contents).toContain("/opt/homebrew/bin:/usr/local/bin");
    expect(plan.commands.map((command) => command.executable)).toEqual([
      "launchctl",
      "launchctl",
      "launchctl",
    ]);
    expect(plan.commands[1]?.args).toContain("gui/501");
  });

  it("retries a transient macOS bootstrap failure before kickstart", async () => {
    const home = await mkdtemp(join(tmpdir(), "attention-service-retry-"));
    temporaryDirectories.push(home);
    const plan = buildChannelServicePlan({
      ...input,
      homeDirectory: home,
      platform: "darwin",
    });
    const invocations: string[] = [];
    let bootstrapAttempts = 0;

    await installChannelService(
      plan,
      async (invocation) => {
        invocations.push(invocation.args[0] ?? "");
        if (invocation.args[0] === "bootstrap") {
          bootstrapAttempts += 1;
          if (bootstrapAttempts === 1) {
            return {
              exitCode: 5,
              signal: null,
              stderr: "Bootstrap failed: 5: Input/output error",
              stdout: "",
              timedOut: false,
            };
          }
        }
        return {
          exitCode: 0,
          signal: null,
          stderr: "",
          stdout: "",
          timedOut: false,
        };
      },
      async () => undefined,
    );

    expect(bootstrapAttempts).toBe(2);
    expect(invocations).toEqual([
      "bootout",
      "bootstrap",
      "bootstrap",
      "kickstart",
    ]);
  });

  it("builds a Linux user systemd unit without requiring root", () => {
    const plan = buildChannelServicePlan({
      ...input,
      homeDirectory: "/home/me",
      platform: "linux",
    });
    expect(plan.files[0]?.path).toBe(
      "/home/me/.config/systemd/user/attention-channel.service",
    );
    expect(plan.files[0]?.contents).toContain("Restart=on-failure");
    expect(plan.files[0]?.contents).toContain("--service");
    expect(plan.files[0]?.contents).toContain(
      'Environment="PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"',
    );
    expect(plan.commands.at(-1)?.args).toEqual([
      "--user",
      "enable",
      "--now",
      "attention-channel.service",
    ]);
  });

  it("builds a Windows logon task with a delayed user-owned launcher", () => {
    const plan = buildChannelServicePlan({
      ...input,
      cliScript: "C:\\Users\\me\\AppData\\Local\\Attention\\attention-0.1.0.mjs",
      homeDirectory: "C:\\Users\\me",
      nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
    });
    expect(plan.files[0]?.path).toContain("attention-channel.cmd");
    expect(plan.files[0]?.contents).toContain("timeout /t 3");
    expect(plan.files[0]?.contents).toContain("--service");
    expect(plan.commands[0]?.executable).toBe("schtasks.exe");
    expect(plan.commands[0]?.args).toContain("ONLOGON");
    expect(plan.commands[0]?.args).toContain("LIMITED");
  });

  it("builds user-owned removal plans for every supported platform", () => {
    const mac = buildChannelServiceRemovalPlan({
      homeDirectory: "/Users/me",
      platform: "darwin",
      uid: 501,
    });
    expect(mac.commands[0]?.args).toContain(
      "gui/501/cn.noveltystudio.attention.channel",
    );
    expect(mac.paths[0]).toContain("LaunchAgents");

    const linux = buildChannelServiceRemovalPlan({
      homeDirectory: "/home/me",
      platform: "linux",
    });
    expect(linux.commands[0]?.args).toEqual([
      "--user",
      "disable",
      "--now",
      "attention-channel.service",
    ]);
    expect(linux.afterCommands[0]?.args).toEqual([
      "--user",
      "daemon-reload",
    ]);

    const windows = buildChannelServiceRemovalPlan({
      homeDirectory: "C:\\Users\\me",
      platform: "win32",
    });
    expect(windows.commands.map((command) => command.executable)).toEqual([
      "schtasks.exe",
      "schtasks.exe",
    ]);
    expect(windows.paths[0]).toContain("attention-channel.cmd");
  });

  it("reports only whether the user-owned service artifact exists", async () => {
    const home = await mkdtemp(join(tmpdir(), "attention-service-status-"));
    temporaryDirectories.push(home);
    expect(
      await isChannelServiceConfigured({
        homeDirectory: home,
        platform: "linux",
      }),
    ).toBe(false);
    const unit = join(
      home,
      ".config/systemd/user/attention-channel.service",
    );
    await mkdir(join(home, ".config/systemd/user"), { recursive: true });
    await writeFile(unit, "[Service]\n", "utf8");
    expect(
      await isChannelServiceConfigured({
        homeDirectory: home,
        platform: "linux",
      }),
    ).toBe(true);
  });
});
