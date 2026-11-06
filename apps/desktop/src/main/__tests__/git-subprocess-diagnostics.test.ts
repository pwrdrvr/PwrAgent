import { describe, expect, it } from "vitest";
import { GitSubprocessDiagnostics } from "../diagnostics/git-subprocess-diagnostics";

describe("Git subprocess diagnostics", () => {
  it("counts attempts and completions separately without retaining sensitive inputs", () => {
    let now = 0;
    const diagnostics = new GitSubprocessDiagnostics(() => now, () => now);
    diagnostics.observeRepository("/private-fixture/checkout", "/private-fixture/common");
    const finish = diagnostics.startGit("/private-fixture/checkout", ["remote", "get-url", "--all", "secret-remote"], "pr-remotes");
    now = 2_500;
    finish(false);
    diagnostics.start("ssh-config", "pr-remotes", { sshHost: "private-fixture-host" })(true);
    const snapshot = diagnostics.snapshot();
    expect(snapshot.buckets[0].totals).toEqual({ started: 1, succeeded: 0, failed: 0, durationMs: 0 });
    expect(snapshot.buckets[1].totals).toEqual({ started: 1, succeeded: 1, failed: 1, durationMs: 2_500 });
    expect(snapshot.buckets[0].rows[0]).toMatchObject({ command: "remote-url", purpose: "pr-remotes", commonDirectoryId: expect.any(String) });
    expect(JSON.stringify(snapshot)).not.toMatch(/private-fixture|secret-remote|get-url/);
  });

  it("bounds rows and retention while counting overflow exactly", () => {
    let now = 0;
    const diagnostics = new GitSubprocessDiagnostics(() => now, () => now);
    for (let bucket = 0; bucket < 70; bucket++) {
      now = bucket * 2_000;
      for (let row = 0; row < 40; row++) diagnostics.startGit(`/fixture/${row}`, ["status"])(false);
    }
    const snapshot = diagnostics.snapshot();
    expect(snapshot.buckets).toHaveLength(60);
    for (const bucket of snapshot.buckets) {
      expect(bucket.rows).toHaveLength(32);
      expect(bucket.totals.started).toBe(40);
      expect(bucket.overflow.started).toBe(8);
    }
    now += 120_000;
    expect(diagnostics.snapshot().buckets).toEqual([]);
  });

  it("associates sibling worktrees with a common ID and clears changed relationships", () => {
    const diagnostics = new GitSubprocessDiagnostics(() => 0);
    for (const directory of ["/fixture/one", "/fixture/two"]) {
      diagnostics.observeRepository(directory, "/fixture/common");
      diagnostics.startGit(directory, ["remote"])(false);
    }
    diagnostics.observeRepository("/fixture/one");
    diagnostics.startGit("/fixture/one", ["remote"])(false);
    const rows = diagnostics.snapshot().buckets[0].rows;
    expect(rows[0].directoryId).not.toBe(rows[1].directoryId);
    expect(rows[0].commonDirectoryId).toBe(rows[1].commonDirectoryId);
    expect(rows[2].commonDirectoryId).toBeUndefined();
    const other = new GitSubprocessDiagnostics(() => 0);
    other.startGit("/fixture/one", ["remote"])(false);
    expect(other.snapshot().buckets[0].rows[0].directoryId).not.toBe(rows[0].directoryId);
  });
});
