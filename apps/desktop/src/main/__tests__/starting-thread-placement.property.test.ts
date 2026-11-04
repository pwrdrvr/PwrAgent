import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  buildFederatedThreadRef,
  federatedThreadIdentityKey,
  type LinkedDirectorySummary,
  type NavigationDirectorySummary,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import { attachRemoteThreadsToLocalDirectories } from "../app-server/navigation-viewer-pins";
import { startingThreadHomeDirectoryKey } from "../../renderer/src/features/navigation/starting-thread-home";

/*
 * The rule a starting row promises:
 *
 *   A thread started on a peer from this machine's window renders its
 *   starting row in the project group its thread's row will land in. When
 *   the thread arrives nothing moves. Only when no group here will take the
 *   thread does the row wait above the projects.
 *
 * The oracle is main: `attachRemoteThreadsToLocalDirectories` files the
 * landed thread, and the group it picks is the right answer. The renderer
 * sees the list main sent before the thread landed, in whatever order it
 * rendered it, so the generated list is shuffled before the renderer reads it.
 */

const PEER = "pwr_peer";
const NAMES = ["PwrAgnt", "PwrAgent", "pwragnt", "codex", "PwrGit"] as const;
const LOCAL_PARENTS = [
  "/Users/me/pwrdrvr",
  "/Users/me/github",
  "/Users/me/.codex/worktrees/ab12",
] as const;
const PEER_PARENTS = [
  "/Users/peer/github",
  "C:\\src",
  // The same home layout on both machines: a peer key can equal a local one.
  "/Users/me/github",
] as const;
const LOCAL_WORKSPACE_ROOT = "/Users/me/.pwragent/profiles/default/projects";
const PEER_WORKSPACE_ROOT = "/Users/peer/.pwragent/profiles/default/projects";

type PeerProject = {
  kind: "directory" | "workspace";
  label: string;
  path: string;
  workMode: "local" | "worktree";
};

const localDirectory = fc
  .record({
    folder: fc.constantFrom(...NAMES),
    label: fc.constantFrom(...NAMES),
    parent: fc.constantFrom(...LOCAL_PARENTS),
  })
  .map(({ folder, label, parent }): NavigationDirectorySummary => ({
    key: `directory:${parent}/${folder}`,
    kind: "directory",
    label,
    path: `${parent}/${folder}`,
    threadKeys: [],
    needsAttentionCount: 0,
  }));

const localDirectories = fc
  .record({
    directories: fc.uniqueArray(localDirectory, { maxLength: 6, selector: (directory) => directory.key }),
    workspace: fc.boolean(),
  })
  .map(({ directories, workspace }) => workspace
    ? [...directories, {
      key: `workspace:${LOCAL_WORKSPACE_ROOT}`,
      kind: "workspace" as const,
      label: "Workspaces",
      path: LOCAL_WORKSPACE_ROOT,
      threadKeys: [],
      needsAttentionCount: 0,
    }]
    : directories);

const peerProject: fc.Arbitrary<PeerProject> = fc.oneof(
  fc
    .record({
      folder: fc.constantFrom(...NAMES),
      label: fc.constantFrom(...NAMES),
      parent: fc.constantFrom(...PEER_PARENTS),
      workMode: fc.constantFrom("local" as const, "worktree" as const),
    })
    .map(({ folder, label, parent, workMode }) => ({
      kind: "directory" as const,
      label,
      path: parent.includes("\\") ? `${parent}\\${folder}` : `${parent}/${folder}`,
      workMode,
    })),
  fc.constant({
    kind: "workspace" as const,
    label: "Workspaces",
    path: PEER_WORKSPACE_ROOT,
    workMode: "local" as const,
  }),
);

/** What the owner reports for a thread started from `project`'s launchpad. */
function landedThread(project: PeerProject, threadId: string, withProjectKey: boolean): NavigationThreadSummary {
  const linked: LinkedDirectorySummary = project.kind === "workspace"
    ? { id: threadId, kind: "local", label: threadId, path: `${PEER_WORKSPACE_ROOT}/${threadId}` }
    : project.workMode === "worktree"
      ? {
        id: threadId,
        kind: "worktree",
        label: project.label,
        path: project.path,
        worktreePath: `/Users/peer/.pwragent/worktrees/${threadId}/${project.label}`,
      }
      : { id: threadId, kind: "local", label: project.label, path: project.path };
  return {
    id: threadId,
    source: "codex",
    linkedDirectories: [linked],
    ...(withProjectKey && project.kind === "directory" ? { projectKey: project.path } : {}),
    federation: {
      ref: buildFederatedThreadRef({ backend: "codex", instanceId: PEER, threadId }),
      instanceLabel: "Peer",
    },
  } as unknown as NavigationThreadSummary;
}

function shuffled<T>(items: readonly T[], order: readonly number[]): T[] {
  return items
    .map((item, index) => ({ item, rank: order[index] ?? index }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ item }) => item);
}

describe("starting row placement for a peer's thread", () => {
  it("renders in the group main files the landed thread under", () => {
    fc.assert(
      fc.property(
        localDirectories,
        fc.array(peerProject, { maxLength: 3 }),
        peerProject,
        fc.boolean(),
        fc.array(fc.integer(), { minLength: 12, maxLength: 12 }),
        (local, otherProjects, project, withProjectKey, order) => {
          const others = otherProjects.map((other, index) => landedThread(other, `other-${index}`, withProjectKey));
          // The list the window has while the thread starts.
          const before = attachRemoteThreadsToLocalDirectories(local, others);
          const thread = landedThread(project, "started", withProjectKey);
          const after = attachRemoteThreadsToLocalDirectories(local, [...others, thread]);
          const threadKey = federatedThreadIdentityKey(thread.federation!.ref);
          const landedIn = after.find((directory) => directory.threadKeys.includes(threadKey))?.key;
          const expected = before.some((directory) => directory.key === landedIn) ? landedIn : undefined;

          const placed = startingThreadHomeDirectoryKey(
            {
              directoryKey: `${project.kind}:${project.path}`,
              directoryLabel: project.label,
              launchpad: { directoryKind: project.kind, directoryPath: project.path },
              target: { scope: "remote", instanceId: PEER },
            },
            shuffled(before, order),
          );
          expect(placed).toBe(expected);
        },
      ),
      { numRuns: 2_000 },
    );
  });

  it("uses the launchpad's own row in the peer's window", () => {
    const peerDirectory: NavigationDirectorySummary = {
      key: "directory:/Users/peer/github/PwrAgnt",
      kind: "directory",
      label: "PwrAgnt",
      path: "/Users/peer/github/PwrAgnt",
      threadKeys: [],
      needsAttentionCount: 0,
    };
    // A second row the name rule would also accept: the window shows the
    // peer's own list, where the launchpad's key is the thread's row.
    const sameName = { ...peerDirectory, key: "directory:/Users/peer/a/PwrAgnt", path: "/Users/peer/a/PwrAgnt" };
    expect(startingThreadHomeDirectoryKey(
      {
        directoryKey: peerDirectory.key,
        directoryLabel: "PwrAgnt",
        launchpad: { directoryKind: "directory", directoryPath: peerDirectory.path },
        target: { scope: "remote", instanceId: PEER },
      },
      [sameName, peerDirectory],
      { scope: "remote", instanceId: PEER },
    )).toBe(peerDirectory.key);
  });
});
