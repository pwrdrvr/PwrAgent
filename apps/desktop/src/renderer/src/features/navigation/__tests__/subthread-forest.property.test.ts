import { expect, it, vi } from "vitest";
import fc from "fast-check";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { threadSummaryIdentityKey } from "../../../lib/federated-thread-events";
import { canNestThread } from "../thread-nest-drop";
import { createSubthreadTrays } from "../subthread-trays";

function row(id: string): NavigationThreadSummary {
  return { id, source: "codex", title: id, titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false } };
}

const candidate = fc.record({
  owner: fc.constantFrom("local", "peer-a", "peer-b"), grouping: fc.boolean(), native: fc.boolean(), mounted: fc.boolean(),
});
type Candidate = { owner: string; grouping: boolean; native: boolean; mounted: boolean };

function ownedRow(id: string, candidate: Candidate): NavigationThreadSummary {
  return { ...row(id), ...(candidate.native ? { codexNativeSubAgent: { parentThreadId: "provider-parent" } } : {}),
    ...(candidate.owner === "local" ? {} : { federation: {
      ref: { backend: "codex", threadId: id, target: { scope: "remote", instanceId: candidate.owner } },
      instanceLabel: candidate.owner, capabilities: candidate.grouping ? ["thread_grouping"] : [],
      derivedFromMountedParent: candidate.mounted,
    } }),
  };
}

it("offers only owner-supported grouping links, never native workers or derived mounts", () => {
  fc.assert(fc.property(candidate, candidate, fc.boolean(), (childSpec, parentSpec, peerWindow) => {
    vi.stubGlobal("window", peerWindow ? { __pwragentFederationTarget: { scope: "remote", instanceId: "peer-a" } } : {});
    try {
      const child = ownedRow("child", childSpec);
      const parent = ownedRow("parent", parentSpec);
      const byKey = new Map([child, parent].map((entry) => [threadSummaryIdentityKey(entry), entry]));
      // Local owners implement grouping; peers advertise it. #3178 also
      // permits a peer child under this machine's local parent, in its own
      // window. A link between two other owners cannot be written here.
      const supported = (spec: Candidate) => spec.owner === "local" || (spec.grouping && !spec.mounted);
      const sharesOwner = childSpec.owner === parentSpec.owner
        || (!peerWindow && childSpec.owner !== "local" && parentSpec.owner === "local");
      expect(canNestThread(child, parent, byKey))
        .toBe(sharesOwner && supported(childSpec) && supported(parentSpec) && !childSpec.native && !parentSpec.native);
    } finally { vi.unstubAllGlobals(); }
  }));
});

const forest = fc.array(fc.record({ parent: fc.nat(20), promoted: fc.boolean(), collapsed: fc.boolean() }), { minLength: 1, maxLength: 20 });
type Node = { parent: number; promoted: boolean; collapsed: boolean };

function checkTrays(nodes: Node[], reverseRoots: boolean) {
  // Replay additions under an existing node or as a root, rather than
  // generating arbitrary parent structs that could already contain cycles.
  const parents = nodes.map((node, index) => node.parent % (index + 1) - 1);
  const rows: NavigationThreadSummary[] = nodes.map((node, index) => ({ ...row(`thread-${index}`), subthreadsCollapsed: node.collapsed }));
  const keys = rows.map(threadSummaryIdentityKey);
  const children = new Map<string, NavigationThreadSummary[]>();
  rows.forEach((entry, index) => {
    const parent = parents[index]!;
    if (parent >= 0) children.set(keys[parent]!, [...(children.get(keys[parent]!) ?? []), entry]);
  });
  const roots = rows.filter((_, index) => parents[index] === -1 || nodes[index]!.promoted);
  if (reverseRoots) roots.reverse();
  const rootKeys = new Set(roots.map(threadSummaryIdentityKey));
  const trays = createSubthreadTrays(children, roots);
  const rendered = roots.flatMap((root) => [root, ...trays.subtree(threadSummaryIdentityKey(root))]);
  expect(rendered.map(threadSummaryIdentityKey).sort()).toEqual([...keys].sort());
  for (const root of roots) {
    const rootKey = threadSummaryIdentityKey(root);
    expect(trays.directChildKeys(rootKey).sort()).toEqual(rows.filter((_, index) => parents[index]! >= 0
      && keys[parents[index]!] === rootKey && !rootKeys.has(keys[index]!)).map(threadSummaryIdentityKey).sort());
    for (const descendant of trays.subtree(rootKey)) {
      const index = rows.indexOf(descendant);
      let parent = parents[index]!;
      let depth = 1;
      while (!rootKeys.has(keys[parent]!)) { parent = parents[parent]!; depth += 1; }
      expect(keys[parent]).toBe(rootKey);
      expect(trays.depth(keys[index]!)).toBe(depth);
    }
  }
}

it("partitions every forest into its lens roots and trays, preserving promoted descendants and true depth", () => {
  fc.assert(fc.property(forest, fc.boolean(), checkTrays));
});

it("reserves a promoted child before walking its ancestor's tray (shrunk #2769 regression)", () => {
  checkTrays([{ parent: 0, promoted: false, collapsed: false }, { parent: 1, promoted: true, collapsed: false }], false);
});
