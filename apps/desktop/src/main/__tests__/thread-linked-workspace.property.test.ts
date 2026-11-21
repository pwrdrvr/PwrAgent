import { createDesktopBackendRegistry, registryModules } from "../app-server/backend-registry-wiring";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type {
  AppServerThreadSummary,
  LinkedDirectorySummary,
} from "@pwragent/shared/contracts/normalized-app-server";

import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";

// The model: a few threads on this machine, each working in one of two
// worktrees, recorded by the provider, by the overlay, or as the project.
// Some are archived and some have a turn starting. The oracles are plain:
//
// - A directory may be changed for a thread only if that thread is not
//   archived and works there.
// - A worktree is busy when any unarchived thread working there has a turn,
//   whichever thread asks.
const WORKTREES = ["fixture-worktree-a", "fixture-worktree-b"].map((name) => path.join(os.tmpdir(), name));

type ThreadModel = {
  worktree: 0 | 1;
  pathSource: "project" | "provider" | "overlay";
  archived: boolean;
  active: boolean;
};

const threadArbitrary: fc.Arbitrary<ThreadModel> = fc.record({
  worktree: fc.constantFrom(0 as const, 1 as const),
  pathSource: fc.constantFrom("project" as const, "provider" as const, "overlay" as const),
  archived: fc.boolean(),
  active: fc.boolean(),
});

function directoryFor(worktreePath: string): LinkedDirectorySummary {
  return {
    id: worktreePath, kind: "worktree", label: path.basename(worktreePath),
    path: path.join(os.tmpdir(), "fixture-repository"), worktreePath,
  };
}

async function checkWorkspaceRules(models: ThreadModel[]) {
  const db = openInMemoryStateDb();
  const overlayStore = new SqliteOverlayStore(db);
  const threads = models.map((model, index): AppServerThreadSummary => ({
    id: `thread-${index}`, source: "codex", title: `Thread ${index}`, titleSource: "explicit",
    linkedDirectories: model.pathSource === "provider" ? [directoryFor(WORKTREES[model.worktree])] : [],
    ...(model.pathSource === "project" ? { projectKey: WORKTREES[model.worktree] } : {}),
    ...(model.archived ? { archivedAt: 1_000 } : {}),
  }));
  const registry = createDesktopBackendRegistry({
    codexClient: {
      close: async () => {}, getInitializeResult: async () => ({ methods: [] }),
      onNotification: () => () => {}, onPendingRequest: () => () => {},
      listThreads: async (params: { archived?: boolean }) =>
        threads.filter((_thread, index) => models[index].archived === (params.archived === true)),
      readConfiguredMcpServerNames: async () => [],
    } as never,
    overlayStore, threadTitleGenerationService: null,
  });
  try {
    for (const [index, model] of models.entries()) {
      const identity = { backend: "codex" as const, threadId: `thread-${index}` };
      if (model.pathSource === "overlay") {
        await overlayStore.addLinkedDirectory({ ...identity, directory: directoryFor(WORKTREES[model.worktree]) });
      }
      // A stored PR must not be needed, read, or canonicalized to authorize a path.
      await overlayStore.setThreadPullRequests({ ...identity, prs: [{
        provider: "github.com", org: "fixture", repo: "project", number: index + 1,
        state: "passing", lifecycleState: "open", headSha: "a".repeat(40),
        url: `https://github.com/fixture/project/pull/${index + 1}`,
      }] });
      if (model.active) registryModules(registry).turnState.reserveStart(identity.threadId, "agent");
    }

    for (const [index, model] of models.entries()) {
      const identity = { backend: "codex" as const, threadId: `thread-${index}` };
      for (const [which, worktreePath] of WORKTREES.entries()) {
        const resolved = await registry.resolveThreadLinkedWorkspace({ ...identity, worktreePath });
        if (model.archived || model.worktree !== which) {
          expect(resolved).toBeUndefined();
        } else {
          expect(resolved).toEqual({ worktreePath, workspacePaths: [worktreePath] });
        }
      }
    }

    for (const [which, worktreePath] of WORKTREES.entries()) {
      const busy = models.some((model) => model.active && !model.archived && model.worktree === which);
      expect(await registry.workspaceHasActiveTurn(worktreePath)).toBe(busy);
      // However the caller spells the directory.
      expect(await registry.workspaceHasActiveTurn(`${worktreePath}${path.sep}`)).toBe(busy);
    }
    expect(await registry.workspaceHasActiveTurn(path.join(WORKTREES[0], "src"))).toBe(false);
  } finally {
    await registry.close();
    db.close();
  }
}

describe("thread linked workspaces", () => {
  it("finds a turn running in a worktree from another thread that shares it", async () => {
    await checkWorkspaceRules([
      { worktree: 0, pathSource: "provider", archived: false, active: false },
      { worktree: 0, pathSource: "overlay", archived: false, active: true },
    ]);
  });

  it("does not authorize an archived thread's retained checkout for a change", async () => {
    await checkWorkspaceRules([{ worktree: 1, pathSource: "overlay", archived: true, active: false }]);
  });

  it("authorizes changes only for unarchived owners, and reports a worktree busy for every thread that shares it", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(threadArbitrary, { minLength: 1, maxLength: 4 }), checkWorkspaceRules),
      { numRuns: 30 },
    );
  });
});
