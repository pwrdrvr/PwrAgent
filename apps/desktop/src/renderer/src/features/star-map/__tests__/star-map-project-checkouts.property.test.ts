import fc from "fast-check";
import { expect, it } from "vitest";
import type { NavigationDirectoryRow } from "@pwragent/shared";
import { groupThreadsByProject } from "../star-map-projects";

function descriptor(label: string, path: string, total: number, checkoutPaths?: string[]): NavigationDirectoryRow {
  return {
    key: `directory:${path}`, kind: "directory", label, path, checkoutPaths,
    repositoryKey: "github.com/fixture/project",
    counts: { total, active: 0, unread: 0, review: 0 },
    pinnedRootCount: 0, unpinnedRootCount: total, launchpadPresent: false,
  };
}

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
