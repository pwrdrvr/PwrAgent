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
