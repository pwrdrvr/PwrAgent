import fc from "fast-check";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { readFederatedAntigravitySkills } from "../federation/federation-file-pull";
import { createAcpAvailableCommandsStoreMock, createKimiAcpRegistry, createOverlayStoreMock } from "./helpers/backend-registry-fixture";

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

it("keeps restricted Antigravity discovery inside the authorized workspace", async () => {
  await withWorkspace(async ({ home, repo, skill, write }) => {
    const inside = await skill(path.join(repo, ".agents", "skills"), "inside");
    await skill(path.join(home, ".agents", "skills"), "personal");
    const outside = path.join(home, "other");
    const external = await skill(path.join(outside, ".agents", "skills"), "outside");
    await write(path.join(repo, ".agents", "skills.json"), JSON.stringify({ entries: [{ path: external }] }));
    await symlink(path.dirname(external), path.join(repo, ".agents", "skills", "linked"), "junction");
    const root = await realpath(repo);
    const { registry } = createKimiAcpRegistry({ acpBackendId: backend });
    const { data } = await registry.listSkills({
      backend, cwd: outside, catalog: "skills",
      antigravityWorkspace: {
        cwds: [repo],
        resolvePath: async (file) => {
          const resolved = await realpath(file).catch(() => undefined);
          return resolved === root || resolved?.startsWith(`${root}${path.sep}`) ? resolved : undefined;
        },
      },
    });
    expect(data.map(({ cwd, skills }) => [cwd, skills.map(({ path }) => path)])).toEqual([[repo, [inside]]]);
  });
});

it("discovers peer skills from the owner's thread or registered launchpad under file-pull policy", async () => {
  await withWorkspace(async ({ home, repo, skill }) => {
    const inside = await skill(path.join(repo, ".agents", "skills"), "inside");
    const outside = path.join(home, "other");
    await skill(path.join(outside, ".agents", "skills"), "outside");
    const { registry, acpClient } = createKimiAcpRegistry({ acpBackendId: backend });
    const session = await acpClient.startSession({ cwd: repo, executionMode: "default" });
    const permissions = { filePull: false, filePullOutsideThreadDirectories: false };
    const listSkills = vi.fn((input: Parameters<typeof registry.listSkills>[0]) => registry.listSkills(input));
    const options = {
      permissions: () => permissions,
      resolveThread: (source: Parameters<typeof registry.resolveThread>[0]["backend"], threadId: string) =>
        registry.resolveThread({ backend: source, threadId }),
      listLaunchpads: async () => [{ directoryPath: repo, registeredAt: 1 }, { directoryPath: outside }],
      listSkills,
    };
    const catalog = "skills" as const;
    const request = { threadId: session.sessionId, cwd: outside, cwds: [outside], catalog };
    await expect(readFederatedAntigravitySkills(request, options)).resolves.toEqual({ data: [] });
    permissions.filePull = true;
    await expect(readFederatedAntigravitySkills({ cwd: outside, catalog }, options)).resolves.toEqual({ data: [] });
    await expect(readFederatedAntigravitySkills({ ...request, threadId: "unknown" }, options)).resolves.toEqual({ data: [] });
    expect(listSkills).not.toHaveBeenCalled();
    for (const peerRequest of [request, { cwd: repo, cwds: [outside], catalog }]) {
      const { data } = await readFederatedAntigravitySkills(peerRequest, options);
      expect(data.map(({ cwd, skills }) => [cwd, skills.map(({ path }) => path)])).toEqual([[repo, [inside]]]);
    }
  });
});

it("reports the observed worktree for cached Antigravity commands and leaves legacy rows unscoped", async () => {
  await withWorkspace(async ({ repo, cwd }) => {
    const commands = [{ name: "release", description: "Prepare the release." }];
    const record = { backendId: backend, repositoryPath: repo, commands, observedAt: 1 } as const;
    const store = createAcpAvailableCommandsStoreMock([record]);
    const { registry } = createKimiAcpRegistry({
      acpBackendId: backend,
      acpAvailableCommandsStore: store,
      acpWorktreeRepositoryResolver: async () => ({ id: "repo", path: repo, label: "Repo", kind: "local" }),
    });
    const request = { backend, cwd: repo, catalog: "commands" } as const;
    await expect(registry.listSkills(request)).resolves.toEqual({ data: [{ commands, skills: [] }] });
    store.upsert({ ...record, workspaceCwd: cwd });
    await expect(registry.listSkills(request)).resolves.toEqual({ data: [{ cwd, commands, skills: [] }] });
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

it.each(["skill file", "skill folder", "collection"] as const)("applies complete path suffix filters to a manifest %s", async (kind) => {
  await withWorkspace(async ({ home, repo, skill, write }) => {
    const shared = path.join(home, "shared");
    const allowed = await skill(shared, "public", "team/public");
    const candidates = [
      allowed,
      await skill(shared, "private", "team/private"),
      await skill(shared, "restricted", "team/restricted"),
      await skill(shared, "other-public", "other-team/public"),
    ];
    const targets = kind === "collection"
      ? [path.join(shared, "team"), path.join(shared, "other-team")]
      : candidates.map((file) => kind === "skill file" ? file : path.dirname(file));
    const inherited = path.join(shared, "skills.json");
    await write(inherited, JSON.stringify({
      exclude: ["team/restricted"],
      entries: targets.map((target) => ({ path: target, exclude: ["team/private"] })),
    }));
    await write(path.join(repo, ".agents", "skills.json"), JSON.stringify({
      inherits: [{ path: inherited, include_only: ["team/public", "team/private", "team/restricted"] }],
    }));
    const { registry } = createKimiAcpRegistry({ acpBackendId: backend });
    const { data } = await registry.listSkills({ backend, cwd: repo, catalog: "skills" });
    expect(data[0]?.skills.map(({ path }) => path)).toEqual([allowed]);
  });
});

it("resolves a nested include below the portion of its suffix already in the collection root", async () => {
  await withWorkspace(async ({ home, repo, skill, write }) => {
    const shared = path.join(home, "shared");
    const release = await skill(shared, "release", "team/checks/release");
    await write(path.join(repo, ".agents", "skills.json"), JSON.stringify({
      entries: [{ path: path.join(shared, "team"), include_only: ["team/checks/release"] }],
    }));
    const { registry } = createKimiAcpRegistry({ acpBackendId: backend });
    const { data } = await registry.listSkills({ backend, cwd: repo, catalog: "skills" });
    expect(data[0]?.skills.map(({ path }) => path)).toEqual([release]);
  });
});

it("resolves personal customization paths before falling back to the repository root", async () => {
  vi.stubEnv("USER", "test-user");
  vi.stubEnv("USERNAME", "test-user");
  try {
    await withWorkspace(async ({ repo, skill, write }) => {
      const personal = path.join(repo, "personal", "test-user");
      const preferred = await skill(personal, "personal-audit", "audit");
      await skill(repo, "repo-audit", "audit");
      const fallback = await skill(repo, "fallback");
      await write(path.join(repo, ".gemini", "config.json"), JSON.stringify({ personal_customization_dir: "personal/{user}" }));
      await write(path.join(personal, ".agents", "skills.json"), JSON.stringify({
        entries: [{ path: "audit" }, { path: "fallback/SKILL.md" }],
      }));
      const { registry } = createKimiAcpRegistry({ acpBackendId: backend });
      const { data } = await registry.listSkills({ backend, cwd: repo, catalog: "skills" });
      expect(data[0]?.skills.map(({ path }) => path)).toEqual([preferred, fallback]);
    });
  } finally {
    vi.unstubAllEnvs();
  }
});

it("discovers workspace skills when the current UID has no username", async () => {
  vi.stubEnv("USER", undefined);
  vi.stubEnv("USERNAME", undefined);
  const userInfo = vi.spyOn(os, "userInfo").mockImplementation(() => {
    throw Object.assign(new Error("No entry for UID"), { code: "ERR_SYSTEM_ERROR" });
  });
  try {
    await withWorkspace(async ({ repo, skill, write }) => {
      const workspace = await skill(path.join(repo, ".agents", "skills"), "workspace");
      await write(path.join(repo, ".gemini", "config.json"), JSON.stringify({ personal_customization_dir: "personal/{user}" }));
      const { registry } = createKimiAcpRegistry({ acpBackendId: backend });
      const { data } = await registry.listSkills({ backend, cwd: repo, catalog: "skills" });
      expect(data[0]?.skills.map(({ path }) => path)).toEqual([workspace]);
    });
  } finally {
    userInfo.mockRestore();
    vi.unstubAllEnvs();
  }
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

it("uses the owner’s handoff destination even when both the ACP session and the viewer still name the source", async () => {
  await withWorkspace(async ({ cwd, repo, skill }) => {
    const target = path.join(repo, "destination");
    await skill(path.join(cwd, ".agents", "skills"), "source-only");
    const destination = await skill(path.join(target, ".agents", "skills"), "destination-only");
    const overlayStore = createOverlayStoreMock();
    const { registry, acpClient } = createKimiAcpRegistry({ acpBackendId: backend, overlayStore });
    const session = await acpClient.startSession({ cwd, executionMode: "default" });
    await overlayStore.replaceWorkspaceLinkedDirectory({
      backend, threadId: session.sessionId, gitBranch: "HEAD",
      directory: {
        id: `pwragent-handoff:${backend}:${session.sessionId}`,
        path: repo, worktreePath: target, label: "Destination", kind: "worktree",
      },
    });
    const owner = await registry.resolveThreadPrimaryDirectory(backend, session.sessionId);
    expect(owner?.worktreePath).toBe(target);
    const { data } = await registry.listSkills({
      backend, threadId: session.sessionId, cwd, cwds: [cwd], catalog: "skills",
    });
    expect(data.map(({ cwd, skills }) => [cwd, skills.map(({ path }) => path)])).toEqual([
      [owner?.worktreePath, [destination]],
    ]);
  });
});

it("matches Antigravity's plugin validator for default and additional skill directories", async () => {
  await withWorkspace(async ({ repo, skill, write }) => {
    const plugins = path.join(repo, ".agents", "plugins");
    const plugin = path.join(plugins, "garden");
    const standard = await skill(path.join(plugin, "skills"), "ordinary");
    const extra = await skill(path.join(plugin, "more"), "extra");
    await skill(path.join(plugins, "unmanifested", "skills"), "ignored");
    await write(path.join(plugin, "plugin.json"), JSON.stringify({
      name: "garden", description: "Garden fixture", version: "1.0.0", skills: ["./more"],
    }));
    const { registry } = createKimiAcpRegistry({ acpBackendId: backend });
    const { data } = await registry.listSkills({ backend, cwd: repo, catalog: "skills" });
    expect(data[0]?.skills.map(({ name, path }) => [name, path]).sort()).toEqual([
      ["garden:extra", extra], ["garden:ordinary", standard],
    ]);
  });
});

it("keeps standard skill folders visible alongside an unrelated root SKILL.md", async () => {
  await withWorkspace(async ({ repo, skill, write }) => {
    const skillRoot = path.join(repo, ".agents", "skills");
    await write(path.join(skillRoot, "SKILL.md"), "Unrelated notes.");
    const child = await skill(skillRoot, "child");
    const { registry } = createKimiAcpRegistry({ acpBackendId: backend });
    const { data } = await registry.listSkills({ backend, cwd: repo, catalog: "skills" });
    expect(data[0]?.skills.map(({ path }) => path)).toEqual([child]);
  });
});
