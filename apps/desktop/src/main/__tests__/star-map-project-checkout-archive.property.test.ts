import fc from "fast-check";
import { expect, it } from "vitest";
import { buildDirectorySummaries } from "@pwragent/shared/directory-navigation";
import {
  type NavigationThreadSummary,
  type ProjectCheckoutGroup,
} from "@pwragent/shared/contracts/navigation";
import { projectNavigationQuery } from "@pwragent/owner-core/navigation-query-projection";
import { groupThreadsByProject } from "../../renderer/src/features/star-map/star-map-projects";

const ORIGIN = "github.com/fixture/project";

function thread(path: string): NavigationThreadSummary {
  return {
    id: path, source: "codex", title: path, titleSource: "explicit", updatedAt: 1,
    linkedDirectories: [{ id: path, kind: "local", label: path.split("/").at(-1)!, path }],
    inbox: { inInbox: false },
  };
}

function geometry(threads: NavigationThreadSummary[], checkoutGroups: ProjectCheckoutGroup[] = []) {
  const gitStatusByKey = Object.fromEntries(threads.map(({ id }) => [
    `directory:${id}`, { originRepository: ORIGIN },
  ]));
  const directories = buildDirectorySummaries({ threads, checkoutGroups, gitStatusByKey });
  return projectNavigationQuery({
    index: { threads, directories },
    request: { protocol: 2, inventory: "owner", consumer: "star-map", query: { kind: "star-map-geometry" } },
  }).directories!;
}

function checkArchiveTransition(groupSize: number, excludedCount: number, keepArchivedInInventory: boolean) {
  const paths = Array.from({ length: groupSize }, (_, index) => `/local/group-${index}`);
  const group = { paths, preferredPath: paths[0], repositoryKey: ORIGIN };
  const excludedPaths = Array.from({ length: excludedCount }, (_, index) => `/local/excluded-${index}`);
  const peerPath = "/peer/project";
  const lastGroupedThread = thread(group.preferredPath);
  const archived = keepArchivedInInventory ? paths.slice(1).map((path) => ({ ...thread(path), archivedAt: 2 })) : [];
  const otherThreads = [...archived, ...excludedPaths.map(thread)];
  const afterArchive = keepArchivedInInventory ? [{ ...lastGroupedThread, archivedAt: 3 }, ...otherThreads] : otherThreads;
  const peer = geometry([thread(peerPath)]);
  const projectBodies = (threads: NavigationThreadSummary[]) => groupThreadsByProject(new Map(), {
    now: 3, descriptorsByInstance: new Map([["local", geometry(threads, [group])], ["peer", peer]]),
  });
  const before = projectBodies([lastGroupedThread, ...otherThreads]);
  const after = projectBodies(afterArchive);
  const fleetKey = `repo:${ORIGIN}`;

  for (const path of excludedPaths) {
    const member = { instanceId: "local", directoryKey: `directory:${path}` };
    const key = `checkout:${JSON.stringify([member.instanceId, member.directoryKey])}`;
    expect(before.find((body) => body.key === key)?.members).toEqual([member]);
    expect(after.find((body) => body.key === key)?.members).toEqual([member]);
  }
  expect(before.find((body) => body.key === fleetKey)?.totalThreadCount).toBe(2);
  expect(after.find((body) => body.key === fleetKey)?.members).toEqual([
    { instanceId: "peer", directoryKey: `directory:${peerPath}` },
  ]);
  expect(after).toHaveLength(excludedCount + 1);
}

it("keeps two excluded clones separate when archiving the last grouped thread", () => {
  checkArchiveTransition(2, 2, false);
});

it("preserves checkout exclusions in owner geometry after all grouped threads are archived", () => {
  fc.assert(fc.property(fc.integer({ min: 2, max: 5 }), fc.integer({ min: 2, max: 5 }), fc.boolean(),
    checkArchiveTransition));
});
