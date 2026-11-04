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
import {
  startingThreadHomeDirectoryKey,
  withStartingPlaceholderDirectories,
} from "../../renderer/src/features/navigation/starting-thread-home";

/*
 * The rule a starting row promises:
 *
 *   A thread started on a peer from this machine's window renders its
 *   starting row in the project group its thread's row will land in, and
 *   nothing moves when the thread arrives. That includes the placeholder
 *   project main adds for a peer project with no row here: the starting row
 *   draws it first.
 *
 * The oracle is main: `attachRemoteThreadsToLocalDirectories` files the
 * landed thread, and the group it picks is the right answer. The landed
 * thread is what the owner reports: the launchpad's directory, then each
 * `@`-referenced directory attached after it, with the working directory as
 * `projectKey` from every backend. An `@`-referenced folder links the way the
 * owner's `attachDirectoryToThread` registers it: at its Git root, with a
 * `.worktrees/<hash>/…` checkout folded back to its repository, labeled with
 * that root's basename. The renderer sees the list main sent before the
 * thread landed, in whatever order it rendered it, so the generated list is
 * shuffled before the renderer reads it.
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
  // A tool-managed worktree, which home preference puts last.
  "/Users/peer/.codex/worktrees/cd34",
] as const;
const LOCAL_WORKSPACE_ROOT = "/Users/me/.pwragent/profiles/default/projects";
const PEER_WORKSPACE_ROOT = "/Users/peer/.pwragent/profiles/default/projects";

/** A folder the composer `@`-references, as the operator picked it. */
type Reference = {
  /** The Git root holding it, or the folder itself when it is not in Git. */
  root: string;
  /** The picked folder below `root`; empty when the root itself was picked. */
  subfolder: string;
  inGit: boolean;
};

type PeerProject = {
  kind: "directory" | "workspace";
  label: string;
  path: string;
  workMode: "local" | "worktree";
  backend: "codex" | "claude" | "acp:kimi";
  references: Reference[];
};

const peerPath = fc
  .record({ folder: fc.constantFrom(...NAMES), parent: fc.constantFrom(...PEER_PARENTS) })
  .map(({ folder, parent }) => parent.includes("\\") ? `${parent}\\${folder}` : `${parent}/${folder}`);
const backend = fc.constantFrom("codex" as const, "claude" as const, "acp:kimi" as const);
const reference: fc.Arbitrary<Reference> = fc.record({
  root: fc.oneof(
    peerPath,
    // A repository's own `.worktrees` checkout, which the owner folds back
    // to the repository: its link is named for the repository, not the folder.
    fc.constantFrom(...NAMES).map((folder) => `/Users/peer/github/PwrGit/.worktrees/ef56/${folder}`),
  ),
  subfolder: fc.constantFrom("", "packages/shared", "apps/desktop/src"),
  inGit: fc.boolean(),
});
const references = fc.array(reference, { maxLength: 2 });

/** The directory `attachDirectoryToThread` links for `reference`. */
function referencedLink(reference: Reference, threadId: string): LinkedDirectorySummary {
  const picked = (reference.subfolder ? `${reference.root}/${reference.subfolder}` : reference.root)
    .replace(/\\/g, "/");
  const path = reference.inGit
    ? reference.root.replace(/\\/g, "/").replace(/\/\.worktrees\/[^/]+(?:\/[^/]+)?$/, "")
    : picked;
  return { id: `${threadId}-${path}`, kind: "local", label: path.split("/").filter(Boolean).pop()!, path };
}

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
      label: fc.constantFrom(...NAMES),
      path: peerPath,
      workMode: fc.constantFrom("local" as const, "worktree" as const),
      backend,
      references,
    })
    .map((project) => ({ kind: "directory" as const, ...project })),
  fc
    .record({ backend, references })
    .map((project) => ({
      kind: "workspace" as const,
      label: "Workspaces",
      path: PEER_WORKSPACE_ROOT,
      workMode: "local" as const,
      ...project,
    })),
);

/** What the owner reports for a thread started from `project`'s launchpad. */
function landedThread(project: PeerProject, threadId: string): NavigationThreadSummary {
  const worktreePath = `/Users/peer/.pwragent/worktrees/${threadId}/${project.label}`;
  const launchpadDirectory: LinkedDirectorySummary = project.kind === "workspace"
    ? { id: threadId, kind: "local", label: threadId, path: `${PEER_WORKSPACE_ROOT}/${threadId}` }
    : project.workMode === "worktree"
      ? { id: threadId, kind: "worktree", label: project.label, path: project.path, worktreePath }
      : { id: threadId, kind: "local", label: project.label, path: project.path };
  const linkedDirectories = [launchpadDirectory];
  for (const link of project.references.map((picked) => referencedLink(picked, threadId))) {
    if (linkedDirectories.some((linked) => linked.path === link.path)) continue;
    linkedDirectories.push(link);
  }
  const cwd = project.kind === "workspace"
    ? launchpadDirectory.path
    : project.workMode === "worktree" ? worktreePath : project.path;
  return {
    id: threadId,
    source: project.backend,
    linkedDirectories,
    projectKey: cwd,
    federation: {
      ref: buildFederatedThreadRef({ backend: project.backend, instanceId: PEER, threadId }),
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
        fc.array(fc.integer(), { minLength: 12, maxLength: 12 }),
        (local, otherProjects, project, order) => {
          const others = otherProjects.map((other, index) => landedThread(other, `other-${index}`));
          // The list the window has while the thread starts.
          const before = attachRemoteThreadsToLocalDirectories(local, others);
          const thread = landedThread(project, "started");
          const after = attachRemoteThreadsToLocalDirectories(local, [...others, thread]);
          const threadKey = federatedThreadIdentityKey(thread.federation!.ref);
          const landedIn = after.find((directory) => directory.threadKeys.includes(threadKey))?.key;

          const creation = {
            directoryKey: `${project.kind}:${project.path}`,
            directoryLabel: project.label,
            launchpad: { directoryPath: project.path },
            target: { scope: "remote" as const, instanceId: PEER },
          };
          const rendered = withStartingPlaceholderDirectories(
            shuffled(before, order), [creation], undefined, (placeholder) => placeholder);
          expect(startingThreadHomeDirectoryKey(creation, rendered)).toBe(landedIn);
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
        launchpad: { directoryPath: peerDirectory.path },
        target: { scope: "remote", instanceId: PEER },
      },
      [sameName, peerDirectory],
      { scope: "remote", instanceId: PEER },
    )).toBe(peerDirectory.key);
  });
});
