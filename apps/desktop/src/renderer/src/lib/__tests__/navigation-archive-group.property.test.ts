import fc from "fast-check";
import { expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { navigationQueryFixture } from "../../test/navigation-query-fixture";
import { readNavigationArchiveGroup } from "../navigation-archive-group";

it("retains diagnostic metadata from the owning instance instead of the viewer's stale row", async () => {
  await fc.assert(fc.asyncProperty(fc.uuid(), fc.uuid(), async (threadId, path) => {
    const owner: NavigationThreadSummary = {
      id: threadId, source: "codex", title: `Owner ${threadId}`, titleSource: "explicit", inbox: { inInbox: false },
      linkedDirectories: [{ id: "checkout", label: "Project", kind: "worktree",
        path: "/contrived/repository", worktreePath: `/contrived/worktrees/${path}` }],
    };
    const viewer = { ...owner, title: "Stale viewer title", linkedDirectories: [] };
    const members = await readNavigationArchiveGroup({ thread: viewer, api: {
      getNavigationQueryPage: async (request) => navigationQueryFixture(request, { threads: [request.inventory === "owner" ? owner : viewer] }),
    } });
    expect(members[0]).toMatchObject({ id: owner.id, source: owner.source, title: owner.title, linkedDirectories: owner.linkedDirectories });
  }), { numRuns: 25 });
});
