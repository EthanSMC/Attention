import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  ATTENTION_SKILL_DOCUMENT_SHA256,
  ATTENTION_SKILL_PUBLIC_PATH,
  getAgentInstallationProfile,
} from "@attention/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { projectAgentConnections } from "./agent-connection-projection";

const execFileAsync = promisify(execFile);
const skillFile = new URL("../../public/skills/attention/SKILL.md", import.meta.url);

let origin = "";
let server: Server;
let serveTamperedSkill = false;

beforeAll(async () => {
  const skill = await readFile(skillFile);
  server = createServer((request, response) => {
    if (request.url !== ATTENTION_SKILL_PUBLIC_PATH) {
      response.writeHead(404).end();
      return;
    }
    const body = serveTamperedSkill ? Buffer.from("tampered\n") : skill;
    response.writeHead(200, {
      "Content-Length": String(body.byteLength),
      "Content-Type": "text/markdown; charset=utf-8",
    });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Static Skill server did not expose a TCP port");
  }
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("source-free Agent installation", () => {
  it.each([
    ["codex", ".agents/skills/attention/SKILL.md"],
    ["claude-code", ".claude/skills/attention/SKILL.md"],
    ["openclaw", "attention-skill/SKILL.md"],
  ] as const)(
    "downloads and verifies the published Skill into the real %s POSIX destination",
    async (id, relativeTarget) => {
      const home = await mkdtemp(join(tmpdir(), `attention-${id}-`));
      try {
        const connection = projectAgentConnections({
          mcpUrl: `${origin}/mcp`,
          origin,
        }).find((candidate) => candidate.id === id);
        const install = connection?.commands.find(
          (command) =>
            command.kind === "download_and_verify" &&
            command.platform === "posix",
        );
        expect(install).toBeDefined();
        await execFileAsync("/bin/sh", ["-c", install!.value], {
          cwd: home,
          env: { ...process.env, HOME: home },
          timeout: 10_000,
        });

        const expected = await readFile(skillFile);
        const installed = await readFile(join(home, relativeTarget));
        expect(installed).toEqual(expected);
      } finally {
        await rm(home, { force: true, recursive: true });
      }
    },
  );

  it("projects safe Windows PowerShell download commands from manifest URL, path, and digest", () => {
    const connections = projectAgentConnections({
      mcpUrl: `${origin}/mcp`,
      origin,
    });
    for (const id of ["codex", "claude-code", "openclaw"] as const) {
      const profile = getAgentInstallationProfile(id);
      const command = connections
        .find((candidate) => candidate.id === id)
        ?.commands.find(
          (candidate) =>
            candidate.kind === "download_and_verify" &&
            candidate.platform === "powershell",
        );
      expect(command).toBeDefined();
      expect(command!.value).toContain(
        `$attentionSkillUrl = '${origin}${profile.skill.source_path}'`,
      );
      expect(command!.value).toContain(
        `[Environment]::ExpandEnvironmentVariables('${profile.skill.local_path?.windows_directory}\\SKILL.md')`,
      );
      expect(command!.value).toContain(
        `$attentionSkillSha256 = '${ATTENTION_SKILL_DOCUMENT_SHA256}'`,
      );
      expect(command!.value).toContain("Get-FileHash -Algorithm SHA256");
      expect(command!.value).not.toMatch(/Invoke-Expression|\biex\b|\|\s*(?:powershell|pwsh)\b/iu);
    }
  });

  it("rejects mismatched bytes and preserves an existing installed Skill", async () => {
    const home = await mkdtemp(join(tmpdir(), "attention-digest-failure-"));
    const target = join(home, ".agents/skills/attention/SKILL.md");
    try {
      await mkdir(join(home, ".agents/skills/attention"), { recursive: true });
      await writeFile(target, "existing-skill\n", "utf8");
      const command = projectAgentConnections({
        mcpUrl: `${origin}/mcp`,
        origin,
      })
        .find(({ id }) => id === "codex")
        ?.commands.find(
          (candidate) =>
            candidate.kind === "download_and_verify" &&
            candidate.platform === "posix",
        );
      expect(command).toBeDefined();

      serveTamperedSkill = true;
      await expect(
        execFileAsync("/bin/sh", ["-c", command!.value], {
          cwd: home,
          env: { ...process.env, HOME: home },
          timeout: 10_000,
        }),
      ).rejects.toBeDefined();
      expect(await readFile(target, "utf8")).toBe("existing-skill\n");
    } finally {
      serveTamperedSkill = false;
      await rm(home, { force: true, recursive: true });
    }
  });

  it("keeps native host argv exact and labels config-only probes as non-acceptance", () => {
    const byId = new Map(
      projectAgentConnections({
        mcpUrl: "https://attention.example/mcp",
        origin: "https://attention.example",
      }).map((connection) => [connection.id, connection]),
    );

    expect(
      byId
        .get("codex")
        ?.commands.filter((command) => command.kind !== "download_and_verify")
        .map(({ label, value }) => ({ label, value })),
    ).toEqual([
      {
        label: "添加 MCP",
        value: "codex mcp add attention --url https://attention.example/mcp",
      },
      { label: "登录授权", value: "codex mcp login attention" },
      {
        label: "查看 MCP 配置",
        value: "codex mcp get attention --json",
      },
    ]);
    expect(
      byId
        .get("claude-code")
        ?.commands.filter((command) => command.kind !== "download_and_verify")
        .map(({ label, value }) => ({ label, value })),
    ).toEqual([
      {
        label: "添加 MCP",
        value:
          "claude mcp add --transport http --scope user attention https://attention.example/mcp",
      },
      { label: "登录授权", value: "claude mcp login attention" },
      {
        label: "查看 MCP 配置",
        value: "claude mcp get attention",
      },
    ]);
    expect(
      byId.get("hermes")?.commands.map(({ label, value }) => ({ label, value })),
    ).toEqual([
      {
        label: "安装 Skill",
        value:
          "hermes skills install https://attention.example/skills/attention/SKILL.md",
      },
      {
        label: "添加并授权 MCP",
        value:
          "hermes mcp add attention --url https://attention.example/mcp --auth oauth",
      },
      { label: "检查 MCP 连接", value: "hermes mcp test attention" },
    ]);
  });

  it("guides WorkBuddy through GitHub first, keeps the ZIP as a fallback, and gives every host the same live-tool acceptance", () => {
    const connections = projectAgentConnections({
      mcpUrl: "https://attention.example/mcp",
      origin: "https://attention.example",
    });
    const workbuddy = connections.find(({ id }) => id === "workbuddy");
    expect(workbuddy?.manualChecklist.map(({ title }) => title)).toEqual([
      "从 GitHub 安装 Skill",
      "备用：下载 Skill ZIP",
      "备用：核对 ZIP SHA-256",
      "备用：上传 Skill ZIP",
      "添加 MCP 并授权",
    ]);
    expect(workbuddy?.manualChecklist[0]?.value).toContain(
      "https://github.com/EthanSMC/Attention/blob/main/apps/web/public/skills/attention/SKILL.md",
    );
    expect(workbuddy?.manualChecklist[0]?.detail).toContain("首选");
    expect(workbuddy?.manualChecklist[1]?.value).toMatch(/\.zip$/u);
    expect(workbuddy?.manualChecklist[2]?.value).toBe(
      getAgentInstallationProfile("workbuddy").skill.bundle_sha256,
    );
    expect(workbuddy?.manualChecklist[3]?.detail).toContain(
      "Add Skill → Upload Skill",
    );
    expect(workbuddy?.manualChecklist[4]?.value).toBe(
      "https://attention.example/mcp",
    );

    for (const connection of connections) {
      expect(connection.acceptance.toolName).toBe("attention_get_my_account");
      expect(connection.acceptance.detail).toContain("只有成功返回");
      expect(connection.acceptance.detail).toContain("查看本地配置不算验收");
    }
  });
});
