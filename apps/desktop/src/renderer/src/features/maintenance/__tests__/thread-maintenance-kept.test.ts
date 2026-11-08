import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { ThreadMaintenanceKeptCheckout } from "@pwragent/shared";
import { groupKeptCheckouts, keptGuidance, pullRequestHref } from "../thread-maintenance-kept";

const REASONS = ["Watching a PR", "Recently active", "Kept awake", "Uncommitted changes", "Shared with another thread",
  "Other ignored files", "Commits on no branch", "Already archived", "Used by an active thread", "Something new"];

const keptRow: fc.Arbitrary<ThreadMaintenanceKeptCheckout> = fc.record({
  path: fc.constantFrom(...Array.from({ length: 12 }, (_, index) => `/w/${index}`)),
  reason: fc.constantFrom(...REASONS),
  allocatedBytes: fc.option(fc.nat({ max: 2 ** 40 }), { nil: undefined }),
  threads: fc.option(fc.array(fc.record({
    backend: fc.constantFrom("codex", "claude"), threadId: fc.uuid(), title: fc.string(),
  }), { maxLength: 3 }), { nil: undefined }),
}).map(({ allocatedBytes, threads, ...row }) => ({
  ...row, ...(allocatedBytes !== undefined ? { allocatedBytes } : {}), ...(threads ? { threads } : {}),
}));

describe("kept checkout groups, as a model", () => {
  it("lists each path once, under its first reason, with its owners untouched", () => {
    fc.assert(fc.property(fc.array(keptRow, { maxLength: 30 }), (rows) => {
      const groups = groupKeptCheckouts(rows);
      const listed = groups.flatMap((group) => group.rows.map((row) => ({ row, reason: group.reason })));
      // Oracle: the first row sent for each path.
      const first = new Map<string, ThreadMaintenanceKeptCheckout>();
      for (const row of rows) if (!first.has(row.path)) first.set(row.path, row);
      expect(listed.map((item) => item.row.path).sort()).toEqual([...first.keys()].sort());
      for (const { row, reason } of listed) {
        expect(row).toBe(first.get(row.path));
        expect(reason).toBe(row.reason);
      }
    }));
  });

  it("orders groups by what they hold and rows largest first, unmeasured last", () => {
    fc.assert(fc.property(fc.array(keptRow, { maxLength: 30 }), (rows) => {
      const groups = groupKeptCheckouts(rows);
      const held = groups.map((group) => group.total?.bytes ?? -1);
      expect(held).toEqual([...held].sort((a, b) => b - a));
      for (const group of groups) {
        const sizes = group.rows.map((row) => row.allocatedBytes ?? -1);
        expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
        const measured = group.rows.filter((row) => row.allocatedBytes !== undefined);
        expect(group.total?.bytes).toBe(measured.length ? measured.reduce((sum, row) => sum + row.allocatedBytes!, 0) : undefined);
      }
    }));
  });
});

describe("kept guidance", () => {
  it("names the scan's own idle threshold for Recently active", () => {
    expect(keptGuidance("Recently active", { step: "hibernate", idleDays: 7, inactivityDays: 30 }))
      .toContain("Worked in or restored within the last 7 days, this scan's idle threshold");
    expect(keptGuidance("Recently active", { step: "threads", idleDays: 7, inactivityDays: 30 }))
      .toContain("Active within the last 30 days");
  });

  it("never promises a recently active checkout will be offered later", () => {
    const text = keptGuidance("Recently active", { step: "hibernate", idleDays: 7 })!;
    expect(text).toContain("Other protections may still keep it later");
    expect(text).not.toMatch(/will be offered|is offered once/);
  });

  it("sends a PR watch to the thread's own watch controls, without saying an agent made it", () => {
    const text = keptGuidance("Watching a PR", { step: "hibernate" })!;
    expect(text).toContain("Wakes this thread");
    expect(text).toContain("use Stop, then re-scan");
    expect(text).not.toMatch(/agent/i);
    // Hibernation keeps the thread and restores on send, so no consequence is claimed.
    expect(text).not.toMatch(/strand|archiving|hibernating/i);
  });

  it("routes each limit and next step to where it really is", () => {
    // The plan has idle days only; the snapshot limit lives in Settings.
    expect(keptGuidance("Changes over the snapshot limit", { step: "hibernate" }))
      .toContain("Settings → Worktrees → Largest snapshot");
    for (const step of ["hibernate", "checkouts"] as const) {
      expect(keptGuidance("Changes over the snapshot limit", { step })).not.toMatch(/in the plan/);
    }
    for (const checkoutsStep of [true, false]) {
      const guidance = keptGuidance("Already archived", { step: "hibernate", checkoutsStep })!;
      expect(guidance).toContain("Archived status no longer keeps a checkout");
      expect(guidance).toContain("idle threshold");
      expect(guidance).toContain("Re-scan");
    }
    // Pushing alone does not resolve uncommitted work.
    expect(keptGuidance("Uncommitted changes", { step: "hibernate" })).not.toMatch(/push/i);
    expect(keptGuidance("Used by an active thread", { step: "checkouts" })).toContain("this scan did not read");
  });

  it("describes recorded external ownership without guessing who created the checkout", () => {
    for (const reason of ["Checkout ownership not registered", "Checkout not created by PwrAgent", "Externally managed"]) {
      const guidance = keptGuidance(reason, { step: "hibernate" })!;
      expect(guidance).toContain("recorded as externally managed");
      expect(guidance).not.toMatch(/PwrAgent did not create|app that made/i);
    }
  });

  it("has guidance for every reason the scans send", () => {
    for (const reason of ["Other ignored files", "Commits on no branch", "Already archived", "Used by an active thread",
      "Ignored files only", "Externally managed", "Repository no longer exists", "Main checkout", "Stashed changes",
      "Submodule changes", "Git operation in progress", "Locked worktree"]) {
      expect(keptGuidance(reason, { step: "hibernate" }), reason).toBeDefined();
    }
  });

  it("guesses nothing for a reason it does not know, and never calls a checkout safe to remove or offers force", () => {
    expect(keptGuidance("Something new", { step: "checkouts" })).toBeUndefined();
    for (const reason of REASONS) {
      expect(keptGuidance(reason, { step: "hibernate", idleDays: 3 }) ?? "").not.toMatch(/safe|force/i);
    }
  });

  it("opens only web pull request links", () => {
    expect(pullRequestHref("https://forge.example/acme/kiln/pull/12")).toBe("https://forge.example/acme/kiln/pull/12");
    expect(pullRequestHref("javascript:alert(1)")).toBeUndefined();
    expect(pullRequestHref("file:///etc/passwd")).toBeUndefined();
    expect(pullRequestHref("not a url")).toBeUndefined();
  });
});
