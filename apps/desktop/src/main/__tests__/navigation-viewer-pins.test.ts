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
  expect(projected.directories[0]).toMatchObject({ key: "directory:/repo", counts: { total: 1 }, pinnedRootCount: 1 });
  expect(viewer.threads.map((thread) => thread.title)).toEqual(["Local", "Remote"]);
});
