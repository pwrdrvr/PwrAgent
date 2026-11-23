import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NavigationLaunchpadDraft, NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { buildDirectorySummaries, canonicalizeNavigationPath } from "@pwragent/shared/directory-navigation";
import { DEFAULT_PROJECT_FORGE_AUTOMATION } from "@pwragent/shared/project-forge-automation";
import { projectNavigationQuery } from "@pwragent/owner-core/navigation-query-projection";
import { resolveNavigationWorktreeProjects } from "../app-server/navigation-worktree-projects";
import { resolvePendingWindowsDirectoryKey } from "../app-server/navigation-windows-directory-aliases";
import { ProjectForgeAutomationIndex } from "../app-server/project-forge-automation-index";

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
      const keys = [legacy.directoryKey, saved.directoryKey];
      const scopedReads = keys.map((directoryKey) => projectNavigationQuery({ index, request: {
        protocol: 2, consumer: "main-sidebar", inventory: "owner", query: { kind: "directory", directoryKey },
      } }));
      const messages = [reportedPath, diskPath].map((directoryKey) => projectNavigationQuery({ index, request: {
        protocol: 2, consumer: "messaging-browse", inventory: "owner", query: { kind: "messaging-threads", directoryKey },
      } }));
      for (const scoped of [...scopedReads, ...messages]) {
        expect(scoped.entries.map(({ row }) => row.id).sort()).toEqual(["1", "2"]);
        expect(scoped.selectionDirectory?.key).toBe(saved.directoryKey);
      }
    },
  ));
});

it("keeps a saved alias pause effective for the row and its threads", async () => {
  vi.mocked(realpath).mockResolvedValue("C:\\Aa");
  const threads = [thread("1", "c:/aa"), thread("2", "C:/Aa")];
  const saved = registration("C:/Aa");
  const paused = { ...DEFAULT_PROJECT_FORGE_AUTOMATION, paused: true, pausedAt: 5 };
  const overlays = { "directory:c:/aa": { directoryKey: "directory:c:/aa", forgeAutomation: paused } };
  const dirs = buildDirectorySummaries({ threads, launchpadsByKey: { [saved.directoryKey]: saved }, directoryOverlayByKey: overlays });
  const projects = await resolveNavigationWorktreeProjects(dirs, { threads });
  expect(projects.directories).toMatchObject([{ forgeAutomation: paused, threadKeys: ["codex:2", "codex:1"] }]);
  const automation = new ProjectForgeAutomationIndex();
  automation.hydrate(overlays);
  automation.rememberDirectories(projects.directories);
  for (const id of ["1", "2"]) expect(automation.automationForThread({ backend: "codex", threadId: id })).toEqual(paused);
  expect(automation.automationForThread({ backend: "codex", threadId: "new" },
    () => ({ linkedDirectories: threads[1]!.linkedDirectories }))).toEqual(paused);
});

it("resolves a folded directory key in a scoped children page", async () => {
  vi.mocked(realpath).mockResolvedValue("C:\\Aa");
  const parent = thread("1", "C:/Aa");
  const child = { ...thread("2", "c:/aa"), parentThreadId: parent.id, parentThreadBackend: "codex" as const };
  const threads = [parent, child];
  const saved = registration("C:/Aa");
  const projects = await resolveNavigationWorktreeProjects(buildDirectorySummaries({
    threads, launchpadsByKey: { [saved.directoryKey]: saved },
  }), { threads });
  for (const directoryKey of [saved.directoryKey, "directory:c:/aa"]) {
    const page = projectNavigationQuery({ index: { ...projects, threads }, request: {
      protocol: 2, consumer: "main-sidebar", inventory: "owner",
      query: { kind: "children", directoryKey, parent: { backend: "codex", threadId: parent.id } },
    } });
    expect(page.entries.map(({ row }) => row.id)).toEqual([child.id]);
    expect(page.selectionDirectory?.key).toBe(saved.directoryKey);
  }
});

it("uses the checkout group's stored spelling and exact membership for editing", async () => {
  vi.mocked(realpath).mockResolvedValue("C:\\Aa");
  const threads = [thread("1", "c:/aa"), thread("2", "C:/Aa")];
  const saved = registration("C:/Aa");
  const checkoutPaths = ["c:/aa", "C:/AnotherCheckout"];
  const dirs = buildDirectorySummaries({ threads, launchpadsByKey: { [saved.directoryKey]: saved },
    checkoutGroups: [{ preferredPath: "c:/aa", paths: checkoutPaths }],
  });
  expect((await resolveNavigationWorktreeProjects(dirs, { threads })).directories).toMatchObject([{
    path: "c:/aa", checkoutPaths,
  }]);
});

async function expectSecondaryCheckoutHome(name: string, layout: "alias" | "distinct" | "missing") {
  const preferredPath = "C:/Main";
  const checkoutPath = `C:/Checkouts/${name}`;
  const reportedPath = checkoutPath.toLowerCase();
  const projectKey = `directory:${preferredPath}`;
  const checkoutGroups = [{ preferredPath, paths: [preferredPath, checkoutPath] }];
  const threads = [thread("1", reportedPath)];
  vi.mocked(realpath).mockImplementation(async (target) => {
    if (layout === "missing" && target === reportedPath) throw new Error("ENOENT");
    return layout === "alias" ? checkoutPath : String(target);
  });
  const pendingKey = await resolvePendingWindowsDirectoryKey(
    `directory:${reportedPath.replaceAll("/", "\\")}`, new Map(), checkoutGroups,
  );
  const landed = await resolveNavigationWorktreeProjects(buildDirectorySummaries({ threads, checkoutGroups }), { threads });
  expect(landed.directories.find((directory) => directory.threadKeys.includes("codex:1"))?.key)
    .toBe(layout === "alias" ? projectKey : `directory:${reportedPath}`);
  expect(pendingKey).toBe(layout === "alias" ? projectKey : undefined);
}

it("uses filesystem identity to place case variants of secondary checkouts before and after landing", async () => {
  await fc.assert(fc.asyncProperty(
    fc.stringMatching(/^[A-Z][a-z]{1,8}$/), fc.constantFrom("alias", "distinct", "missing"), expectSecondaryCheckoutHome,
  ));
});

it("keeps a start from c:/checkouts/aa under C:/Main when it lands", async () => {
  await expectSecondaryCheckoutHome("Aa", "alias");
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
