import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { maintenanceRepositoryHints, resolveMaintenanceRepositories } from "../app-server/maintenance-repositories";
import { maintenanceWorktreeRoots, registeredWorktreePaths } from "../app-server/unreferenced-worktrees";

const exec = promisify(execFile);
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); });

async function fixtureRoot() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "maintenance-repositories-")));
  temporary.push(root);
  return root;
}

describe("maintenance repository coverage", () => {
  // Model: changing the workspace name cannot change whether a conventional
  // worktree container is included. There is no project-name allowlist.
  it("discovers worktree containers beneath arbitrary top-level workspaces", async () => {
    await fc.assert(fc.asyncProperty(fc.stringMatching(/^[a-z]{1,12}$/), fc.constantFrom("worktrees", ".worktrees", "claude-worktrees"), async (name, container) => {
      const home = path.resolve("/fixture/home");
      const workspace = path.join(home, name);
      const directories = new Map([[home, [name, "claude-worktrees"]], [workspace, [container]]]);
      const roots = await maintenanceWorktreeRoots(path.join(home, ".pwragent", "worktrees"), path.join(home, ".codex"), home, {
        listDirectories: async (folder) => directories.get(folder) ?? [], isLinkedWorktree: async () => false,
      });
      expect(new Set(roots)).toContain(path.join(workspace, container));
      expect(new Set(roots)).toContain(path.join(home, "claude-worktrees"));
    }), { numRuns: 20 });
  });

  // Git is the oracle. A worktree outside every tool home and a primary
  // sibling without a thread record remain discoverable from one live hint.
  it("resolves Git registrations and primary sibling repositories independently of thread paths", async () => {
    const root = await fixtureRoot();
    const workspace = path.join(root, "arbitrary-workspace");
    const primary = path.join(workspace, "primary"), sibling = path.join(workspace, "no-thread");
    const outside = path.join(root, "elsewhere", "checkout");
    const git = async (cwd: string, ...args: string[]) => await exec("git", ["-C", cwd, ...args]);
    for (const repo of [primary, sibling]) {
      await mkdir(repo, { recursive: true });
      await git(repo, "init", "-b", "main");
      await git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture");
    }
    await git(primary, "worktree", "add", "-b", "linked", outside);
    await mkdir(path.join(primary, "source"));
    const repositories = await resolveMaintenanceRepositories([path.join(primary, "source"), outside, outside, path.join(root, "gone")]);
    expect(new Set(repositories)).toEqual(new Set([primary, sibling]));
    const registration = await git(primary, "worktree", "list", "--porcelain", "-z");
    expect(registeredWorktreePaths(registration.stdout).map((value) => path.normalize(value))).toContain(outside);
  });

  // The model unions PwrAgent-owned metadata across profiles. Reading the
  // hints changes no database bytes and never consults provider storage.
  it("unions directory, child, ACP and Claude hints across PwrAgent profiles without writes", async () => {
    const root = await fixtureRoot();
    const expected = new Set<string>();
    for (const profile of ["default", "other"]) {
      const state = path.join(root, "profiles", profile, "state");
      await mkdir(path.join(state, "claude"), { recursive: true });
      const file = path.join(state, "state.db");
      const database = new Database(file);
      database.exec("CREATE TABLE directory_overlay (directory_key TEXT); CREATE TABLE threads (payload TEXT); CREATE TABLE acp_sessions (payload TEXT)");
      const paths = ["primary", "native-child", "remote-parent-child", "acp", "claude"].map((name) => path.join(root, profile, name));
      paths.forEach((value) => expected.add(value));
      database.prepare("INSERT INTO directory_overlay VALUES (?)").run(paths[0]);
      database.prepare("INSERT INTO threads VALUES (?)").run(JSON.stringify({ extraLinkedDirectories: [{ path: paths[1], worktreePath: paths[2] }] }));
      database.prepare("INSERT INTO acp_sessions VALUES (?)").run(JSON.stringify({ cwd: paths[3] }));
      database.close();
      await writeFile(path.join(state, "claude", "00000000-0000-0000-0000-000000000000.json"), JSON.stringify({ cwd: paths[4] }));
      const before = await readFile(file);
      const hints = await maintenanceRepositoryHints(root);
      expect(hints.incomplete).toBe(false);
      expect(new Set(hints.paths)).toEqual(expected);
      expect(await readFile(file)).toEqual(before);
    }
  });
});
