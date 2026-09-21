import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { NavigationLaunchpadDraft } from "@pwragent/shared";
import {
  listCodexEnvironmentOptions,
  parseCodexEnvironmentToml,
  withCodexEnvironmentOptions,
} from "../app-server/codex-environment-config";

describe("codex environment config", () => {
  it.each(["darwin", "linux", "win32"] as const)("selects the checked-in environment for %s", async (platform) => {
    const [option] = await listCodexEnvironmentOptions(path.resolve(import.meta.dirname, "../../../../.."), platform);
    expect(option.actions).toHaveLength(7);
    expect(new Set(option.actions.map((action) => action.id)).size).toBe(7);
    expect(option.actions[0].id).toBe("work");
    if (platform === "win32") {
      expect(option.shell).toBe("powershell");
      expect(option.setupScript).toContain("nvm install $nodeVersion");
      expect(option.cleanupScript).toContain("Remove-Item -LiteralPath node_modules");
      expect(option.actions.every((action) => action.shell === "powershell")).toBe(true);
      expect(option.actions[0].command).toContain('$env:PWRAGENT_PROFILE = "work"');
    } else {
      expect(option.shell).toBeUndefined();
      expect(option.setupScript).toBe("nvm install\ncorepack enable\npnpm install");
      expect(option.cleanupScript).toBe("rm -rf node_modules");
      expect(option.actions[0].command).toContain("PWRAGENT_PROFILE=work pnpm dev");
    }
  });

  it("resolves overrides independently of table order, including empty overrides and shared actions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-platform-env-"));
    try {
      await mkdir(path.join(root, ".codex/environments"), { recursive: true });
      await writeFile(path.join(root, ".codex/environments/environment.toml"), `
[setup.win32]
script = ""
[setup.linux]
script = "linux setup"
[setup]
script = "default setup"
[cleanup.win32]
script = "Windows cleanup"
[cleanup]
script = "default cleanup"
[[actions]]
name = "Shared"
command = "node --version"
[[actions]]
name = "Run"
platform = "darwin"
command = "mac run"
[[actions]]
name = "Run"
platform = "win32"
command = "Windows run"
`);
      const [win] = await listCodexEnvironmentOptions(root, "win32");
      expect(win.setupScript).toBeUndefined();
      expect(win.cleanupScript).toBe("Windows cleanup");
      expect(win.actions.map((action) => action.id)).toEqual(["shared", "run"]);
      const [mac] = await listCodexEnvironmentOptions(root, "darwin");
      expect(mac.setupScript).toBe("default setup");
      expect(mac.cleanupScript).toBe("default cleanup");
      expect(mac.actions.map((action) => action.command)).toEqual(["node --version", "mac run"]);
      const [linux] = await listCodexEnvironmentOptions(root, "linux");
      expect(linux.setupScript).toBe("linux setup");
      expect(linux.actions.map((action) => action.id)).toEqual(["shared"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parses setup scripts and action commands", () => {
    const parsed = parseCodexEnvironmentToml(`
version = 1
name = "PwrAgnt"

[setup]
script = '''
set -euo pipefail
pnpm install
'''

[cleanup]
script = "rm -rf node_modules"

[[actions]]
name = "Start dev"
icon = "run"
command = "pnpm dev"
`);

    expect(parsed.name).toBe("PwrAgnt");
    expect(parsed.setup?.script).toContain("pnpm install");
    expect(parsed.cleanup?.script).toBe("rm -rf node_modules");
    expect(parsed.actions).toEqual([
      {
        name: "Start dev",
        icon: "run",
        command: "pnpm dev",
      },
    ]);
  });

  it("lists .codex/environments toml files as launchpad options", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-codex-env-"));
    const environmentsDir = path.join(root, ".codex", "environments");
    await mkdir(environmentsDir, { recursive: true });
    await writeFile(
      path.join(environmentsDir, "environment.toml"),
      `
version = 1
name = "Repo Environment"

[setup]
script = "pnpm install"

[[actions]]
name = "Start dev"
command = "pnpm dev"
`,
      "utf8",
    );

    await writeFile(
      path.join(environmentsDir, "notes.txt"),
      "ignore me",
      "utf8",
    );

    const options = await listCodexEnvironmentOptions(root);
    expect(options).toMatchObject([
      {
        id: "environment",
        name: "Repo Environment",
        setupScript: "pnpm install",
        actions: [
          {
            id: "start-dev",
            name: "Start dev",
            command: "pnpm dev",
          },
        ],
      },
    ]);
  });

  it("dedupes action ids when action names collide", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-codex-env-"));
    const environmentsDir = path.join(root, ".codex", "environments");
    await mkdir(environmentsDir, { recursive: true });
    await writeFile(
      path.join(environmentsDir, "environment.toml"),
      `
version = 1
name = "Repo Environment"

[[actions]]
name = "Start dev"
command = "pnpm dev"

[[actions]]
name = "Start Dev"
command = "pnpm dev:alt"
`,
      "utf8",
    );

    const options = await listCodexEnvironmentOptions(root);
    expect(options[0]?.actions).toMatchObject([
      {
        id: "start-dev",
        command: "pnpm dev",
      },
      {
        id: "start-dev-2",
        command: "pnpm dev:alt",
      },
    ]);
  });

  it("hydrates environment options for ACP launchpads", () => {
    const launchpad: NavigationLaunchpadDraft = {
      directoryKey: "directory:/repo",
      directoryKind: "directory",
      directoryLabel: "repo",
      directoryPath: "/repo",
      backend: "acp:kimi",
      executionMode: "default",
      codexEnvironmentId: "environment",
      codexEnvironmentActionId: "start-dev",
      prompt: "",
      workMode: "local",
      createdAt: 1,
      updatedAt: 1,
    };

    expect(
      withCodexEnvironmentOptions(launchpad, [
        {
          id: "environment",
          name: "Repo Environment",
          sourcePath: "/repo/.codex/environments/environment.toml",
          setupScript: "pnpm install",
          actions: [
            {
              id: "start-dev",
              name: "Start dev",
              command: "pnpm dev",
            },
          ],
        },
      ]),
    ).toMatchObject({
      backend: "acp:kimi",
      codexEnvironmentActionId: "start-dev",
      codexEnvironmentId: "environment",
      codexEnvironmentOptions: [
        {
          id: "environment",
          name: "Repo Environment",
        },
      ],
    });
  });
});
