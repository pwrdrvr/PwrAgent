import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import path from "node:path";
import type { AppServerThreadSummary } from "@pwragent/shared";
import { ArchiveFleetIndex, type FleetRow } from "../app-server/archive-cleanup-fleet-index";

/**
 * The fleet index answers "which identities can touch this checkout?" from
 * reverse maps. The oracle answers it by scanning every row, the way each
 * archive job used to. After any sequence of writes, deletes, marks and memo
 * reads, both must agree, and a memo must never outlive a change to a row it
 * covers or a row written near its scope.
 */

const aliases = vi.hoisted(() => new Map<string, string>());
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const path = await import("node:path");
  // Production resolves natively: on Windows "/model/a" arrives as "D:\\model\\a".
  const toModel = (value: string) => process.platform === "win32"
    ? value.replace(/^[A-Za-z]:/, "").replace(/\\/g, "/").toLowerCase() : value;
  const toNative = (value: string) => process.platform === "win32" ? path.resolve(value) : value;
  return {
    ...actual,
    realpath: vi.fn(async (input: string) => {
      const value = toModel(input);
      if (!value.startsWith("/model")) return await actual.realpath(input);
      if (value.includes("unreadable")) throw Object.assign(new Error("denied"), { code: "EACCES" });
      for (const [alias, target] of aliases) {
        if (value === alias || value.startsWith(alias + "/")) return toNative(target + value.slice(alias.length));
      }
      return toNative(value);
    }),
  };
});

const PATHS = ["/model/a", "/model/a/nested", "/model/b", "/model", "/model/link", "/model/link/nested", "/model/unreadable", "/model/c"];
const SCOPES = ["/model/a", "/model/b", "/model/c", "/model/link"];

function resolve(value: string): string | undefined {
  if (value.includes("unreadable")) return undefined;
  return value.startsWith("/model/link") ? "/model/a" + value.slice("/model/link".length) : value;
}

function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!path.isAbsolute(relative) && !relative.startsWith(".."));
}

function row(id: string, paths: string[], archived: boolean, unknownWorkspace: boolean, parent?: string): FleetRow {
  const thread = { id, source: "codex", title: id, titleSource: "explicit", linkedDirectories: [] } as AppServerThreadSummary;
  return { key: `codex:${id}`, backend: "codex", threadId: id, archived, base: thread, thread, paths, externalPaths: [], unknownWorkspace,
    overlay: parent ? { backend: "codex", threadId: id, extraLinkedDirectories: [], parentThreadId: parent } : undefined };
}

/** Brute force: every row, every path, resolved now. */
function oracle(rows: Map<string, FleetRow>, scopePath: string): Set<string> {
  const scope = resolve(scopePath)!;
  const result = new Set<string>();
  for (const entry of rows.values()) {
    const resolved = entry.paths.map(resolve);
    if (!entry.paths.length || entry.unknownWorkspace || resolved.includes(undefined)) {
      result.add(entry.key);
      continue;
    }
    if (resolved.some((value) => within(scope, value!) || within(value!, scope))) result.add(entry.key);
  }
  return result;
}

const operation = fc.oneof(
  fc.record({ kind: fc.constant("upsert" as const), id: fc.integer({ min: 0, max: 5 }),
    paths: fc.subarray(PATHS, { maxLength: 3 }), archived: fc.boolean(), unknown: fc.boolean(), parent: fc.option(fc.constantFrom("p0", "p1"), { nil: undefined }) }),
  fc.record({ kind: fc.constant("delete" as const), id: fc.integer({ min: 0, max: 5 }) }),
  fc.record({ kind: fc.constant("mark" as const), id: fc.integer({ min: 0, max: 5 }) }),
  fc.record({ kind: fc.constant("memo" as const), scope: fc.constantFrom(...SCOPES) }),
  fc.record({ kind: fc.constant("rebuild" as const) }),
);

describe("archive fleet index", () => {
  it("agrees with a full scan after any sequence of writes, marks and memo reads", async () => {
    aliases.set("/model/link", "/model/a");
    await fc.assert(fc.asyncProperty(fc.array(operation, { maxLength: 30 }), async (operations) => {
      const index = new ArchiveFleetIndex();
      const rows = new Map<string, FleetRow>();
      await index.replaceAll([], index.beginRead(), {});
      for (const op of operations) {
        if (op.kind === "upsert") {
          const next = row(`t${op.id}`, op.paths, op.archived, op.unknown, op.parent);
          rows.set(next.key, next);
          await index.upsert(next);
        } else if (op.kind === "delete") {
          rows.delete(`codex:t${op.id}`);
          index.delete(`codex:t${op.id}`);
        } else if (op.kind === "mark") {
          index.markDirty(`codex:t${op.id}`, "provider");
        } else if (op.kind === "rebuild") {
          index.requestRebuild("model");
          await index.replaceAll([...rows.values()], index.beginRead(), {});
        } else {
          // A memo is valid only while nothing it covers has changed: its
          // value must equal a fresh computation at every read.
          const value = await index.memo(op.scope, async (keys) => [...keys].sort());
          expect(value).toEqual([...await index.related(op.scope)].sort());
        }
        for (const scope of SCOPES) {
          expect([...await index.related(scope)].sort()).toEqual([...oracle(rows, scope)].sort());
          for (const entry of rows.values()) {
            const paths = await index.relatedPaths(entry.key, [scope]);
            if (paths === undefined) continue;
            // Only paths that resolve into or above the scope are reported.
            const expected = entry.paths.filter((value) => {
              const resolved = resolve(value);
              return resolved !== undefined && (within(resolve(scope)!, resolved) || within(resolved, resolve(scope)!));
            });
            expect(paths.sort()).toEqual([...new Set(expected)].sort());
          }
        }
        for (const parent of ["p0", "p1"]) {
          expect(index.childrenOf(parent).map((entry) => entry.key).sort()).toEqual(
            [...rows.values()].filter((entry) => !entry.archived && entry.overlay?.parentThreadId === parent).map((entry) => entry.key).sort());
        }
      }
    }), { numRuns: 100 });
  });

  it("keeps a change made during a read dirty after that read settles", async () => {
    const index = new ArchiveFleetIndex();
    index.markDirty("codex:t0", "provider");
    const epoch = index.beginRead();
    // A notification lands while the provider read is in flight.
    index.markDirty("codex:t0", "overlay");
    index.settle("codex:t0", epoch);
    expect(index.dirtyEntries().map((entry) => entry.key)).toEqual(["codex:t0"]);
    index.settle("codex:t0", index.beginRead());
    expect(index.dirtyCount).toBe(0);
  });

  it("keeps a rebuild requested during a complete read", async () => {
    const index = new ArchiveFleetIndex();
    const epoch = index.beginRead();
    index.requestRebuild("identity-free change during the read");
    await index.replaceAll([], epoch, {});
    expect(index.needsRebuild).toBe(true);
    await index.replaceAll([], index.beginRead(), {});
    expect(index.needsRebuild).toBe(false);
  });
});
