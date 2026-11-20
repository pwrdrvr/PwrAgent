import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { NavigationQueryRequest, NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import * as projection from "../navigation-query-projection";

function inventory(n: number): projection.NavigationQueryIndex {
  const threads: NavigationThreadSummary[] = Array.from({ length: n }, (_, i) => ({
    source: i % 2 ? "claude" : "codex", id: `thread-${i % 8}`, title: `Thread ${i}`, titleSource: "explicit",
    linkedDirectories: [], createdAt: i, updatedAt: i, inbox: { inInbox: i % 3 === 0 },
    ...(i >= 8 ? { federation: { ref: { backend: i % 2 ? "claude" as const : "codex" as const,
      threadId: `thread-${i % 8}`, target: { scope: "remote" as const, instanceId: `owner-${Math.floor(i / 8)}` } }, instanceLabel: "Peer" } } : {}),
    ...(i % 4 ? { parentThreadId: `thread-${i % 8 - i % 4}`, parentThreadBackend: "codex" as const } : {}),
  }));
  return { localInstanceId: "viewer", observedAt: 1, coverage: { state: "complete" }, threads,
    inputRequestThreadKeys: new Set(["codex:thread-0"]), directories: [{ key: "project", kind: "directory", label: "Project",
      needsAttentionCount: 0, threadKeys: threads.filter((thread) => !thread.federation).map((thread) => `${thread.source}:${thread.id}`) }] };
}

function requests(q: number): NavigationQueryRequest[] {
  return Array.from({ length: q }, (_, i) => ({ protocol: 2, consumer: "main-sidebar", inventory: "viewer",
    query: i % 3 === 0 ? { kind: "children", parent: { backend: "codex", threadId: "thread-0" } }
      : i % 3 === 1 ? { kind: "directory", directoryKey: "project" }
      : { kind: "exact", identities: [{ backend: "codex", threadId: `thread-${i % 8}` }], includeAncestry: true },
  }));
}

// Differential oracle: mutable inputs always recompute. Certified detached
// snapshots may reuse helpers, but must answer every identity/relationship
// exactly as that path does, including after an owner or relationship change.
async function assertProjectionBudget(n: number, q: number) {
  for (const count of [n, 2 * n]) {
    const raw = inventory(count);
    // The fallback allows this same budget to run against the pre-fix
    // implementation; it fails on repeated whole-inventory map creation.
    const snapshot = "createNavigationQuerySnapshot" in projection ? projection.createNavigationQuerySnapshot(raw) : raw;
    const original = Array.prototype.map;
    let mappedRows = 0;
    const map = vi.spyOn(Array.prototype, "map").mockImplementation(function (this: unknown[], callback, thisArg) {
      if (this === snapshot.threads) mappedRows += this.length;
      return original.call(this, callback, thisArg);
    });
    let actual: projection.NavigationQueryMaterialization[];
    try { actual = requests(q).map((request) => projection.projectNavigationQuery({ index: snapshot, request })); }
    finally { map.mockRestore(); }
    expect(mappedRows).toBe(0);
    expect(actual).toEqual(requests(q).map((request) => projection.projectNavigationQuery({ index: raw, request })));
  }
}

it("prepares whole-inventory maps once for Q queries at N and 2N", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 16, max: 64 }), fc.integer({ min: 4, max: 12 }),
    assertProjectionBudget), { numRuns: 25 });
});

it("four queries do not rebuild the identity maps of sixteen rows", async () => {
  await assertProjectionBudget(16, 4);
});

it("isolates certified snapshots from reused mutable provider objects and query results", () => {
  const raw = inventory(24);
  const saved = structuredClone(raw);
  const snapshot = "createNavigationQuerySnapshot" in projection ? projection.createNavigationQuerySnapshot(raw) : raw;
  const query = requests(1)[0]!;
  const before = projection.projectNavigationQuery({ index: snapshot, request: query });
  raw.threads[1]!.parentThreadId = "thread-4";
  raw.threads[0]!.title = "Changed owner title";
  raw.threads[8]!.federation!.ref.target = { scope: "remote", instanceId: "replacement-owner" };
  (raw.inputRequestThreadKeys as Set<string>).clear();
  expect(projection.projectNavigationQuery({ index: snapshot, request: query })).toEqual(before);
  expect(projection.projectNavigationQuery({ index: snapshot, request: query }))
    .toEqual(projection.projectNavigationQuery({ index: saved, request: query }));
  const callerResult = projection.projectNavigationQuery({ index: snapshot, request: query });
  callerResult.entries[0]!.row.title = "Caller-owned result";
  callerResult.entries.length = 0;
  expect(projection.projectNavigationQuery({ index: snapshot, request: query })).toEqual(before);
  expect(() => { snapshot.threads[0]!.inbox.inInbox = false; }).toThrow();
  expect(() => { (snapshot.inputRequestThreadKeys as Set<string>).add("other"); }).toThrow();
  expect(snapshot.inputRequestThreadKeys!.valueOf()).toBe(snapshot.inputRequestThreadKeys);
  snapshot.inputRequestThreadKeys!.forEach((_value, _key, keys) => {
    expect(() => { (keys as Set<string>).clear(); }).toThrow();
  });
  const next = "createNavigationQuerySnapshot" in projection ? projection.createNavigationQuerySnapshot(raw) : raw;
  for (const request of requests(12)) expect(projection.projectNavigationQuery({ index: next, request }))
    .toEqual(projection.projectNavigationQuery({ index: raw, request }));
});

it("does not certify unfamiliar mutable backing as an immutable inventory", () => {
  const raw = { ...inventory(16), unfamiliarBacking: new Date(0) };
  const snapshot = projection.createNavigationQuerySnapshot(raw);
  expect(snapshot).toBe(raw);
  expect(projection.navigationQuerySnapshotToken(snapshot)).toBeUndefined();
});
