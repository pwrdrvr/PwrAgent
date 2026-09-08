import { expect, it } from "vitest";
import { buildFederatedThreadRef, type NavigationThreadSummary } from "@pwragent/shared";
import { appendViewerNavigationPins } from "../app-server/navigation-viewer-pins";
import { projectNavigationQuery } from "../app-server/navigation-query-projection";

it("adds viewer-owned remote memberships without modifying the owner's index or colliding local identities", () => {
  const local: NavigationThreadSummary = { id: "same", source: "codex", title: "Local", titleSource: "explicit",
    linkedDirectories: [], inbox: { inInbox: false } };
  const remote: NavigationThreadSummary = { ...local, title: "Remote", pinnedRank: "viewer-rank",
    linkedDirectories: [{ id: "directory:/repo", kind: "local", label: "repo", path: "/repo" }],
    federation: { ref: buildFederatedThreadRef({ backend: "codex", threadId: "same", instanceId: "peer" }), instanceLabel: "Peer" } };
  const owner = { threads: [local], directories: [] };
  const viewer = appendViewerNavigationPins(owner, [remote]);
  expect(owner).toEqual({ threads: [local], directories: [] });
  const projected = projectNavigationQuery({ index: viewer, request: { protocol: 2, consumer: "main-sidebar",
    query: { kind: "directory-index" } } });
  expect(projected.counts.total).toBe(2);
  expect(projected.directories).toHaveLength(1);
  expect(projected.directories[0]).toMatchObject({ key: "unconfigured-directory:repo", counts: { total: 1 }, pinnedRootCount: 1 });
  expect(viewer.threads.map((thread) => thread.title)).toEqual(["Local", "Remote"]);
});


it("groups a remote parent with its local child across checkout paths and resolves the selected home", () => {
  const child: NavigationThreadSummary = { id: "child-m4", source: "codex", title: "Finish 2001", titleSource: "explicit",
    linkedDirectories: [{ id: "worktree", kind: "worktree", label: "PwrAgnt", path: "/m4/.codex/worktrees/task/PwrAgnt" }],
    parentThreadId: "parent-m5", parentThreadBackend: "codex", parentThreadInstanceId: "m5", inbox: { inInbox: true } };
  const parent: NavigationThreadSummary = { id: "parent-m5", source: "codex", title: "Parent", titleSource: "explicit", pinnedRank: "1024",
    projectKey: "/m5/.codex/worktrees/parent/PwrAgnt", linkedDirectories: [
      { id: "secondary", kind: "local", label: "Lab", path: "/m5/Lab" },
      { id: "parent-project", kind: "worktree", label: "PwrAgnt", path: "/m5/.codex/worktrees/parent/PwrAgnt" },
    ], inbox: { inInbox: false },
    federation: { ref: buildFederatedThreadRef({ backend: "codex", threadId: "parent-m5", instanceId: "m5" }), instanceLabel: "M5" } };
  const directory = { key: "directory:/m4/github/PwrAgnt", kind: "directory" as const, label: "PwrAgnt", path: "/m4/github/PwrAgnt",
    threadKeys: ["codex:child-m4"], needsAttentionCount: 1 };
  const viewer = appendViewerNavigationPins({ threads: [child], directories: [directory] }, [parent]);
  expect(viewer.directories).toHaveLength(1);
  expect(directory.threadKeys).toEqual(["codex:child-m4"]);
  const project = (query: import("@pwragent/shared").NavigationQuery) => projectNavigationQuery({ index: viewer,
    request: { protocol: 2, consumer: "main-sidebar", inventory: "viewer", query } });
  const roots = project({ kind: "directory", directoryKey: directory.key });
  expect(roots.entries.map((entry) => entry.row.id)).toEqual(["parent-m5"]);
  expect(roots.entries[0]?.row.viewerChildCount).toBe(1);
  const children = project({ kind: "children", parent: { backend: "codex", threadId: "parent-m5", ownerInstanceId: "m5" } });
  expect(children.entries.map((entry) => entry.row.id)).toEqual(["child-m4"]);
  const exact = project({ kind: "exact", identities: [{ backend: "codex", threadId: "child-m4" }], includeAncestry: true });
  expect(exact.entries.map((entry) => entry.row.id)).toEqual(["parent-m5", "child-m4"]);
  expect(exact.selectionDirectory?.key).toBe(directory.key);
});
