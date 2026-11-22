import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NavigationLaunchpadDraft, NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { buildDirectorySummaries, canonicalizeNavigationPath } from "@pwragent/shared/directory-navigation";
import { projectNavigationQuery } from "@pwragent/owner-core/navigation-query-projection";
import { resolveNavigationWorktreeProjects } from "../app-server/navigation-worktree-projects";

vi.mock("node:fs/promises", { spy: true });
vi.mock("../git-info/worktree-store", () => ({ resolveWorktreeRepositoryDirectory: async () => undefined }));

beforeEach(() => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
});

afterEach(() => {
  vi.mocked(realpath).mockReset();
  vi.restoreAllMocks();
});

function thread(id: string, folder: string): NavigationThreadSummary {
  return {
    id, source: "codex", title: id, titleSource: "derived", createdAt: Number(id) || 1,
    linkedDirectories: [{ id: folder, kind: "local", label: "Project", path: folder }],
    inbox: { inInbox: true, reason: "updated-since-seen" },
  };
}

function registration(folder: string): NavigationLaunchpadDraft {
  return {
    directoryKey: `directory:${folder}`, directoryKind: "directory",
    directoryLabel: folder.split("/").at(-1)!, directoryPath: folder,
    backend: "codex", executionMode: "default", workMode: "local",
    prompt: "", registeredAt: 1, createdAt: 1, updatedAt: 1,
  };
}

it("projects every case spelling of one Windows folder under its saved project", async () => {
  await fc.assert(fc.asyncProperty(
    fc.stringMatching(/^[A-Z][a-z]{1,8}$/), fc.boolean(), fc.boolean(),
    async (name, legacyRegistration, duplicateRegistration) => {
      const diskPath = `C:/${name}`;
      const reportedPath = diskPath.toLowerCase();
      const savedPath = legacyRegistration && !duplicateRegistration ? reportedPath : diskPath;
      const saved = registration(savedPath);
      const legacy = registration(reportedPath);
      const threads = [thread("1", reportedPath), thread("2", diskPath)];
      const launchpadsByKey = {
        ...(duplicateRegistration ? { [legacy.directoryKey]: legacy } : {}),
        [saved.directoryKey]: saved,
      };
      vi.mocked(realpath).mockResolvedValue(diskPath.replace(/\//g, "\\"));
      const projects = await resolveNavigationWorktreeProjects(buildDirectorySummaries({
        threads, launchpadsByKey, directoryOverlayByKey: {
          [saved.directoryKey]: { directoryKey: saved.directoryKey, pinnedRank: "1024", directoryThreadsCollapsed: true },
        },
      }), { threads });
      expect(projects.directories).toMatchObject([{
        key: saved.directoryKey, threadKeys: ["codex:2", "codex:1"], needsAttentionCount: 2,
        pinnedRank: "1024", directoryThreadsCollapsed: true, launchpad: { directoryKey: saved.directoryKey },
      }]);
      const index = { ...projects, threads };
      const page = projectNavigationQuery({ index, request: {
        protocol: 2, consumer: "star-map", inventory: "owner",
        query: { kind: "star-map", projectKey: saved.directoryKey, filters: {} },
      } });
      expect(page.entries.map(({ row }) => row.id).sort()).toEqual(["1", "2"]);
      const lookup = projectNavigationQuery({ index, request: {
        protocol: 2, consumer: "main-sidebar", inventory: "owner",
        query: { kind: "directory-index", keys: [legacy.directoryKey] },
      } });
      expect(lookup.directories?.map((row) => row.key)).toEqual([saved.directoryKey]);
    },
  ));
});

it("shows the c:/aa thread inside an existing C:/Aa registration", async () => {
  vi.mocked(realpath).mockResolvedValue("C:\\Aa");
  const threads = [thread("1", "c:/aa")];
  const saved = registration("C:/Aa");
  const dirs = buildDirectorySummaries({ threads, launchpadsByKey: { [saved.directoryKey]: saved } });
  expect(await resolveNavigationWorktreeProjects(dirs, { threads })).toMatchObject({
    directories: [{ key: "directory:C:/Aa", threadKeys: ["codex:1"], launchpad: { directoryKey: "directory:C:/Aa" } }],
    directoryCaseAliases: { "directory:C:/Aa": ["directory:c:/aa"] },
  });
});

it.each(["case-sensitive", "unavailable"])("keeps %s spellings separate", async (layout) => {
  vi.mocked(realpath).mockImplementation(async (target) => {
    if (layout === "unavailable" && target === "c:/aa") throw new Error("ENOENT");
    return String(target);
  });
  const threads = [thread("1", "c:/aa"), thread("2", "C:/Aa")];
  const directories = buildDirectorySummaries({ threads });
  expect(await resolveNavigationWorktreeProjects(directories, { threads })).toEqual({ directories });
});

it("keeps a peer placeholder separate from a local registration with the same path spelling", async () => {
  vi.mocked(realpath).mockResolvedValue("C:\\Aa");
  const saved = registration("C:/Aa");
  const directories = buildDirectorySummaries({ threads: [], launchpadsByKey: { [saved.directoryKey]: saved } });
  directories.push({
    key: "directory:c:/aa", kind: "directory", label: "Peer project", path: "c:/aa",
    localAvailability: "unconfigured", threadKeys: [], needsAttentionCount: 0,
  });
  expect(await resolveNavigationWorktreeProjects(directories, { threads: [] })).toEqual({ directories });
});

it.runIf(process.platform === "win32")("reconciles paths for a real Windows folder", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-navigation-case-")));
  try {
    const folder = path.join(root, "MixedCase");
    await mkdir(folder);
    const diskPath = canonicalizeNavigationPath(await realpath(folder));
    const reportedPath = canonicalizeNavigationPath(path.join(root, "mixedcase"));
    const threads = [thread("1", reportedPath)];
    const saved = registration(diskPath);
    const dirs = buildDirectorySummaries({ threads, launchpadsByKey: { [saved.directoryKey]: saved } });
    expect(await resolveNavigationWorktreeProjects(dirs, { threads })).toMatchObject({
      directories: [{ key: saved.directoryKey, threadKeys: ["codex:1"] }],
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
