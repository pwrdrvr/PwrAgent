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

it("uses the enclosing folder when a skill omits its name", async () => {
  await withWorkspace(async ({ repo, write }) => {
    const file = path.join(repo, ".agents", "skills", "release-checks", "SKILL.md");
    await write(file, "---\ndescription: Check the release.\n---\n");
    await write(path.join(repo, ".agents", "skills", "blank", "SKILL.md"), "---\n---\n");
    const { registry } = createKimiAcpRegistry({ acpBackendId: backend });
    const { data } = await registry.listSkills({ backend, cwd: repo, catalog: "skills" });
    expect(data[0]?.skills).toEqual([
      expect.objectContaining({ name: "release-checks", path: file }),
    ]);
  });
});

it("applies workspace exclusions to nested personal imports and preserves CLI-global skills", async () => {
  await withWorkspace(async ({ home, repo, skill, write }) => {
    const shared = path.join(home, "shared");
    await skill(shared, "repo-audit", "team/audit");
    await skill(shared, "private-check", "team/private");
    const other = await skill(shared, "other-audit", "other/audit");
    const cli = await skill(path.join(home, ".gemini", "skills"), "cli-audit");
    await write(path.join(repo, ".agents", "skills.json"), JSON.stringify({ exclude: ["team/audit", "team/private", "cli-audit"] }));
    await write(path.join(home, ".gemini", "config", "skills.json"), JSON.stringify({
      entries: [
        { path: shared, include_only: ["team/audit", "other/audit"] },
        { path: path.join(shared, "team", "private", "SKILL.md") },
      ],
    }));
    const { registry } = createKimiAcpRegistry({ acpBackendId: backend });
    const { data } = await registry.listSkills({ backend, cwd: repo, catalog: "skills" });
    expect(data[0]?.skills.map(({ name, path }) => [name, path])).toEqual([
      ["cli-audit", cli],
      ["other-audit", other],
    ]);
  });
});

it("keeps enabled workspace plugin skills in their own workspace catalog", async () => {
  await withWorkspace(async ({ home, repo, cwd, skill, write }) => {
    const unrelated = path.join(path.dirname(repo), "unrelated");
    await mkdir(unrelated);
    const pluginRoot = path.join(repo, ".agents", "plugins");
    for (const name of ["garden", "disabled"]) {
      await write(path.join(pluginRoot, name, "plugin.json"), JSON.stringify({ name, version: "1.0.0" }));
    }
    const bundled = await skill(path.join(pluginRoot, "garden", "skills"), "audit");
    await skill(path.join(pluginRoot, "disabled", "skills"), "audit");
    await write(path.join(home, ".gemini", "config", "config.json"), JSON.stringify({
      plugins: { disabled: { enabled: false } },
    }));
    const { registry } = createKimiAcpRegistry({ acpBackendId: backend });
    const { data } = await registry.listSkills({ backend, cwds: [cwd, unrelated], catalog: "skills" });
    expect(data.map(({ cwd, skills }) => [cwd, skills.map(({ name, path }) => [name, path])])).toEqual([
      [cwd, [["garden:audit", bundled]]],
      [unrelated, []],
    ]);
  });
});

it("resolves nested inherited entries at the root of the manifest's own repository", async () => {
  await withWorkspace(async ({ home, repo, skill, write }) => {
    const sharedRepo = path.join(home, "shared-repo");
    const inherited = path.join(sharedRepo, "packages", "api", ".agents", "skills.json");
    await write(path.join(sharedRepo, ".git", "HEAD"), "ref: refs/heads/main\n");
    const shared = await skill(path.join(sharedRepo, "tools", "skills"), "shared-audit");
    await skill(path.join(repo, "tools", "skills"), "wrong-audit");
    await write(inherited, JSON.stringify({ entries: [{ path: "tools/skills" }] }));
    await write(path.join(repo, ".agents", "skills.json"), JSON.stringify({ inherits: [{ path: inherited }] }));
    const { registry } = createKimiAcpRegistry({ acpBackendId: backend });
    const { data } = await registry.listSkills({ backend, cwd: repo, catalog: "skills" });
    expect(data[0]?.skills).toEqual([expect.objectContaining({ name: "shared-audit", path: shared })]);
  });
});

it("enforces one scan allowance across workspaces even when each workspace fits on its own", async () => {
  await withWorkspace(async ({ home, repo, write }) => {
    // 100 directory entries per home scan. Multiple distinct workspaces
    // must spend the same allowance when they read this shared source.
    const shared = path.join(home, ".gemini", "skills");
    await Promise.all(Array.from({ length: 100 }, (_, index) => write(path.join(shared, `readme-${index}.md`), "")));
    const workspaces = Array.from({ length: 101 }, (_, index) => path.join(repo, `project-${index}`));
    await Promise.all(workspaces.map((cwd) => mkdir(cwd)));
    const { registry } = createKimiAcpRegistry({ acpBackendId: backend });
    await expect(registry.listSkills({ backend, cwds: workspaces.slice(0, 2), catalog: "skills" }))
      .resolves.toMatchObject({ data: [{ cwd: workspaces[0] }, { cwd: workspaces[1] }] });
    await expect(registry.listSkills({ backend, cwds: workspaces, catalog: "skills" }))
      .rejects.toThrow("Antigravity skill discovery exceeded its scan limit.");
  });
});
