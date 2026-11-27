import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AppServerThreadSummary, LinkedDirectorySummary } from "@pwragent/shared/contracts/normalized-app-server";
import {
  createOverlayStoreMock,
  git,
  mockArchiveWorktreePresence,
  MockBackendClient,
} from "./helpers/backend-registry-fixture";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import type { ThreadArchiveCoordinator } from "../app-server/thread-archive-coordinator";

const target = { backend: "codex" as const, threadId: "target" };
const repository = join(tmpdir(), "pwragent-send-request-fixture");
const missingWorktree = join(repository, ".codex", "worktrees", "old", "fixture");
const attachedWorktree = join(repository, ".codex", "worktrees", "new", "fixture");
const worktree = (worktreePath: string): LinkedDirectorySummary => ({
  id: worktreePath, kind: "worktree", label: "Fixture", path: repository, worktreePath,
});

const sendRequest = {
  sourceBackend: "codex" as const, sourceThreadId: "sender", target,
  prompt: "Check the build output",
  todo: { id: "request", title: "Check the build output" },
};

function fixture(linkedDirectories: LinkedDirectorySummary[], overlayDirectories: LinkedDirectorySummary[] = [], gitBranch?: string) {
  const thread: AppServerThreadSummary = {
    ...target, id: target.threadId, source: "codex", title: "Build", titleSource: "explicit",
    projectKey: linkedDirectories[0]?.worktreePath ?? missingWorktree, linkedDirectories, threadStatus: "notLoaded", gitBranch,
  };
  const codexClient = new MockBackendClient({ threads: [thread], archivedThreads: [] });
  const overlayStore = createOverlayStoreMock({
    overlays: { "codex:target": { ...target, executionMode: "default", extraLinkedDirectories: overlayDirectories } },
  });
  const registry = createDesktopBackendRegistry({
    codexClient, overlayStore, messagingStore: null, threadTitleGenerationService: null,
  });
  return { registry, codexClient };
}

describe("Send Request worktree admission", () => {
  it.each([true, false])("recreates the recorded checkout before Codex starts (saved branch exists: %s)", async (branchExists) => {
    const root = await mkdtemp(join(tmpdir(), "pwragent-request-recreate-"));
    const repo = join(root, "repo");
    const checkout = join(root, ".codex", "worktrees", "old", "repo");
    const branch = "feature/recover";
    const { registry, codexClient } = fixture([{ ...worktree(checkout), path: repo }], [], branch);
    try {
      await mkdir(repo);
      await git(repo, ["init", "-b", "main"]);
      await writeFile(join(repo, "work.txt"), "main");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "main"]);
      const mainHead = (await git(repo, ["rev-parse", "HEAD"])).trim();
      await git(repo, ["switch", "-c", branch]);
      await writeFile(join(repo, "work.txt"), "branch");
      await git(repo, ["commit", "-am", "branch"]);
      const branchHead = (await git(repo, ["rev-parse", "HEAD"])).trim();
      await git(repo, ["switch", "main"]);
      if (!branchExists) await git(repo, ["branch", "-D", branch]);
      const start = codexClient.startTurn.bind(codexClient);
      vi.spyOn(codexClient, "startTurn").mockImplementation(async (params) => {
        expect(params.cwd).toBe(checkout);
        expect((await git(checkout, ["rev-parse", "HEAD"])).trim()).toBe(branchExists ? branchHead : mainHead);
        return await start(params);
      });

      await registry.sendThreadTodoMessage(sendRequest);
      expect(codexClient.startTurnCalls).toHaveLength(1);
      expect((await git(checkout, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe(branchExists ? branch : "HEAD");
      expect((await git(repo, ["rev-parse", "HEAD"])).trim()).toBe(mainHead);
    } finally {
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses an absent primary worktree whose repository is unavailable even when another attached worktree exists", async () => {
    await mockArchiveWorktreePresence([attachedWorktree]);
    const { registry, codexClient } = fixture([worktree(missingWorktree)], [worktree(attachedWorktree)]);
    const starts: string[] = [];
    registry.onEvent(({ notification }) => {
      if (notification.method === "turn/started") starts.push(notification.params.threadId);
    });
    try {
      await expect(registry.sendThreadTodoMessage(sendRequest)).rejects.toThrow(/worktree.*missing/i);
      expect(codexClient.startTurnCalls).toHaveLength(0);
      expect(starts).toEqual([]);
    } finally {
      await registry.close();
    }
  });

  it("waits for a shared checkout's recovery even after its directory appears", async () => {
    await mockArchiveWorktreePresence([missingWorktree]);
    const { registry, codexClient } = fixture([worktree(missingWorktree)]);
    const { threadArchiveCoordinator } = registry as unknown as { threadArchiveCoordinator: ThreadArchiveCoordinator };
    const takeLock = threadArchiveCoordinator.withCheckoutRecovery.bind(threadArchiveCoordinator);
    const restoreReady = Promise.withResolvers<void>();
    let restored = false;
    const recovery = takeLock(missingWorktree, async () => {
      await restoreReady.promise;
      restored = true;
    });
    const joined = Promise.withResolvers<void>();
    const check = vi.spyOn(threadArchiveCoordinator, "withCheckoutRecovery").mockImplementation((cwd, work) => {
      joined.resolve();
      return takeLock(cwd, async () => {
        expect(restored).toBe(true);
        return await work();
      });
    });
    const sent = registry.sendThreadTodoMessage(sendRequest);
    try {
      await Promise.race([joined.promise, sent]);
      expect(check).toHaveBeenCalled();
      expect(codexClient.startTurnCalls).toHaveLength(0);
      restoreReady.resolve();
      await sent;
      expect(codexClient.startTurnCalls).toHaveLength(1);
    } finally {
      restoreReady.resolve();
      await Promise.allSettled([recovery, sent]);
      await registry.close();
    }
  });

  it("sends from a committed local handoff even when the former worktree is absent", async () => {
    const { registry, codexClient } = fixture([worktree(missingWorktree)], [{
      id: "pwragent-handoff:local", kind: "local", label: "Fixture", path: repository,
    }]);
    try {
      await registry.sendThreadTodoMessage(sendRequest);
      expect(codexClient.startTurnCalls.map((turn) => turn.cwd)).toEqual([repository]);
    } finally {
      await registry.close();
    }
  });
});
