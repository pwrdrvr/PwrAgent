import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AppServerThreadSummary, LinkedDirectorySummary } from "@pwragent/shared";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";

type Scenario = {
  archived: boolean;
  archiveTimestamp: boolean;
  pathSource: "project" | "provider" | "overlay";
  reads: boolean[];
};

async function checkGitReadBoundary(scenario: Scenario) {
  const db = openInMemoryStateDb();
  const overlayStore = new SqliteOverlayStore(db);
  const identity = { backend: "codex" as const, threadId: "retained-thread" };
  const worktreePath = path.join(os.tmpdir(), "fixture-retained-worktree");
  const directory: LinkedDirectorySummary = {
    id: worktreePath, kind: "worktree", label: "Retained checkout",
    path: path.join(os.tmpdir(), "fixture-repository"), worktreePath,
  };
  // Provider membership is the archive oracle. The owner's provider/overlay
  // links are the path oracle. Neither depends on which list was read first.
  const thread: AppServerThreadSummary = {
    id: identity.threadId, source: "codex", title: "Retained work", titleSource: "explicit",
    linkedDirectories: scenario.pathSource === "provider" ? [directory] : [],
    ...(scenario.pathSource === "project" ? { projectKey: worktreePath } : {}),
    ...(scenario.archived && scenario.archiveTimestamp ? { archivedAt: 1_000 } : {}),
  };
  const registry = new DesktopBackendRegistry({
    codexClient: {
      close: async () => {}, getInitializeResult: async () => ({ methods: [] }),
      onNotification: () => () => {}, onPendingRequest: () => () => {},
      listThreads: async (params: { archived?: boolean }) =>
        (params.archived === true) === scenario.archived ? [thread] : [],
      readConfiguredMcpServerNames: async () => [],
    } as never,
    overlayStore, threadTitleGenerationService: null,
  });
  const publishedHead = "a".repeat(40);
  try {
    if (scenario.pathSource === "overlay") {
      await overlayStore.addLinkedDirectory({ ...identity, directory });
    }
    await overlayStore.setThreadPullRequests({ ...identity, prs: [{
      provider: "github.com", org: "fixture", repo: "project", number: 1,
      state: "passing", lifecycleState: "open", headSha: publishedHead,
      url: "https://github.com/fixture/project/pull/1",
    }] });
    for (const archived of scenario.reads) {
      await registry.listThreads({ backend: "codex", archived, enrichDirectories: false });
    }
    expect(await registry.resolveThreadWorktreeGitReadContext({ ...identity, worktreePath }))
      .toEqual({ worktreePath, acceptedPushedCommitShas: [publishedHead] });
    expect(await registry.resolveThreadWorktreeGitReadContext({
      ...identity, worktreePath: path.join(worktreePath, "unlinked-checkout"),
    })).toBeUndefined();
    expect(await registry.resolveThreadWorktreeGitReadContext({
      ...identity, threadId: "unowned-thread", worktreePath,
    })).toBeUndefined();
    // A read-only fallback must never make the archived thread an active
    // destination for the message/card admission paths using resolveThread.
    expect((await registry.resolveThread(identity))?.id)
      .toBe(scenario.archived ? undefined : identity.threadId);
  } finally {
    await registry.close();
    db.close();
  }
}

describe("retained archived thread Git reads", () => {
  it("authorizes a retained archived checkout after an archived lookup warms the cache", async () => {
    await checkGitReadBoundary({ archived: true, archiveTimestamp: false, pathSource: "overlay", reads: [true] });
  });

  // Rule: archive membership and cache lookup order do not change read-only
  // access to the owner's linked checkout or widen it to any other checkout.
  it("preserves the owner's Git read boundary across archive membership and lookup order", async () => {
    await fc.assert(fc.asyncProperty(fc.record({
      archived: fc.boolean(), archiveTimestamp: fc.boolean(),
      pathSource: fc.constantFrom("project" as const, "provider" as const, "overlay" as const),
      reads: fc.array(fc.boolean(), { maxLength: 5 }),
    }), checkGitReadBoundary), { numRuns: 25 });
  });
});
