import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { AppServerThreadSummary } from "@pwragent/shared/contracts/normalized-app-server";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import { listCodexEnvironmentOptions } from "../app-server/codex-environment-config";
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
  const registry = createDesktopBackendRegistry({
    codexClient, overlayStore: createOverlayStoreMock(), messagingStore: null,
    pdfToolMcpServer: null, threadTitleGenerationService: null,
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
    waitingCwd: worktrees[2].cwd,
    startTurns: async () => {
      await Promise.all(turnWorktrees.map(({ id }) => registry.startTurn({
        backend: "codex", threadId: id, input: [{ type: "text", text: "Continue" }],
      })));
      return codexClient.startTurnCalls.map(({ cwd }) => cwd).sort();
    },
    expectedCwds: turnWorktrees.map(({ cwd }) => cwd).sort(),
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

it("bounds blocked environment stats on a cold list while turns use workspace metadata", async () => {
  const fixture = await coldOwner();
  const listing = fixture.registry.listThreads({ backend: "codex" });
  try {
    await fixture.firstRead;
    // Three distinct stale checkouts are enough to cross the physical cap.
    expect(fixture.blockedReads.length).toBeLessThanOrEqual(2);
    await expect(fixture.startTurns()).resolves.toEqual(fixture.expectedCwds);
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
    const directRead = listCodexEnvironmentOptions(fixture.waitingCwd);
    const [threads] = await Promise.all([
      listing,
      expect(directRead).rejects.toMatchObject({ code: "ETIMEDOUT" }),
    ]);
    expect(threads).toMatchObject(Array.from({ length: 5 }, () => ({ codexEnvironmentOptions: [] })));
    const retry = listCodexEnvironmentOptions(fixture.waitingCwd);
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
