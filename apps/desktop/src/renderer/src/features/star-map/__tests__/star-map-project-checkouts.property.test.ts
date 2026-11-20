import fc from "fast-check";
import { expect, it } from "vitest";
import type { NavigationDirectoryRow } from "@pwragent/shared";
import { groupThreadsByProject, starMapProjectIdentities } from "../star-map-projects";

const ORIGIN = "github.com/fixture/project";

function descriptor(label: string, path: string, total: number, checkoutPaths?: string[]): NavigationDirectoryRow {
  return {
    key: `directory:${path}`, kind: "directory", label, path, checkoutPaths,
    repositoryKey: ORIGIN,
    counts: { total, active: 0, unread: 0, review: 0 },
    pinnedRootCount: 0, unpinnedRootCount: total, launchpadPresent: false,
  };
}

function checkSameNameFolders(folderCount: number, peerReportsOrigin: boolean) {
  const folders = Array.from({ length: folderCount }, (_, index) => ({
    ...descriptor("api", `/client-${index}/api`, 1), repositoryKey: undefined,
  }));
  const peer = { ...descriptor("api", "/peer/api", 1), repositoryKey: peerReportsOrigin ? ORIGIN : undefined };
  const identityFor = starMapProjectIdentities(new Map([["local", folders], ["peer", [peer]]]));

  for (const { key } of folders) {
    expect(identityFor("local", key)).toBe(`checkout:${JSON.stringify(["local", key])}`);
  }
  expect(identityFor("peer", peer.key)).toBe(peerReportsOrigin ? `repo:${ORIGIN}` : "name:api");

  const single = starMapProjectIdentities(new Map([["local", [folders[0]]], ["peer", [peer]]]));
  expect(single("local", folders[0].key)).toBe(single("peer", peer.key));
}

it("keeps two originless api folders on one owner separate", () => {
  checkSameNameFolders(2, false);
});

it("uses folder names across owners without pooling ambiguous folders on one owner", () => {
  fc.assert(fc.property(fc.integer({ min: 2, max: 5 }), fc.boolean(), checkSameNameFolders));
});

it("pools same-origin clones across owners unless an explicit local group separates them", () => {
  // Each size describes a disjoint set of clones: one ungrouped clone or one group.
  const checkoutCount = fc.oneof({ withCrossShrink: true }, fc.constant(1), fc.integer({ min: 2, max: 5 }));
  const owner = fc.array(checkoutCount, {
    minLength: 1, maxLength: 5,
  });
  fc.assert(fc.property(fc.array(owner, { minLength: 2, maxLength: 5 }), (owners) => {
    const descriptorsByInstance = new Map(owners.map((checkoutCounts, ownerIndex) => [
      `owner-${ownerIndex}`,
      checkoutCounts.map((count, rowIndex) => {
        const label = `project-${rowIndex}`;
        const path = `/src/${label}`;
        const checkoutPaths = count === 1 ? undefined : Array.from({ length: count }, (_, cloneIndex) =>
          cloneIndex === 0 ? path : `${path}-clone-${cloneIndex}`);
        return descriptor(label, path, count, checkoutPaths);
      }),
    ]));
    const identityFor = starMapProjectIdentities(descriptorsByInstance);

    for (const [ownerIndex, checkoutCounts] of owners.entries()) {
      const instanceId = `owner-${ownerIndex}`;
      const groupCount = checkoutCounts.filter((count) => count > 1).length;
      for (const [rowIndex, count] of checkoutCounts.entries()) {
        const key = `directory:/src/project-${rowIndex}`;
        const sharesOrigin = groupCount === 0 || (groupCount === 1 && count > 1);
        expect(identityFor(instanceId, key)).toBe(sharesOrigin
          ? `repo:${ORIGIN}`
          : `checkout:${JSON.stringify([instanceId, key])}`);
      }
    }
  }));
});

it("draws one body for two ungrouped clones on one owner and one clone on a peer", () => {
  const local = descriptor("Project", "/local/Project", 1);
  const duplicate = descriptor("Duplicate", "/local/Duplicate", 1);
  const peer = descriptor("Project", "/peer/Project", 1);
  const projects = groupThreadsByProject(new Map(), {
    now: 100,
    descriptorsByInstance: new Map([["local", [local, duplicate]], ["peer", [peer]]]),
  });

  expect(projects).toHaveLength(1);
  expect(projects[0].totalThreadCount).toBe(3);
  expect(projects[0].members).toEqual([
    { instanceId: "local", directoryKey: local.key },
    { instanceId: "local", directoryKey: duplicate.key },
    { instanceId: "peer", directoryKey: peer.key },
  ]);
});

it("pools the configured project across owners and keeps intentional duplicate clones distinct", () => {
  fc.assert(fc.property(fc.nat(50), fc.nat(1000), fc.boolean(), (localCount, peerCount, reverse) => {
    const group = descriptor("Preferred", "/local/Preferred", localCount, ["/local/Preferred", "/local/Old"]);
    const separate = descriptor("Separate", "/local/Separate", 1);
    const peer = descriptor("Old", "/peer/Old", peerCount);
    const projects = groupThreadsByProject(new Map(), {
      now: 100,
      descriptorsByInstance: new Map([
        ["local", reverse ? [separate, group] : [group, separate]],
        ["peer", [peer]],
      ]),
    });
    expect(projects).toHaveLength(2);
    const grouped = projects.find((project) => project.label === "Preferred");
    expect(grouped?.totalThreadCount).toBe(localCount + peerCount);
    expect(grouped?.members).toEqual([
      { instanceId: "local", directoryKey: group.key },
      { instanceId: "peer", directoryKey: peer.key },
    ]);
    expect(projects.find((project) => project.label === "Separate")?.members).toEqual([
      { instanceId: "local", directoryKey: separate.key },
    ]);
  }));
});
