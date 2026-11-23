import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { StackEngine, type StackJournal } from "../engine/index";
import { commit, git, runner, withStack } from "../engine/__tests__/fixture.test-support";

it.each([
  ["before-commit", false], ["after-commit", false], ["after-catalog", false],
  ["before-commit", true], ["after-commit", true], ["after-catalog", true],
] as const)("recovers after %s with undo=%s and preserves disjoint dirty files", async (phase, undo) => {
  await withStack(async ({ cwd, commonDir, store, engine, initial, bottom, top }) => {
    await commit(cwd, "trunk.txt", "advanced\n");
    const dirs = join(cwd, "linked-worktrees");
    await mkdir(dirs);
    const checkout = join(dirs, "top");
    await git(cwd, "worktree", "add", checkout, "top");
    await writeFile(join(checkout, "top.txt"), "uncommitted\n");
    const plan = await engine.plan({ kind: "restack", root: "bottom" });
    const id = "recovery-case";
    if (undo) await engine.apply(plan, id, 1);
    const crash = new Error("power lost");
    const interrupted = new StackEngine({
      run: async (dir, args, opts) => {
        if (phase === "after-commit" && args[0] === "read-tree" && args[1] === "-m") throw crash;
        return await runner.run(dir, args, opts);
      },
    }, store, cwd, commonDir);
    let journal: StackJournal | undefined;
    const hooks = {
      begin: async (entry: StackJournal) => {
        journal = entry;
        if (phase === "before-commit") throw crash;
      },
      finish: async () => { throw crash; },
    };
    await expect(undo ? interrupted.undo(id, hooks) : interrupted.apply(plan, id, 1, hooks)).rejects.toBe(crash);
    expect(journal).toBeDefined();
    const outcomes: string[] = [];
    await engine.recover(journal!, { finish: async (outcome) => { outcomes.push(outcome); } });
    const committed = phase !== "before-commit";
    const moved = committed !== undo;
    const after = (branch: string) => journal!.receipt.moves.find((move) => move.branch === branch)?.next;
    expect(outcomes).toEqual([committed ? "committed" : "aborted"]);
    expect(await git(cwd, "rev-parse", "bottom")).toBe(moved ? after("bottom") : bottom);
    expect(await git(cwd, "rev-parse", "top")).toBe(moved ? after("top") : top);
    expect((await store.read(commonDir)).catalog).toEqual(moved ? journal!.receipt.after : initial);
    expect(await readFile(join(checkout, "top.txt"), "utf8")).toBe("uncommitted\n");
    expect(await git(checkout, "status", "--short")).toBe("M top.txt");
  });
});
