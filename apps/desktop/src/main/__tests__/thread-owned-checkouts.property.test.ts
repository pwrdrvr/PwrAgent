import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { candidateCheckoutDirectories, resolveOwnedMaintenanceCheckouts } from "../app-server/thread-owned-checkouts";
import type { ThreadArchiveCandidate } from "../app-server/thread-archive-sweeper";

const exec = promisify(execFile);
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); });

function owner(id: string, cwd: string, source: "codex" | "claude" | "acp:grok" = "codex"): ThreadArchiveCandidate {
  return { thread: { id, source, title: id, titleSource: "explicit", codexNativeSubAgent: { parentThreadId: "remote-parent" },
    projectKey: "/unrelated/primary", linkedDirectories: [{ id: cwd, kind: "worktree", label: id, path: "/unrelated/primary", worktreePath: cwd }] } };
}

describe("maintenance repository scope", () => {
  // The provider inventory is the model. Adding other directories cannot add
  // permission to inspect them, and native children need no local parent row.
  it("resolves exactly the known cwd set and deduplicates shared checkouts and owners", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.record({ id: fc.integer({ min: 0, max: 15 }),
      checkout: fc.integer({ min: 0, max: 8 }), source: fc.constantFrom("codex" as const, "claude" as const, "acp:grok" as const) }), { maxLength: 30 }), async (rows) => {
      const candidates = rows.map((row) => owner(String(row.id), `/any/location/${row.checkout}/src`, row.source));
      const requested: string[] = [];
      let running = 0, peak = 0;
      const resolved = await resolveOwnedMaintenanceCheckouts(candidates, undefined, async (cwd) => {
        running += 1;
        peak = Math.max(peak, running);
        requested.push(cwd);
        await Promise.resolve();
        running -= 1;
        return path.dirname(cwd);
      });
      expect(new Set(requested)).toEqual(new Set(rows.map((row) => path.normalize(`/any/location/${row.checkout}/src`))));
      expect(requested.length).toBe(new Set(requested).size);
      expect(peak).toBeLessThanOrEqual(6);
      expect(new Set(resolved.map((row) => row.path))).toEqual(new Set(rows.map((row) => path.normalize(`/any/location/${row.checkout}`))));
      for (const row of resolved) {
        const expected = rows.filter((item) => row.path === path.normalize(`/any/location/${item.checkout}`)).map((item) => `${item.source}:${item.id}`);
        expect(new Set(row.candidates.map((item) => `${item.thread.source}:${item.thread.id}`))).toEqual(new Set(expected));
        expect(row.candidates.length).toBe(new Set(expected).size);
      }
    }), { numRuns: 80 });
  });

  // Real Git is the oracle for the checkout root. A registration and nearby
  // repository alone are not a thread association.
  it("finds an owned worktree anywhere without including its primary, sibling or spare worktree", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "maintenance-owned-")));
    temporary.push(root);
    const primary = path.join(root, "primary"), sibling = path.join(root, "sibling");
    const outside = path.join(root, "arbitrary", "owned"), spare = path.join(root, "arbitrary", "spare");
    const git = async (cwd: string, ...args: string[]) => await exec("git", ["-C", cwd, ...args]);
    for (const repo of [primary, sibling]) {
      await mkdir(repo, { recursive: true });
      await git(repo, "init", "-b", "main");
      await git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture");
    }
    await git(primary, "worktree", "add", "-b", "owned", outside);
    await git(primary, "worktree", "add", "-b", "spare", spare);
    await mkdir(path.join(outside, "src"));
    const candidate = owner("child", path.join(outside, "src"));
    candidate.thread.projectKey = primary;
    const checkouts = await resolveOwnedMaintenanceCheckouts([candidate, owner("gone", path.join(root, "gone"))]);
    expect(checkouts.map((row) => row.path)).toEqual([outside]);
    expect((await git(outside, "rev-parse", "--show-toplevel")).stdout.trim()).toBe(outside.replaceAll("\\", "/"));
    await rm(primary, { recursive: true });
    expect((await resolveOwnedMaintenanceCheckouts([owner("known-with-missing-repo", outside)])).map((row) => row.path)).toEqual([outside]);
  });

  it("uses project cwd only when no explicit checkout directories are present", () => {
    const candidate = owner("child", "/linked/checkout");
    expect(candidateCheckoutDirectories(candidate)).toEqual([path.normalize("/linked/checkout")]);
    candidate.thread.linkedDirectories = [];
    expect(candidateCheckoutDirectories(candidate)).toEqual([path.normalize("/unrelated/primary")]);
  });
});
