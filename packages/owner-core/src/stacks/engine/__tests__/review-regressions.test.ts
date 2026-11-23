import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { StackEngine, type GitRunner } from "../index";
import { commit, git, memoryStore, repository, runner, withRepo, withStack } from "./fixture.test-support";

test("an ignored file in a replay's path survives byte for byte", () => withStack(async ({ cwd, engine, top }) => {
  await commit(cwd, "trunk.txt", "advance\n");
  await git(cwd, "switch", "top");
  await mkdir(join(cwd, ".git", "info"), { recursive: true });
  await writeFile(join(cwd, ".git", "info", "exclude"), "trunk.txt\n");
  const local = Buffer.from([9, 0, 255, 10]);
  await writeFile(join(cwd, "trunk.txt"), local);
  const plan = await engine.plan({ kind: "restack", root: "bottom" });
  await expect(engine.apply(plan, "ignored", 1)).rejects.toThrow("trunk.txt");
  expect(await readFile(join(cwd, "trunk.txt"))).toEqual(local);
  expect(await git(cwd, "rev-parse", "top")).toBe(top);
}));

test("paused rebases with a clean index hold the branch they will restore", () => withStack(async ({ cwd, engine, top }) => {
  await commit(cwd, "trunk.txt", "advance\n");
  const plan = await engine.plan({ kind: "restack", root: "bottom" });
  await git(cwd, "switch", "top");
  expect((await runner.run(cwd, ["rebase", "--exec", "false", "main"])).exitCode).toBe(1);
  expect(await git(cwd, "ls-files", "-u")).toBe("");
  await expect(engine.apply(plan, "paused", 1)).rejects.toThrow(/rebase/);
  await git(cwd, "rebase", "--abort");
  expect(await git(cwd, "rev-parse", "top")).toBe(top);
}));

test("a checkout created while preparing follows the branch or stops the ref update", () => withStack(async ({ cwd, engine, top }) => {
  await commit(cwd, "trunk.txt", "advance\n");
  const plan = await engine.plan({ kind: "restack", root: "bottom" });
  const linked = join(cwd, "linked");
  const applied = await engine.apply(plan, "checkout", 1, {
    beforeTransaction: async () => { await git(cwd, "worktree", "add", "-q", linked, "top"); },
  }).then(() => true, () => false);
  if (applied) {
    expect(await readFile(join(linked, "trunk.txt"), "utf8")).toBe("advance\n");
    expect(await git(linked, "status", "--porcelain")).toBe("");
  } else expect(await git(cwd, "rev-parse", "top")).toBe(top);
}));

test("a nested worktree with a missing Git link cannot pass preflight in its parent", () => withStack(async ({ cwd, engine, top }) => {
  await commit(cwd, "trunk.txt", "advance\n");
  const linked = join(cwd, "linked");
  await git(cwd, "worktree", "add", "-q", linked, "top");
  const plan = await engine.plan({ kind: "restack", root: "bottom" });
  await rename(join(linked, ".git"), join(linked, "git-link-backup"));
  await expect(engine.apply(plan, "missing", 1)).rejects.toThrow();
  expect(await git(cwd, "rev-parse", "top")).toBe(top);
}));

test.each(["apply", "undo"] as const)("a lost %s commit result keeps the journal", direction => withStack(async ({ cwd, commonDir, store, engine }) => {
  await commit(cwd, "trunk.txt", "advance\n");
  const plan = await engine.plan({ kind: "restack", root: "bottom" });
  if (direction === "undo") await engine.apply(plan, "lost", 1);
  const fault: GitRunner = { async run(path, args, opts) {
    const result = await runner.run(path, args, opts);
    if (args[0] === "update-ref" && args[1] === "--stdin") {
      expect(result.exitCode).toBe(0);
      throw new Error("Lost commit result");
    }
    return result;
  } };
  const interrupted = new StackEngine(fault, store, cwd, commonDir);
  let journal = false;
  const hooks = { begin: async () => { journal = true; }, finish: async () => { journal = false; } };
  const operation = direction === "undo" ? interrupted.undo("lost", hooks) : interrupted.apply(plan, "lost", 1, hooks);
  await expect(operation).rejects.toThrow("Lost commit result");
  expect(journal).toBe(true);
}));

test("a nearby upstream edit leaves the replayed changes equal to Git rebase", () => withRepo(async cwd => {
  const original = ["one", "two", "three", "four", "five", "six"];
  const content = (index: number, replacement: string) => original.with(index, replacement).join("\n") + "\n";
  const base = await commit(cwd, "shared.txt", original.join("\n") + "\n");
  await git(cwd, "switch", "-c", "layer");
  const tip = await commit(cwd, "shared.txt", content(1, "layer"));
  await git(cwd, "switch", "main");
  await commit(cwd, "shared.txt", content(3, "trunk"));
  await git(cwd, "branch", "oracle", "layer");
  await git(cwd, "rebase", "--onto", "main", base, "oracle");
  const store = memoryStore({ schemaVersion: 1, repository, stacks: [{
    trunk: { branch: "main", head: base }, branches: [{ branch: "layer", head: tip, base }],
  }] });
  const engine = new StackEngine(runner, store, cwd, join(cwd, ".git"));
  const plan = await engine.plan({ kind: "restack", root: "layer" });
  expect(plan.steps[0].proof?.preserved).toBe(1);
  await engine.apply(plan, "context", 1);
  expect(await git(cwd, "diff", "oracle", "layer")).toBe("");
}));

test("detaching a parent without a recorded child boundary removes the parent's patch", () => withStack(async ({ cwd, commonDir, initial, base }) => {
  delete initial.stacks[0].branches[1].base;
  const engine = new StackEngine(runner, memoryStore(initial), cwd, commonDir);
  const plan = await engine.plan({ kind: "remove", root: "bottom", branch: "bottom", mode: "detach" });
  await engine.apply(plan, "detach", 1);
  expect(await git(cwd, "log", "--format=%s", `${base}..top`)).toBe("top.txt");
}));

test("a missing branch ref does not free the catalog's branch name", () => withStack(async ({ cwd, engine }) => {
  await git(cwd, "branch", "-D", "bottom");
  await expect(engine.plan({ kind: "add_branch", root: "bottom", branch: "bottom" })).rejects.toThrow(/tracked/);
}));

test("enabling required signing after planning stops publication of unsigned replays", () => withStack(async ({ cwd, engine, bottom, top }) => {
  await commit(cwd, "trunk.txt", "advance\n");
  const plan = await engine.plan({ kind: "restack", root: "bottom" });
  await git(cwd, "config", "commit.gpgSign", "true");
  await expect(engine.apply(plan, "signing", 1)).rejects.toThrow(/signing/i);
  expect(await git(cwd, "rev-parse", "bottom", "top")).toBe(`${bottom}\n${top}`);
}));

test("a checkout missed by the last pre-commit snapshot remains in the journal", () =>
  withStack(async ({ cwd, commonDir, store, engine }) => {
    await commit(cwd, "trunk.txt", "advance\n");
    const plan = await engine.plan({ kind: "restack", root: "bottom" });
    const linked = join(cwd, "late");
    const race: GitRunner = { async run(path, args, opts) {
      if (args[0] === "update-ref" && args[1] === "--stdin") await git(cwd, "worktree", "add", "-q", linked, "top");
      return runner.run(path, args, opts);
    } };
    const interrupted = new StackEngine(race, store, cwd, commonDir);
    const commits: string[][] = [];
    await expect(interrupted.apply(plan, "late", 1, {
      begin: async entry => { commits.push(entry.worktrees.map(item => item.branch)); },
      finish: async () => { commits.length = 0; },
    })).rejects.toThrow(/membership/);
    expect(commits).toEqual([[], ["top"]]);
    expect((await store.read(commonDir)).catalog).toEqual(plan.before);
  })
);
