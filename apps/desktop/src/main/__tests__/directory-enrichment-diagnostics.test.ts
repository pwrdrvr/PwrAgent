import { describe, expect, it } from "vitest";
import {
  DirectoryEnrichmentDiagnostics,
  type DirectoryEnrichmentContext,
} from "../diagnostics/directory-enrichment-diagnostics";

const context: DirectoryEnrichmentContext = {
  directory: "/fixture/repo", enricherId: 1, caller: "thread-list", reason: "cold",
};

describe("directory enrichment diagnostics", () => {
  it("attributes starts and completions to their time buckets without mutating prior snapshots", () => {
    let now = 0;
    const diagnostics = new DirectoryEnrichmentDiagnostics(() => now, () => now);
    expect(diagnostics.createEnricherId()).toBe(1);
    expect(diagnostics.createEnricherId()).toBe(2);
    diagnostics.record(context, { requests: 1 });
    const finish = diagnostics.startGit(context, ["rev-parse", "--show-toplevel"]);
    const before = diagnostics.snapshot();
    now = 2_010;
    finish(true);
    const after = diagnostics.snapshot();
    expect(before.buckets[0].totals).toMatchObject({ requests: 1, gitStarted: 1, gitFailed: 0 });
    expect(after.enricherInstancesCreated).toBe(2);
    expect(after.buckets[0].rows[0]).toMatchObject({ ...context, topLevelCommands: 1 });
    expect(after.buckets[1].rows[0]).toMatchObject({ gitFailed: 1, gitDurationMs: 2_010 });
    expect(before.buckets).toHaveLength(1);
  });

  it("bounds rows, includes overflow in totals, and expires idle history without a timer", () => {
    let now = 0;
    const diagnostics = new DirectoryEnrichmentDiagnostics(() => now, () => now);
    for (let i = 0; i < 40; i += 1) {
      diagnostics.record({ ...context, directory: `/fixture/${i}` }, { requests: 1 });
    }
    let snapshot = diagnostics.snapshot();
    expect(snapshot.buckets[0].rows).toHaveLength(snapshot.rowsPerBucket);
    expect(snapshot.buckets[0].totals.requests).toBe(40);
    expect(snapshot.buckets[0].overflow.requests).toBe(8);
    for (let i = 1; i <= 80; i += 1) {
      now = i * 2_000;
      diagnostics.record(context, { requests: 1 });
    }
    snapshot = diagnostics.snapshot();
    expect(snapshot.buckets).toHaveLength(60);
    now += snapshot.retentionMs;
    expect(diagnostics.snapshot().buckets).toEqual([]);
  });

  it("separates callers, reasons and cache owners and bounds path text", () => {
    const diagnostics = new DirectoryEnrichmentDiagnostics(() => 0, () => 0);
    diagnostics.record(context, { requests: 1 });
    diagnostics.record({ ...context, caller: "selected-thread" }, { requests: 1 });
    diagnostics.record({ ...context, reason: "cache-hit" }, { requests: 1 });
    diagnostics.record({ ...context, enricherId: 2 }, { requests: 1 });
    diagnostics.record({ ...context, directory: "x".repeat(2_000) }, { requests: 1 });
    const snapshot = diagnostics.snapshot();
    expect(snapshot.buckets[0].rows).toHaveLength(5);
    expect(snapshot.buckets[0].rows[4].directory).toHaveLength(snapshot.maxPathLength);
  });

  it("accounts successful worktree and branch commands without timing assertions", () => {
    const diagnostics = new DirectoryEnrichmentDiagnostics(() => 0, () => 0);
    diagnostics.startGit(context, ["worktree", "list", "--porcelain"])(false);
    diagnostics.startGit(context, ["rev-parse", "--abbrev-ref", "HEAD"])(false);
    expect(diagnostics.snapshot().buckets[0].totals).toMatchObject({
      gitStarted: 2, gitSucceeded: 2, gitFailed: 0,
      worktreeListCommands: 1, branchCommands: 1,
    });
  });
});
