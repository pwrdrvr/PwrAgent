import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { AppServerThreadSummary } from "@pwragent/shared/contracts/normalized-app-server";
import type { NavigationLaunchpadDraft } from "@pwragent/shared/contracts/navigation";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import { listBackgroundCodexEnvironmentOptions } from "../app-server/codex-environment-config";
import { createOverlayStoreMock, MockBackendClient } from "./helpers/backend-registry-fixture";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn(actual.stat) };
});

async function coldOwner() {
  const root = await mkdtemp(path.join(tmpdir(), "pwragent-cold-environments-"));
  const worktrees = ["blocked-1", "blocked-2", "blocked-3", "turn-1", "turn-2"]
    .map((id) => ({ id, cwd: path.join(root, id) }));
  const environmentDir = (cwd: string) => path.join(cwd, ".codex", "environments");
  const blockedPaths = new Set(worktrees.slice(0, 3).map(({ cwd }) => environmentDir(cwd)));
  const turnWorktrees = worktrees.slice(3);
  for (const { cwd } of turnWorktrees) {
    await mkdir(environmentDir(cwd), { recursive: true });
    await writeFile(path.join(environmentDir(cwd), "fixture.toml"), 'name = "Fixture"\n');
  }
  const threads: AppServerThreadSummary[] = worktrees.map(({ id, cwd }) => ({
    id, source: "codex", title: id, titleSource: "explicit", projectKey: cwd,
    linkedDirectories: [{ id: cwd, kind: "worktree", label: id, path: root, worktreePath: cwd }],
  }));
  const codexClient = new MockBackendClient({ threads, archivedThreads: [] });
  vi.spyOn(codexClient, "startThread").mockImplementation(async ({ cwd } = {}) => ({
    threadId: `new-${path.basename(cwd ?? root)}`,
  }));
  const registry = createDesktopBackendRegistry({
    codexClient, overlayStore: createOverlayStoreMock(), messagingStore: null,
    pdfToolMcpServer: null, threadTitleGenerationService: null,
    gitDirectoryService: {
      prepareLaunchpadWorkspace: async (draft: NavigationLaunchpadDraft) => ({
        cwd: draft.directoryPath, workMode: "local",
      }),
    } as never,
  });
  const firstRead = Promise.withResolvers<void>();
  const releaseReads = Promise.withResolvers<void>();
  const blockedReads: string[] = [];
  const previousStat = vi.mocked(stat).getMockImplementation()!;
  vi.mocked(stat).mockImplementation(async (target, options) => {
    if (typeof target === "string" && blockedPaths.has(target)) {
      blockedReads.push(target);
      firstRead.resolve();
      await releaseReads.promise;
    }
    return await previousStat(target, options);
  });
  return {
    registry, blockedReads, firstRead: firstRead.promise, releaseReads: releaseReads.resolve,
    providerListCalls: () => codexClient.listThreadsCallCount,
    waitingCwd: worktrees[2].cwd, environmentDir,
    startTurns: async () => {
      await Promise.all(turnWorktrees.map(({ id }) => registry.startTurn({
        backend: "codex", threadId: id, input: [{ type: "text", text: "Continue" }],
      })));
      return codexClient.startTurnCalls.map(({ cwd }) => cwd).sort();
    },
    expectedCwds: turnWorktrees.map(({ cwd }) => cwd).sort(),
    startFirstTurn: (cwd: string, codexEnvironmentId?: string) => {
      const directoryKey = `directory:${cwd}`;
      return registry.materializeDirectoryLaunchpad({ directoryKey, launchpad: {
        directoryKey, directoryKind: "directory", directoryLabel: "Fixture", directoryPath: cwd,
        backend: "codex", executionMode: "default", prompt: "Start", workMode: "local",
        createdAt: 1, updatedAt: 1, codexEnvironmentId,
      } });
    },
    close: async () => {
      releaseReads.resolve();
      vi.mocked(stat).mockImplementation(previousStat);
      await registry.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it("starts turns from cold workspace metadata without discovering environments", async () => {
  const fixture = await coldOwner();
  const turns = fixture.startTurns();
  try {
    // A metadata lookup needs the provider CWD even if an unrelated mount
    // would block any attempt to discover its environment choices.
    await expect(Promise.race([turns, fixture.firstRead])).resolves.toEqual(fixture.expectedCwds);
    expect(fixture.blockedReads).toEqual([]);
    fixture.releaseReads();
    const threads = await fixture.registry.listThreads({ backend: "codex" });
    expect(threads.find(({ id }) => id === "turn-1")).toMatchObject({
      codexEnvironmentOptions: [{ id: "fixture", name: "Fixture" }],
    });
  } finally {
    fixture.releaseReads();
    await turns.catch(() => {});
    await fixture.close();
  }
});

it.each(["background", "foreground"] as const)("keeps first-send discovery independent when %s starts first", async (first) => {
  const fixture = await coldOwner();
  const [selectedCwd, plainCwd] = fixture.expectedCwds;
  const foregroundEntered = Promise.withResolvers<"entered">();
  const releaseForeground = Promise.withResolvers<void>();
  const previousStat = vi.mocked(stat).getMockImplementation()!;
  const list = () => fixture.registry.listThreads({ backend: "codex" });
  vi.mocked(stat).mockImplementation(async (target, options) => {
    if (target === fixture.environmentDir(selectedCwd)) {
      foregroundEntered.resolve("entered");
      await releaseForeground.promise;
    }
    if (target === fixture.environmentDir(plainCwd)) throw new Error("Unconfigured first send inspected environments");
    return await previousStat(target, options);
  });
  let listing: ReturnType<typeof list> | undefined;
  let selected: ReturnType<typeof fixture.startFirstTurn> | undefined;
  try {
    if (first === "background") {
      listing = list();
      await fixture.firstRead;
    }
    selected = fixture.startFirstTurn(selectedCwd, "fixture");
    // The selected launch can reach its native slot while both bulk stats wait.
    await expect(Promise.race([foregroundEntered.promise, selected])).resolves.toBe("entered");
    if (first === "foreground") {
      listing = list();
      await fixture.firstRead;
    }
    expect(fixture.blockedReads).toHaveLength(2);
    // A launch without an environment starts even while both lanes are occupied.
    await expect(fixture.startFirstTurn(plainCwd)).resolves.toMatchObject({ turnId: expect.any(String) });
    releaseForeground.resolve();
    await expect(selected).resolves.toMatchObject({ codexEnvironmentRuntime: { environmentId: "fixture" } });
    expect(fixture.blockedReads).toHaveLength(2);
  } finally {
    releaseForeground.resolve();
    fixture.releaseReads();
    await Promise.allSettled([listing, selected]);
    await fixture.close();
  }
});

it.each(["codex", undefined] as const)("retries a timed-out environment listing without declaring provider rows incomplete (backend: %s)", async (backend) => {
  const fixture = await coldOwner();
  fixture.releaseReads();
  const target = fixture.environmentDir(fixture.expectedCwds[0]);
  const previousStat = vi.mocked(stat).getMockImplementation()!;
  let fail = true;
  vi.mocked(stat).mockImplementation(async (statPath, options) => {
    if (statPath === target && fail) throw Object.assign(new Error("mount timed out"), { code: "ETIMEDOUT" });
    return await previousStat(statPath, options);
  });
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    const list = () => fixture.registry.listThreads({ backend });
    const first = await list();
    expect(fixture.registry.isIncompleteThreadList(first)).toBe(false);
    expect(first).toContainEqual(expect.objectContaining({ id: "turn-1" }));
    expect(first.find(({ id }) => id === "turn-1")).not.toHaveProperty("codexEnvironmentOptions");
    fail = false;
    expect(await list()).toBe(first);
    clock.mockReturnValue(now + 5_001);
    expect(await list()).toContainEqual(expect.objectContaining({
      id: "turn-1", codexEnvironmentOptions: [expect.objectContaining({ id: "fixture" })],
    }));
  } finally {
    clock.mockRestore();
    await fixture.close();
  }
});

it("bounds blocked environment stats on a cold list while turns use workspace metadata", async () => {
  const fixture = await coldOwner();
  const listing = fixture.registry.listThreads({ backend: "codex" });
  try {
    await fixture.firstRead;
    // Three distinct stale checkouts are enough to cross the physical cap.
    expect(fixture.blockedReads.length).toBeLessThanOrEqual(2);
    await expect(fixture.startTurns()).resolves.toEqual(fixture.expectedCwds);
    // Both projections can use the same provider rows while discovery is blocked.
    expect(fixture.providerListCalls()).toBe(1);
    expect(fixture.blockedReads.length).toBeLessThanOrEqual(2);
    fixture.releaseReads();
    expect(await listing).toContainEqual(expect.objectContaining({
      id: "turn-1", codexEnvironmentOptions: [expect.objectContaining({ id: "fixture" })],
    }));
  } finally {
    fixture.releaseReads();
    await listing.catch(() => {});
    await fixture.close();
  }
});

it("expires queued discovery and holds native slots until their blocked stats settle", async () => {
  const fixture = await coldOwner();
  const listing = fixture.registry.listThreads({ backend: "codex" });
  try {
    await fixture.firstRead;
    expect(fixture.blockedReads).toHaveLength(2);
    const queuedRead = listBackgroundCodexEnvironmentOptions(fixture.waitingCwd);
    const [threads] = await Promise.all([
      listing,
      expect(queuedRead).rejects.toMatchObject({ code: "ETIMEDOUT" }),
    ]);
    expect(threads).toHaveLength(5);
    for (const thread of threads) expect(thread).not.toHaveProperty("codexEnvironmentOptions");
    const retry = listBackgroundCodexEnvironmentOptions(fixture.waitingCwd);
    // Caller deadlines have elapsed. The two physical stats still own the slots.
    expect(fixture.blockedReads).toHaveLength(2);
    fixture.releaseReads();
    await expect(retry).resolves.toEqual([]);
    // Only the fresh request starts once a slot opens.
    expect(fixture.blockedReads).toHaveLength(3);
  } finally {
    fixture.releaseReads();
    await listing.catch(() => {});
    await fixture.close();
  }
});
