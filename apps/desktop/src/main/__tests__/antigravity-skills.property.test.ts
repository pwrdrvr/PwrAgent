import fc from "fast-check";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createKimiAcpRegistry } from "./helpers/backend-registry-fixture";

const backend = "acp:antigravity";

async function withWorkspace(run: (fixture: {
  home: string;
  repo: string;
  cwd: string;
  write: (file: string, contents: string) => Promise<void>;
  skill: (root: string, name: string, folder?: string) => Promise<string>;
}) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-agy-skills-"));
  const home = path.join(root, "home");
  const repo = path.join(root, "worktree");
  const cwd = path.join(repo, "packages", "api");
  const homeMock = vi.spyOn(os, "homedir").mockReturnValue(home);
  const write = async (file: string, contents: string) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents);
  };
  try {
    await write(path.join(repo, ".git"), "gitdir: ../main/.git/worktrees/branch\n");
    await mkdir(cwd, { recursive: true });
    await run({
      home, repo, cwd, write,
      skill: async (directory, name, folder = name) => {
        const file = path.join(directory, folder, "SKILL.md");
        await write(file, `---\nname: ${name}\ndescription: >-\n  Contrived ${name}\n  instructions.\n---\nSkill body.\n`);
        return file;
      },
    });
  } finally {
    homeMock.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}

it("lists worktree and home skills before the launchpad starts an ACP session", async () => {
  await withWorkspace(async ({ home, repo, cwd, skill }) => {
    const release = await skill(path.join(repo, ".agents", "skills"), "release");
    const personal = await skill(path.join(home, ".agents", "skills"), "prepare");
    const { registry, acpClient } = createKimiAcpRegistry({
      acpBackendId: backend,
      availableCommandsOnSessionStart: [{ name: "compact" }],
    });
    const request = { backend, cwd, catalog: "skills" } as const;
    const { data } = await registry.listSkills(request);
    expect(data.flatMap(({ skills }) => skills).map(({ name, path }) => [name, path]).sort()).toEqual([
      ["prepare", personal],
      ["release", release],
    ]);
    expect(acpClient.startSession).not.toHaveBeenCalled();
  });
});

it("matches the winning skill from each workspace and home source independently of command availability", async () => {
  await fc.assert(fc.asyncProperty(
    fc.subarray(["shared", "workspace", "worktree", "config", "legacy", "personal"] as const, { minLength: 1 }),
    fc.boolean(),
    async (sources, live) => {
      await withWorkspace(async ({ home, repo, cwd, skill }) => {
        // Native CLI shared wins, then the closest workspace, then global config.
        // PwrAgent's personal fallback comes after Antigravity's own locations.
        const precedence = {
          shared: path.join(home, ".gemini", "skills"),
          workspace: path.join(cwd, ".agents", "skills"),
          worktree: path.join(repo, ".agents", "skills"),
          config: path.join(home, ".gemini", "config", "skills"),
          legacy: path.join(repo, ".gemini", "skills"),
          personal: path.join(home, ".agents", "skills"),
        };
        const names = await Promise.all(sources.map(async (source) => ({
          source,
          fallback: await skill(precedence[source], "publish"),
          unique: await skill(precedence[source], source),
        })));
        await skill(path.join(path.dirname(repo), ".agents", "skills"), "outside");
        const { registry, acpClient } = createKimiAcpRegistry({
          acpBackendId: backend,
          availableCommandsOnSessionStart: [{ name: "compact" }],
        });
        const session = live ? await acpClient.startSession({ cwd, executionMode: "default" }) : undefined;
        const request = { backend, ...(session ? { threadId: session.sessionId } : { cwd }), catalog: "skills" } as const;
        const { data } = await registry.listSkills(request);
        const actual = Object.fromEntries(data.flatMap(({ skills }) => skills.map((entry) => [entry.name, entry.path])));
        expect(actual).toEqual({
          ...Object.fromEntries(names.map(({ source, unique }) => [source, unique])),
          publish: names[0]!.fallback,
        });
        expect(acpClient.startSession).toHaveBeenCalledTimes(live ? 1 : 0);
      });
    },
  ), { numRuns: 18 });
});

it("follows inherited manifests and explicit nested entries when the repository is opened below its root", async () => {
  await withWorkspace(async ({ home, repo, cwd, skill, write }) => {
    const shared = path.join(home, "team");
    const allowed = await skill(path.join(shared, "skills"), "audit", "nested/audit");
    await skill(path.join(shared, "skills"), "filtered");
    await skill(path.join(repo, ".agent", "skills"), "hidden");
    await write(path.join(shared, ".agents", "skills.json"), JSON.stringify({
      entries: [{ path: "skills", include_only: ["nested/audit", "filtered"] }],
    }));
    await write(path.join(repo, ".agents", "skills.json"), JSON.stringify({
      inherits: [{ path: path.join(shared, ".agents", "skills.json"), exclude: ["filtered"] }],
      exclude: ["hidden"],
    }));
    const { registry } = createKimiAcpRegistry({
      acpBackendId: backend,
      availableCommandsOnSessionStart: [{ name: "compact" }],
    });
    const request = { backend, cwd, catalog: "skills" } as const;
    const { data } = await registry.listSkills(request);
    expect(data.flatMap(({ skills }) => skills)).toEqual([
      expect.objectContaining({ name: "audit", path: allowed, description: "Contrived audit instructions." }),
    ]);
  });
});
