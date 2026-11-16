import fc from "fast-check";
import { expect, it } from "vitest";
import { buildFederatedThreadRef, type NavigationThreadSummary, type ProjectForgeAutomation } from "@pwragent/shared";
import { appendViewerNavigationPins } from "../app-server/navigation-viewer-pins";

const paused: ProjectForgeAutomation = { paused: true, pausedAt: 1, autoFixMergeConflicts: true,
  autoFixCiFailures: true, prWatches: true, refuseThreadMessages: false, wakeupPolicy: "hold" };
const member = fc.record({ owner: fc.constantFrom("peer-a", "peer-b"),
  project: fc.option(fc.constantFrom("directory:/owner/repo", "directory:/elsewhere/repo"), { nil: undefined }) });

it("derives placeholder ownership from every member regardless of how pins and watched rows are partitioned", () => {
  fc.assert(fc.property(fc.array(member, { minLength: 2, maxLength: 12 }), fc.nat(100), fc.boolean(),
    (members, splitAt, pauseFirstPeer) => {
      const rows: NavigationThreadSummary[] = members.map(({ owner, project }, i) => ({
        id: `thread-${i}`, source: "codex", title: `Thread ${i}`, titleSource: "explicit", inbox: { inInbox: false },
        linkedDirectories: [{ id: `${owner}-${i}`, kind: "local", label: "repo", path: `/fixture/${owner}/repo` }],
        federation: { ref: buildFederatedThreadRef({ backend: "codex", instanceId: owner, threadId: `thread-${i}` }), instanceLabel: owner },
        ...(project ? { homeProject: { directoryKey: project,
          ...((owner === "peer-a") === pauseFirstPeer ? { forgeAutomation: paused } : {}) } } : {}),
      }));
      const split = 1 + splitAt % (rows.length - 1);
      const initial = appendViewerNavigationPins({ threads: [], directories: [] }, rows.slice(0, split));
      const before = structuredClone(initial);
      const extended = appendViewerNavigationPins(initial, rows.slice(split));
      const combined = appendViewerNavigationPins({ threads: [], directories: [] }, rows);
      const owners = new Set(members.map((row) => row.owner));
      const projects = new Set(members.flatMap((row) => row.project ? [row.project] : []));
      const singleProject = owners.size === 1 && projects.size === 1;
      const expectedProject = singleProject ? { target: { scope: "remote", instanceId: members[0]!.owner },
        directoryKey: [...projects][0] } : undefined;
      const expectedAutomation = singleProject && ((members[0]!.owner === "peer-a") === pauseFirstPeer) ? paused : undefined;
      expect(extended.directories).toHaveLength(1);
      expect(extended.directories[0]!.peerProject).toEqual(expectedProject);
      expect(extended.directories[0]!.forgeAutomation).toEqual(expectedAutomation);
      expect(extended.directories).toEqual(combined.directories);
      expect(initial).toEqual(before);
    }), { numRuns: 100 });
});

it("retains the viewer's Forge Automation when remote members join an existing local project", () => {
  fc.assert(fc.property(fc.array(member, { minLength: 2, maxLength: 12 }), (members) => {
    const local = { key: "directory:/viewer/repo", kind: "directory" as const, label: "repo", path: "/viewer/repo",
      threadKeys: [], needsAttentionCount: 0, forgeAutomation: paused };
    const rows: NavigationThreadSummary[] = members.map(({ owner }, i) => ({ id: String(i), source: "codex", title: String(i),
      titleSource: "explicit", inbox: { inInbox: false }, linkedDirectories: [{ id: owner, kind: "local", label: "repo", path: `/${owner}/repo` }],
      federation: { ref: buildFederatedThreadRef({ backend: "codex", instanceId: owner, threadId: String(i) }), instanceLabel: owner },
      homeProject: { directoryKey: "directory:/remote/repo" } }));
    const initial = appendViewerNavigationPins({ threads: [], directories: [local] }, rows.slice(0, 1));
    const result = appendViewerNavigationPins(initial, rows.slice(1));
    expect(result.directories[0]!.forgeAutomation).toEqual(paused);
    expect(result.directories[0]!.peerProject).toBeUndefined();
  }));
});
