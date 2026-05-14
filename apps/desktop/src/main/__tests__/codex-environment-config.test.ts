import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  listCodexEnvironmentOptions,
  parseCodexEnvironmentToml,
} from "../app-server/codex-environment-config";

describe("codex environment config", () => {
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
});
