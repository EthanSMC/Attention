import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, posix, win32 } from "node:path";

import {
  type CommandInvocation,
  type CommandRunner,
  runCommand,
} from "../command-runner";
import type { ChannelBridgeHost } from "./channel-command";

const SERVICE_LABEL = "cn.noveltystudio.attention.channel";

export interface ChannelServicePlan {
  readonly commands: readonly (CommandInvocation & {
    readonly allowFailure?: boolean;
  })[];
  readonly files: readonly {
    readonly contents: string;
    readonly mode: number;
    readonly path: string;
  }[];
  readonly label: string;
}

export interface ChannelServiceRemovalPlan {
  readonly afterCommands: readonly (CommandInvocation & {
    readonly allowFailure?: boolean;
  })[];
  readonly commands: readonly (CommandInvocation & {
    readonly allowFailure?: boolean;
  })[];
  readonly label: string;
  readonly paths: readonly string[];
}

export interface ChannelServiceRemovalInput {
  readonly homeDirectory?: string;
  readonly platform: NodeJS.Platform;
  readonly uid?: number;
}

export interface ChannelServiceInput {
  readonly cliScript: string;
  readonly environmentPath?: string;
  readonly homeDirectory?: string;
  readonly hostId: ChannelBridgeHost;
  readonly nodeExecutable: string;
  readonly origin: string;
  readonly platform: NodeJS.Platform;
  readonly uid?: number;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function systemd(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function cmd(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function buildChannelServicePlan(
  input: ChannelServiceInput,
): ChannelServicePlan {
  const home = input.homeDirectory ?? homedir();
  const bridgeArgs = [
    input.cliScript,
    "channel",
    "start",
    input.hostId,
    "--origin",
    input.origin,
    "--service",
  ];

  if (input.platform === "darwin") {
    const uid = input.uid ?? process.getuid?.();
    if (uid === undefined) throw new Error("Cannot determine macOS user id.");
    const path = posix.join(
      home,
      "Library/LaunchAgents",
      `${SERVICE_LABEL}.plist`,
    );
    const logDirectory = posix.join(home, ".attention/channel");
    const argumentsXml = [input.nodeExecutable, ...bridgeArgs]
      .map((value) => `      <string>${xml(value)}</string>`)
      .join("\n");
    const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
${
  input.environmentPath
    ? `  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(input.environmentPath)}</string></dict>
`
    : ""
}  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${xml(posix.join(logDirectory, "service.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(posix.join(logDirectory, "service-error.log"))}</string>
</dict>
</plist>
`;
    const domain = `gui/${uid}`;
    return {
      commands: [
        {
          allowFailure: true,
          args: ["bootout", `${domain}/${SERVICE_LABEL}`],
          executable: "launchctl",
        },
        { args: ["bootstrap", domain, path], executable: "launchctl" },
        {
          args: ["kickstart", "-k", `${domain}/${SERVICE_LABEL}`],
          executable: "launchctl",
        },
      ],
      files: [{ contents, mode: 0o600, path }],
      label: SERVICE_LABEL,
    };
  }

  if (input.platform === "linux") {
    const path = posix.join(
      home,
      ".config/systemd/user/attention-channel.service",
    );
    const contents = `[Unit]
Description=Attention local WeChat channel bridge
After=network-online.target

[Service]
Type=simple
${input.environmentPath ? `Environment=${systemd(`PATH=${input.environmentPath}`)}\n` : ""}ExecStart=${[input.nodeExecutable, ...bridgeArgs].map(systemd).join(" ")}
Restart=on-failure
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
`;
    return {
      commands: [
        {
          args: ["--user", "daemon-reload"],
          executable: "systemctl",
        },
        {
          args: ["--user", "enable", "--now", "attention-channel.service"],
          executable: "systemctl",
        },
      ],
      files: [{ contents, mode: 0o600, path }],
      label: SERVICE_LABEL,
    };
  }

  if (input.platform === "win32") {
    const path = win32.join(
      home,
      "AppData\\Local\\Attention\\attention-channel.cmd",
    );
    const contents = `@echo off\r\n${input.environmentPath ? `set "PATH=${input.environmentPath.replaceAll('"', '""')}"\r\n` : ""}timeout /t 3 /nobreak >nul\r\n${[
      input.nodeExecutable,
      ...bridgeArgs,
    ]
      .map(cmd)
      .join(" ")}\r\n`;
    return {
      commands: [
        {
          args: [
            "/Create",
            "/TN",
            "AttentionChannel",
            "/TR",
            path,
            "/SC",
            "ONLOGON",
            "/RL",
            "LIMITED",
            "/F",
          ],
          executable: "schtasks.exe",
        },
        {
          args: ["/Run", "/TN", "AttentionChannel"],
          executable: "schtasks.exe",
        },
      ],
      files: [{ contents, mode: 0o600, path }],
      label: SERVICE_LABEL,
    };
  }

  throw new Error(`Background channel service is unsupported on ${input.platform}.`);
}

export function buildChannelServiceRemovalPlan(
  input: ChannelServiceRemovalInput,
): ChannelServiceRemovalPlan {
  const home = input.homeDirectory ?? homedir();
  if (input.platform === "darwin") {
    const uid = input.uid ?? process.getuid?.();
    if (uid === undefined) throw new Error("Cannot determine macOS user id.");
    return {
      afterCommands: [],
      commands: [
        {
          allowFailure: true,
          args: ["bootout", `gui/${uid}/${SERVICE_LABEL}`],
          executable: "launchctl",
        },
      ],
      label: SERVICE_LABEL,
      paths: [
        posix.join(home, "Library/LaunchAgents", `${SERVICE_LABEL}.plist`),
      ],
    };
  }
  if (input.platform === "linux") {
    return {
      afterCommands: [
        { args: ["--user", "daemon-reload"], executable: "systemctl" },
      ],
      commands: [
        {
          allowFailure: true,
          args: ["--user", "disable", "--now", "attention-channel.service"],
          executable: "systemctl",
        },
      ],
      label: SERVICE_LABEL,
      paths: [
        posix.join(home, ".config/systemd/user/attention-channel.service"),
      ],
    };
  }
  if (input.platform === "win32") {
    return {
      afterCommands: [],
      commands: [
        {
          allowFailure: true,
          args: ["/End", "/TN", "AttentionChannel"],
          executable: "schtasks.exe",
        },
        {
          allowFailure: true,
          args: ["/Delete", "/TN", "AttentionChannel", "/F"],
          executable: "schtasks.exe",
        },
      ],
      label: SERVICE_LABEL,
      paths: [
        win32.join(
          home,
          "AppData\\Local\\Attention\\attention-channel.cmd",
        ),
      ],
    };
  }
  throw new Error(`Background channel service is unsupported on ${input.platform}.`);
}

async function executeCommands(
  commands: ChannelServicePlan["commands"],
  label: string,
  runner: CommandRunner,
): Promise<void> {
  for (const command of commands) {
    const result = await runner(command, { timeoutMs: 20_000 });
    if (result.exitCode !== 0 && !command.allowFailure) {
      throw new Error(
        `Could not update ${label}: ${result.stderr || result.stdout || `exit ${String(result.exitCode)}`}`,
      );
    }
  }
}

export async function installChannelService(
  plan: ChannelServicePlan,
  runner: CommandRunner = runCommand,
): Promise<void> {
  for (const file of plan.files) {
    await mkdir(dirname(file.path), { mode: 0o700, recursive: true });
    const temporary = `${file.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, file.contents, {
        encoding: "utf8",
        flag: "wx",
        mode: file.mode,
      });
      await rename(temporary, file.path);
      await chmod(file.path, file.mode);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  await executeCommands(plan.commands, plan.label, runner);
}

export async function uninstallChannelService(
  plan: ChannelServiceRemovalPlan,
  runner: CommandRunner = runCommand,
): Promise<void> {
  await executeCommands(plan.commands, plan.label, runner);
  for (const path of plan.paths) await rm(path, { force: true });
  await executeCommands(plan.afterCommands, plan.label, runner);
}

export async function isChannelServiceConfigured(
  input: ChannelServiceRemovalInput,
): Promise<boolean> {
  let path: string | undefined;
  try {
    path = buildChannelServiceRemovalPlan(input).paths[0];
    if (!path) return false;
    await access(path);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    if (!path) return false;
    throw error;
  }
}
