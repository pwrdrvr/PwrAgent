import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { StackEngine, type GitRunner } from "../index";
import { StackCoordinator } from "../../stack-coordinator";
import { commit, git, memoryStore, repository, runner, withRepo, withStack } from "./fixture.test-support";

test("a routed conflict records the verified rewritten parent and replays only descendant commits", () => withRepo(async (cwd, base) => {
  await git(cwd, "switch", "-qc", "parent");
  const oldParent = await commit(cwd, "base.txt", "old parent\n");
  await git(cwd, "switch", "-qc", "layer");
  const oldLayer = await commit(cwd, "base.txt", "layer edit\n");
  await git(cwd, "switch", "-qc", "leaf");
  const oldLeaf = await commit(cwd, "leaf.txt", "leaf edit\n");
  await git(cwd, "switch", "-qc", "replacement", base);
  const rewritten = await commit(cwd, "base.txt", "rewritten parent\n");
  await git(cwd, "update-ref", "refs/heads/parent", rewritten, oldParent);
  const commonDir = join(cwd, ".git");
  const store = memoryStore({ schemaVersion: 1, repository, stacks: [{
    trunk: { branch: "main", head: base },
    branches: [{ branch: "parent", head: oldParent, base }, { branch: "layer", head: oldLayer, base: oldParent },
      { branch: "leaf", head: oldLeaf, base: oldLayer }],
  }] });
  const engine = new StackEngine(runner, store, cwd, commonDir);
  const actor = { backend: "codex" as const, threadId: "lead" };
  const owner = { backend: "codex" as const, threadId: "owner", title: "Layer owner", branch: "layer",
    active: false, locked: false, remote: false };
  let routed = 0;
  let finishApply!: (result: { error?: unknown }) => void;
  const applied = new Promise<{ error?: unknown }>((resolve) => { finishApply = resolve; });
  const coordinator = new StackCoordinator({
    newId: () => "resolved-conflict", now: () => 1, plan: (operation) => engine.plan(operation),
    participants: async (moves) => moves.some(({ branch }) => branch === owner.branch) ? [owner] : [],
    hold: () => () => undefined, subscribe: () => () => undefined, exclusive: (work) => work(),
    requestWork: async (_sender, _owner, prompt) => {
      expect(prompt).toContain(rewritten);
      routed++;
    },
    apply: async (plan, id, when, hooks) => {
      try {
        const receipt = await engine.apply(plan, id, when, hooks);
        finishApply({});
        return receipt;
      } catch (error) {
        finishApply({ error });
        throw error;
      }
    },
    undo: () => { throw new Error("Unexpected undo"); }, receipt: () => { throw new Error("Unexpected receipt"); },
  });
  const operation = { kind: "restack" as const, root: "parent" };
  const { planId } = await coordinator.plan(actor, operation);
  coordinator.apply(actor, planId);
  await expect.poll(() => coordinator.status(actor, planId).issue?.code).toBe("forecast_conflict");
  await git(cwd, "update-ref", "refs/heads/parent", base, rewritten);
  await expect(coordinator.routeConflict(actor, planId)).rejects.toMatchObject({ code: "stale_plan" });
  expect(routed).toBe(0);
  await git(cwd, "update-ref", "refs/heads/parent", rewritten, base);
  await coordinator.routeConflict(actor, planId);
  expect(routed).toBe(1);
  await git(cwd, "switch", "-q", "layer");
  const conflict = await runner.run(cwd, ["rebase", "--onto", rewritten, oldParent]);
  expect(conflict.exitCode).toBe(1);
  await writeFile(join(cwd, "base.txt"), "resolved layer edit\n");
  await git(cwd, "add", "base.txt");
  await git(cwd, "-c", "core.editor=true", "rebase", "--continue");
  const resolved = await git(cwd, "rev-parse", "layer");
  expect((await runner.run(cwd, ["merge-base", "--is-ancestor", oldParent, resolved])).exitCode).toBe(1);
  await expect(engine.plan(operation)).rejects.toThrow("recorded base");
  await coordinator.continue(owner, planId);
  // Windows Git can outlast the polling budget. Wait for the real engine,
  // then check that the coordinator publishes its terminal state.
  expect(await applied).toEqual({});
  await expect.poll(() => coordinator.status(actor, planId).status).toBe("done");
  expect((await store.read(commonDir)).catalog.stacks[0]?.branches[1]).toMatchObject({ base: rewritten, head: resolved });
  expect(await git(cwd, "merge-base", "layer", "leaf")).toBe(resolved);
  expect(await git(cwd, "log", "--format=%s", "layer..leaf")).toBe("leaf.txt");
}));

describe("stack ref transaction", () => {
  test("EOF after prepare releases every lock without publishing any ref", () => withStack(async ({ cwd, commonDir, store, bottom, top }) => {
    await commit(cwd, "trunk.txt", "advance\n");
    const fault: GitRunner = {
      async run(directory, args, opts) {
        if (args[0] !== "update-ref" || !opts?.stdin) return runner.run(directory, args, opts);
        const prepared = await runner.run(directory, args, { stdin: opts.stdin.replace(/commit\n$/, "") });
        expect(prepared.stdout).toContain("prepare: ok");
        throw new Error("injected exit after prepare");
      },
    };
    const engine = new StackEngine(fault, store, cwd, commonDir);
    const plan = await engine.plan({ kind: "restack", root: "bottom" });
    expect(plan.moves).toHaveLength(2);
    await expect(engine.apply(plan, "fault", 1)).rejects.toThrow("injected exit");
    expect(await git(cwd, "rev-parse", "bottom", "top")).toBe(`${bottom}\n${top}`);
    expect(await git(cwd, "for-each-ref", "refs/pwragent/undo/")).toBe("");
  }));

  test("a concurrent branch move aborts the whole transaction", () => withStack(async ({ cwd, engine, bottom, top, base }) => {
    await commit(cwd, "trunk.txt", "advance\n");
    const plan = await engine.plan({ kind: "restack", root: "bottom" });
    await expect(engine.apply(plan, "race", 1, {
      beforeTransaction: async () => { await git(cwd, "update-ref", "refs/heads/top", base, top); },
    })).rejects.toThrow();
    expect(await git(cwd, "rev-parse", "bottom", "top")).toBe(`${bottom}\n${base}`);
    expect(await git(cwd, "for-each-ref", "refs/pwragent/undo/")).toBe("");
  }));

  test("linked worktrees follow moved refs and retain unrelated staged and unstaged work", () => withStack(async ({ cwd, engine, top }) => {
    await commit(cwd, "trunk.txt", "advance\n");
    const linked = join(cwd, "linked");
    await git(cwd, "worktree", "add", "-q", linked, "top");
    await writeFile(join(linked, "top.txt"), "staged local change\n");
    await git(linked, "add", "top.txt");
    await writeFile(join(linked, "top.txt"), "unstaged local change\n");
    const before = await git(linked, "status", "--porcelain");
    const plan = await engine.plan({ kind: "restack", root: "bottom" });
    expect(plan.blocked).toEqual([]);
    await engine.apply(plan, "worktree", 1);
    expect(await readFile(join(linked, "trunk.txt"), "utf8")).toBe("advance\n");
    expect(await git(linked, "status", "--porcelain")).toBe(before);
    expect(await git(linked, "show", ":top.txt")).toBe("staged local change");
    expect(await readFile(join(linked, "top.txt"), "utf8")).toBe("unstaged local change\n");
    await engine.undo("worktree");
    expect(await git(linked, "rev-parse", "HEAD")).toBe(top);
    expect(await git(linked, "status", "--porcelain")).toBe(before);
  }));

  test("overlap blocks before any checkout or ref change", () => withStack(async ({ cwd, engine, top }) => {
    await commit(cwd, "trunk.txt", "advance\n");
    await git(cwd, "switch", "-q", "top");
    await writeFile(join(cwd, "trunk.txt"), "untracked work");
    const plan = await engine.plan({ kind: "restack", root: "bottom" });
    expect(plan.blocked).toEqual([{ path: expect.any(String), files: ["trunk.txt"] }]);
    await expect(engine.apply(plan, "overlap", 1)).rejects.toThrow("trunk.txt");
    expect(await git(cwd, "rev-parse", "HEAD")).toBe(top);
  }));
});

test("gh-stack #586: the integrated boundary excludes the squash from replay", () => withRepo(async (cwd, old) => {
  await git(cwd, "switch", "-qc", "parent");
  await commit(cwd, "parent.txt", "one\n");
  const parent = await commit(cwd, "parent.txt", "two\n");
  await git(cwd, "switch", "-qc", "child");
  await commit(cwd, "child.txt", "child\n");
  await git(cwd, "switch", "-q", "main");
  await git(cwd, "merge", "--squash", "parent");
  await git(cwd, "commit", "-qm", "squash parent");
  const integrated = await commit(cwd, "integration.txt", "integrated\n");
  await git(cwd, "rebase", "--onto", "main", parent, "child");
  const child = await git(cwd, "rev-parse", "child");
  await git(cwd, "switch", "-q", "main");
  const trunk = await commit(cwd, "parent.txt", "three\n");
  await git(cwd, "switch", "-q", "child");
  // The naive stale-boundary rebase tries to reapply the squash itself.
  const naive = await runner.run(cwd, ["rebase", "--onto", "main", old, "child"]);
  expect(naive.exitCode).not.toBe(0);
  expect(await git(cwd, "show", "-s", "--format=%s", "REBASE_HEAD")).toBe("squash parent");
  await git(cwd, "rebase", "--abort");
  const store = memoryStore({
    schemaVersion: 1, repository,
    stacks: [{ trunk: { branch: "main", head: integrated }, branches: [{ branch: "child", head: child, base: integrated }] }],
  });
  const engine = new StackEngine(runner, store, cwd, join(cwd, ".git"));
  const plan = await engine.plan({ kind: "restack", root: "child" });
  expect(plan.steps[0].proof).toEqual({ preserved: 1, dropped: [] });
  await engine.apply(plan, "squash-boundary", 1);
  expect(await git(cwd, "log", "--format=%s", `${trunk}..child`)).toBe("child.txt");
  expect(await git(cwd, "show", "child:parent.txt")).toBe("three");
}));

test("a patch newly present upstream is accounted for in the proof", () => withRepo(async (cwd, base) => {
  await git(cwd, "switch", "-qc", "layer");
  const tip = await commit(cwd, "same.txt", "same\n");
  await git(cwd, "switch", "-q", "main");
  await commit(cwd, "trunk.txt", "trunk\n");
  await git(cwd, "cherry-pick", tip);
  const upstream = await git(cwd, "rev-parse", "HEAD");
  const store = memoryStore({
    schemaVersion: 1, repository,
    stacks: [{ trunk: { branch: "main", head: base }, branches: [{ branch: "layer", head: tip, base }] }],
  });
  const engine = new StackEngine(runner, store, cwd, join(cwd, ".git"));
  const plan = await engine.plan({ kind: "restack", root: "layer" });
  expect(plan.steps[0].proof).toEqual({ preserved: 0, dropped: [{ commit: tip, id: expect.any(String) }] });
  await engine.apply(plan, "upstream-patch", 1);
  expect(await git(cwd, "diff", upstream, "layer")).toBe("");
}));
