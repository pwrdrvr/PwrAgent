import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServerThreadSummary } from "@pwragent/shared/contracts/normalized-app-server";
import {
  discoverRecentProjects,
  RECENT_PROJECT_MAX_FOLDERS,
  RECENT_PROJECT_MAX_PROJECTS,
  type RecentProjectDiscoveryDeps,
} from "../onboarding/recent-project-discovery";
import {
  importOnboardingProjectSeed,
  ONBOARDING_PROJECT_SEED_FILE,
  writeOnboardingProjectSeed,
} from "../onboarding/onboarding-project-seed";

function thread(overrides: Partial<AppServerThreadSummary>): AppServerThreadSummary {
  return {
    id: "thread",
    title: "Thread",
    titleSource: "explicit",
    linkedDirectories: [],
    source: "claude",
    ...overrides,
  };
}

function deps(overrides: Partial<RecentProjectDiscoveryDeps>): RecentProjectDiscoveryDeps {
  return {
    includeCodex: true,
    platform: "linux",
    labelFor: (agent) => (agent === "codex" ? "Codex" : agent === "claude" ? "Claude Code" : agent),
    resolveProjectRoot: async (folder) => folder,
    ...overrides,
  };
}

describe("discoverRecentProjects", () => {
  it("reports Codex as partial when its page budget ran out", async () => {
    const result = await discoverRecentProjects(deps({
      readCodexDirectories: async () => ({
        directories: [{ cwd: "/home/dev/shop", updatedAt: 5 }],
        complete: false,
      }),
    }));
    expect(result.observations).toEqual([{ path: "/home/dev/shop", agent: "codex", lastActiveAt: 5 }]);
    expect(result.sources).toEqual([expect.objectContaining({ agent: "codex", status: "partial" })]);
  });

  it("reports a Codex read that failed, and still returns other agents' projects", async () => {
    const result = await discoverRecentProjects(deps({
      readCodexDirectories: async () => { throw new Error("app-server exited"); },
      listPwrAgentThreads: async () => [thread({ projectKey: "/home/dev/blog", updatedAt: 9 })],
    }));
    expect(result.sources).toEqual([
      { agent: "codex", label: "Codex", status: "failed", detail: "app-server exited" },
      { agent: "claude", label: "Claude Code", status: "complete" },
    ]);
    expect(result.observations).toEqual([{ path: "/home/dev/blog", agent: "claude", lastActiveAt: 9 }]);
  });

  it("does not read Codex for a profile with its own Codex login", async () => {
    const readCodexDirectories = vi.fn();
    const result = await discoverRecentProjects(deps({ includeCodex: false, readCodexDirectories }));
    expect(readCodexDirectories).not.toHaveBeenCalled();
    expect(result.sources).toEqual([expect.objectContaining({ agent: "codex", status: "skipped" })]);
  });

  it("skips Codex threads and archived threads from PwrAgent's own lists", async () => {
    const result = await discoverRecentProjects(deps({
      includeCodex: false,
      listPwrAgentThreads: async () => [
        thread({ source: "codex", projectKey: "/home/dev/codex-only", updatedAt: 1 }),
        thread({ projectKey: "/home/dev/archived", archivedAt: 3, updatedAt: 3 }),
        thread({
          source: "acp:gemini",
          linkedDirectories: [{ id: "d", kind: "local", label: "api", path: "/home/dev/api" }],
          updatedAt: 4,
        }),
      ],
    }));
    expect(result.observations).toEqual([{ path: "/home/dev/api", agent: "acp:gemini", lastActiveAt: 4 }]);
  });

  it("resolves worktree folders to their repository and drops folders that are gone", async () => {
    const result = await discoverRecentProjects(deps({
      readCodexDirectories: async () => ({
        complete: true,
        directories: [
          { cwd: "/home/dev/.worktrees/shop-a", updatedAt: 7 },
          { cwd: "/home/dev/shop", updatedAt: 3 },
          { cwd: "/home/dev/deleted", updatedAt: 9 },
        ],
      }),
      resolveProjectRoot: async (folder) => folder === "/home/dev/deleted"
        ? undefined
        : folder.includes("shop") ? "/home/dev/shop" : folder,
    }));
    expect(result.observations).toEqual([{ path: "/home/dev/shop", agent: "codex", lastActiveAt: 7 }]);
  });

  it("lists only the newest projects and says the read was partial", async () => {
    const resolveProjectRoot = vi.fn(async (folder: string) => folder);
    const total = RECENT_PROJECT_MAX_PROJECTS + 5;
    const result = await discoverRecentProjects(deps({
      readCodexDirectories: async () => ({
        complete: true,
        directories: Array.from({ length: total }, (_, index) => ({ cwd: `/home/dev/p${index}`, updatedAt: index })),
      }),
      resolveProjectRoot,
    }));
    expect(result.observations).toHaveLength(RECENT_PROJECT_MAX_PROJECTS);
    expect(resolveProjectRoot).toHaveBeenCalledTimes(RECENT_PROJECT_MAX_PROJECTS);
    expect(result.observations.some((observation) => observation.path === "/home/dev/p0")).toBe(false);
    expect(result.observations.some((observation) => observation.path === `/home/dev/p${total - 1}`)).toBe(true);
    expect(result.sources).toEqual([expect.objectContaining({ agent: "codex", status: "partial" })]);
  });

  it("does not spend the project budget on deleted folders or extra worktrees", async () => {
    // The newest 80 folders: deleted checkouts, and worktrees of one repository.
    const directories = Array.from({ length: 80 }, (_, index) => ({
      cwd: index % 2 === 0 ? `/home/dev/.worktrees/gone-${index}` : `/home/dev/.worktrees/shop-${index}`,
      updatedAt: 1_000 + index,
    }));
    for (let index = 0; index < 10; index += 1) directories.push({ cwd: `/home/dev/repo-${index}`, updatedAt: index });
    const result = await discoverRecentProjects(deps({
      readCodexDirectories: async () => ({ complete: true, directories }),
      resolveProjectRoot: async (folder) => folder.includes("gone-")
        ? undefined
        : folder.includes("shop-") ? "/home/dev/shop" : folder,
    }));
    expect(result.observations.map((observation) => observation.path).sort()).toEqual([
      "/home/dev/repo-0", "/home/dev/repo-1", "/home/dev/repo-2", "/home/dev/repo-3", "/home/dev/repo-4",
      "/home/dev/repo-5", "/home/dev/repo-6", "/home/dev/repo-7", "/home/dev/repo-8", "/home/dev/repo-9",
      "/home/dev/shop",
    ]);
    expect(result.sources).toEqual([{ agent: "codex", label: "Codex", status: "complete" }]);
  });

  it("stops after checking the folder budget, and says so", async () => {
    const resolveProjectRoot = vi.fn(async () => undefined);
    const result = await discoverRecentProjects(deps({
      readCodexDirectories: async () => ({
        complete: true,
        directories: Array.from({ length: RECENT_PROJECT_MAX_FOLDERS + 3 }, (_, index) => ({ cwd: `/gone/${index}`, updatedAt: index })),
      }),
      resolveProjectRoot,
    }));
    expect(resolveProjectRoot).toHaveBeenCalledTimes(RECENT_PROJECT_MAX_FOLDERS);
    expect(result.sources).toEqual([expect.objectContaining({ agent: "codex", status: "partial" })]);
  });

  it("does not call a read partial for a thread started at the filesystem root", async () => {
    const result = await discoverRecentProjects(deps({
      readCodexDirectories: async () => ({
        complete: true,
        directories: [{ cwd: "/", updatedAt: 2 }, { cwd: "/home/dev/shop", updatedAt: 1 }],
      }),
    }));
    expect(result.observations).toEqual([{ path: "/home/dev/shop", agent: "codex", lastActiveAt: 1 }]);
    expect(result.sources).toEqual([{ agent: "codex", label: "Codex", status: "complete" }]);
  });
});

describe("onboarding project seed", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })));
  });

  async function profileDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pwragent-project-seed-"));
    dirs.push(dir);
    return dir;
  }

  it("registers each seeded folder once, in order, then removes the seed", async () => {
    const dir = await profileDir();
    writeOnboardingProjectSeed(dir, ["/home/dev/shop", " /home/dev/blog ", "/home/dev/shop", ""]);
    const register = vi.fn(async (folder: string) => folder === "/home/dev/blog"
      ? { ok: false as const, message: "gone" }
      : { ok: true as const });
    const result = await importOnboardingProjectSeed(dir, register);
    expect(register.mock.calls.map(([folder]) => folder)).toEqual(["/home/dev/shop", "/home/dev/blog"]);
    expect(result).toEqual({ registered: ["/home/dev/shop"], failed: [{ path: "/home/dev/blog", message: "gone" }] });
    expect(await readdir(dir)).toEqual([]);
    expect(await importOnboardingProjectSeed(dir, register)).toBeUndefined();
    expect(register).toHaveBeenCalledTimes(2);
  });

  it("writes nothing when no folder is checked", async () => {
    const dir = await profileDir();
    writeOnboardingProjectSeed(dir, []);
    expect(await readdir(dir)).toEqual([]);
  });

  it("drops a seed it cannot read without registering anything", async () => {
    const dir = await profileDir();
    await writeFile(path.join(dir, ONBOARDING_PROJECT_SEED_FILE), "{not json", "utf8");
    const register = vi.fn();
    expect(await importOnboardingProjectSeed(dir, register)).toEqual({ registered: [], failed: [] });
    expect(register).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });
});
