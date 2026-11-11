import path from "node:path";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { ThreadMaintenanceKeptThread } from "@pwragent/shared";
import { MaintenanceCheckoutOwners, maintenanceKeptThread } from "../app-server/maintenance-checkout-owners";
import type { ThreadArchiveCandidate } from "../app-server/thread-archive-sweeper";

describe("maintenance checkout owner display", () => {
  it("matches the provider-and-path membership model after repeated owner observations", () => {
    fc.assert(fc.property(fc.array(fc.record({
      checkout: fc.nat({ max: 4 }), child: fc.boolean(),
      backend: fc.constantFrom("codex", "claude", "acp:grok"), id: fc.nat({ max: 4 }),
    }), { maxLength: 50 }), (observations) => {
      const index = new MaintenanceCheckoutOwners();
      const model: { cwd: string; owner: ThreadMaintenanceKeptThread }[] = [];
      const latest = new Map<string, ThreadMaintenanceKeptThread>();
      for (const [sequence, event] of observations.entries()) {
        const cwd = path.resolve("fixture", `checkout-${event.checkout}`, ...(event.child ? ["src"] : []));
        const owner = { backend: event.backend, threadId: String(event.id), title: `Observed ${sequence}` };
        index.add(cwd, owner);
        latest.set(JSON.stringify([owner.backend, owner.threadId]), owner);
        const previous = model.findIndex((row) => row.cwd === cwd && row.owner.backend === owner.backend && row.owner.threadId === owner.threadId);
        if (previous >= 0) model[previous] = { cwd, owner };
        else model.push({ cwd, owner });
      }
      for (let checkout = 0; checkout <= 5; checkout += 1) {
        const target = path.resolve("fixture", `checkout-${checkout}`);
        const expected = new Map<string, ThreadMaintenanceKeptThread>();
        for (const row of model) {
          const relative = path.relative(target, row.cwd);
          if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) continue;
          const identity = JSON.stringify([row.owner.backend, row.owner.threadId]);
          expected.set(identity, latest.get(identity)!);
        }
        const actual = index.forPath(target);
        expect(actual).toHaveLength(expected.size);
        for (const owner of actual) expect(owner).toEqual(expected.get(JSON.stringify([owner.backend, owner.threadId])));
      }
    }));
  });

  it("uses observed metadata and only navigable PR destinations without inventing an owner for a path", () => {
    fc.assert(fc.property(fc.constantFrom("javascript:alert(1)", "file:///fixture", "not a URL"), (badUrl) => {
      const candidate: ThreadArchiveCandidate = { thread: {
        id: "provider-id", source: "codex", title: "Provider title", titleSource: "explicit", linkedDirectories: [],
      }, overlay: { backend: "codex", threadId: "provider-id", extraLinkedDirectories: [],
        prs: [badUrl, "https://github.com/example/project/pull/12", "https://github.com/example/project/pull/12"].map((url) => ({
          provider: "github.com", org: "example", repo: "project", number: 12, state: "unknown", url,
        })),
      } };
      expect(maintenanceKeptThread(candidate)).toEqual({ backend: "codex", threadId: "provider-id", title: "Provider title",
        pullRequests: [{ url: "https://github.com/example/project/pull/12", number: 12 }] });
      expect(MaintenanceCheckoutOwners.fromCandidates([candidate]).forPath(path.resolve("fixture", "provider-id"))).toEqual([]);
    }));
  });
});

/**
 * Oracle test. `OwnersByScan` is `MaintenanceCheckoutOwners` before its
 * ancestor index: `forPath` walked every recorded directory and kept those
 * equal to the checkout or inside it. The index must return the same thread
 * objects in the same order, for any order of adds and lookups.
 */
class OwnersByScan {
  private readonly paths = new Map<string, Set<string>>();
  private readonly threads = new Map<string, ThreadMaintenanceKeptThread>();
  private key(value: string) {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }
  add(target: string, thread: ThreadMaintenanceKeptThread) {
    const key = this.key(target);
    let owners = this.paths.get(key);
    if (!owners) this.paths.set(key, owners = new Set());
    const identity = JSON.stringify([thread.backend, thread.threadId]);
    owners.add(identity);
    this.threads.set(identity, thread);
  }
  forPath(target: string) {
    const key = this.key(target);
    const owners = new Map<string, ThreadMaintenanceKeptThread>();
    for (const [cwd, rows] of this.paths) {
      if (cwd !== key && !cwd.startsWith(key + path.sep)) continue;
      for (const identity of rows) owners.set(identity, this.threads.get(identity)!);
    }
    return [...owners.values()];
  }
}

// Sibling-prefix traps, nesting, a trailing separator, spellings that
// resolve the same, relative paths, mixed case and the filesystem root.
// Each also appears with the platform's own separator, so a Windows run
// compares backslash paths too.
const native = (value: string) => value.split("/").join(path.sep);
const POSIX_PATHS = [
  "/w/repo", "/w/repo2", "/w/re", "/w/repo/sub", "/w/repo/sub/deep", "/w/repo2/sub", "/w/repo/",
  "/w/./repo/sub", "/w/x/../repo", "//w//repo", "/w", "/", "w/repo", "/W/Repo/Sub",
];
const PATHS = [...new Set(POSIX_PATHS.flatMap((value) => [value, native(value)]))];

const step = fc.oneof(
  fc.record({
    kind: fc.constant("add" as const), target: fc.constantFrom(...PATHS),
    backend: fc.constantFrom("codex", "claude"), threadId: fc.constantFrom("t1", "t2", "t3", "t4"),
  }),
  fc.record({ kind: fc.constant("forPath" as const), target: fc.constantFrom(...PATHS, "/x", "/w/repo/sub/") }),
);

describe("maintenance checkout owner index", () => {
  it("returns exactly what walking every recorded directory returned", () => {
    fc.assert(fc.property(fc.array(step, { maxLength: 30 }), (steps) => {
      const indexed = new MaintenanceCheckoutOwners();
      const scanned = new OwnersByScan();
      for (const [position, item] of steps.entries()) {
        if (item.kind === "add") {
          // A later add for the same thread replaces its display row.
          const thread = { backend: item.backend, threadId: item.threadId, title: `${item.threadId}@${position}` } as ThreadMaintenanceKeptThread;
          indexed.add(item.target, thread);
          scanned.add(item.target, thread);
          continue;
        }
        const expected = scanned.forPath(item.target);
        const actual = indexed.forPath(item.target);
        expect(actual).toHaveLength(expected.length);
        actual.forEach((thread, index) => expect(thread).toBe(expected[index]));
      }
    }), { numRuns: 3000 });
  });

  it("keeps a sibling with a shared name prefix out, and a nested directory in", () => {
    const at = (...segments: string[]) => path.join(path.sep, ...segments);
    const thread = (threadId: string) => ({ backend: "codex", threadId, title: threadId }) as ThreadMaintenanceKeptThread;
    const owners = new MaintenanceCheckoutOwners();
    owners.add(at("w", "repo"), thread("repo"));
    owners.add(at("w", "repo2"), thread("sibling"));
    owners.add(at("w", "repo", "sub"), thread("nested"));
    expect(owners.forPath(at("w", "repo")).map((row) => row.threadId)).toEqual(["repo", "nested"]);
    expect(owners.forPath(at("w", "repo2")).map((row) => row.threadId)).toEqual(["sibling"]);
    expect(owners.forPath(at("w", "re"))).toEqual([]);
  });
});
