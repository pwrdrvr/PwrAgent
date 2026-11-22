import fc from "fast-check";
import { expect, it } from "vitest";
import { buildFederatedThreadRef } from "@pwragent/shared/contracts/federation";
import {
  NAVIGATION_ATTENTION_SCOPES,
  type NavigationAttentionScope,
  type NavigationCounts,
  type NavigationQuery,
  type NavigationThreadSummary,
} from "@pwragent/shared/contracts/navigation";
import { projectNavigationQuery, type NavigationQueryIndex } from "../navigation-query-projection";
import { NavigationQueryStore } from "../navigation-query-store";

// The rule: picking a row on the Attention card lists exactly the threads
// that row counted. The card's numbers are the owner's population counts
// (the `directory-index` page the sidebar reads), so the oracle is two-sided:
// a slow predicate written from the thread's raw fields, and the count the
// operator clicked.

type Spec = {
  turn: boolean;
  subAgent: boolean;
  backgroundTasks: boolean;
  unread: boolean;
  remote: boolean;
  updatedAt: number;
};

const spec = fc.record({
  turn: fc.boolean(),
  subAgent: fc.boolean(),
  backgroundTasks: fc.boolean(),
  unread: fc.boolean(),
  remote: fc.boolean(),
  updatedAt: fc.integer({ min: 1, max: 50 }),
});

function thread(node: Spec, index: number): NavigationThreadSummary {
  return {
    id: `thread-${index}`, source: "codex", title: `Thread ${index}`, titleSource: "explicit",
    linkedDirectories: [], updatedAt: node.updatedAt,
    threadStatus: node.turn ? "active" : "idle",
    ...(node.subAgent ? { hasActiveSubAgent: true } : {}),
    ...(node.backgroundTasks ? { hasBackgroundTasks: true } : {}),
    inbox: { inInbox: node.unread },
    ...(node.remote ? { federation: { ref: buildFederatedThreadRef({ backend: "codex", threadId: `thread-${index}`,
      instanceId: "peer" }), instanceLabel: "Peer" } } : {}),
  };
}

/** Slow oracle, from the raw fields rather than the projection's helpers. */
function inScope(node: Spec, scope: NavigationAttentionScope): boolean {
  const running = node.turn || node.subAgent || node.backgroundTasks;
  if (scope === "review") return node.unread && !running;
  if (scope === "active") return running;
  return running && node.remote === (scope === "active-remote");
}

/** The number the Attention card shows beside the row for `scope`. */
function cardCount(counts: NavigationCounts, scope: NavigationAttentionScope): number {
  const remote = counts.activeRemote ?? 0;
  if (scope === "active") return counts.active;
  if (scope === "active-local") return counts.active - remote;
  if (scope === "active-remote") return remote;
  return counts.review;
}

function read(index: NavigationQueryIndex, query: NavigationQuery) {
  return projectNavigationQuery({ index, request: { protocol: 2, consumer: "main-sidebar", inventory: "viewer",
    query, pageSize: 100 } });
}

function checkScopes(nodes: Spec[]): void {
  const index: NavigationQueryIndex = { threads: nodes.map(thread), directories: [] };
  const ids = (page: ReturnType<typeof read>) => page.entries.map((entry) => entry.row.ref.threadId);
  const whole = ids(read(index, { kind: "lens", lens: "attention" }));
  const counts = read(index, { kind: "directory-index" }).counts;
  for (const scope of NAVIGATION_ATTENTION_SCOPES) {
    const narrowed = ids(read(index, { kind: "lens", lens: "attention", attention: scope }));
    // Exactly the members of that kind, in the whole queue's order: a
    // narrowed lens never re-orders what it keeps.
    expect(narrowed, scope).toEqual(whole.filter((id) => inScope(nodes[Number(id.slice("thread-".length))]!, scope)));
    expect(narrowed.length, scope).toBe(cardCount(counts, scope));
  }
}

it("lists a running unread thread as in progress, not as to review", () => {
  checkScopes([
    { turn: true, subAgent: false, backgroundTasks: false, unread: true, remote: false, updatedAt: 3 },
    { turn: false, subAgent: false, backgroundTasks: false, unread: true, remote: false, updatedAt: 2 },
    { turn: false, subAgent: true, backgroundTasks: false, unread: false, remote: true, updatedAt: 1 },
  ]);
});

it("narrows Attention to exactly the threads each card row counts", () => {
  fc.assert(fc.property(fc.array(spec, { maxLength: 60 }), checkScopes), { numRuns: 300 });
});

it("refuses a scope outside Attention or outside the vocabulary", async () => {
  const store = new NavigationQueryStore();
  const index: NavigationQueryIndex = { threads: [], directories: [] };
  const readPage = (query: NavigationQuery) => store.readPage({ scopeKey: "viewer", loadIndex: async () => index,
    request: { protocol: 2, consumer: "main-sidebar", inventory: "viewer", query } });
  await expect(readPage({ kind: "lens", lens: "inbox", attention: "review" }))
    .rejects.toMatchObject({ code: "navigation_invalid_request" });
  await expect(readPage({ kind: "lens", lens: "attention", attention: "unread" as NavigationAttentionScope }))
    .rejects.toMatchObject({ code: "navigation_invalid_request" });
  await expect(readPage({ kind: "lens", lens: "attention", attention: "review" })).resolves.toBeDefined();
});
