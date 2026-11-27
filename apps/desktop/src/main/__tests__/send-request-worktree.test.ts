import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AppServerThreadSummary, LinkedDirectorySummary } from "@pwragent/shared/contracts/normalized-app-server";
import {
  createOverlayStoreMock,
  mockArchiveWorktreePresence,
  MockBackendClient,
} from "./helpers/backend-registry-fixture";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";

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

function fixture(linkedDirectories: LinkedDirectorySummary[], overlayDirectories: LinkedDirectorySummary[] = []) {
  const thread: AppServerThreadSummary = {
    ...target, id: target.threadId, source: "codex", title: "Build", titleSource: "explicit",
    projectKey: missingWorktree, linkedDirectories, threadStatus: "notLoaded",
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
  it("refuses an absent primary worktree without a checkpoint even when another attached worktree exists", async () => {
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
