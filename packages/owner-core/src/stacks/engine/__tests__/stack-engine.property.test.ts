import fc from "fast-check";
import { expect, test } from "vitest";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { StackEngine } from "../index";
import { commit, git, memoryStore, repository, runner, withRepo, withStack } from "./fixture.test-support";

// Keep each real-Git trace within the owner-core test budget.
test.each(Array.from({ length: 12 }, (_, i) => i + 1))("Git agrees with the stack model through commits, amends, adoption, removal and undo (trace %i)", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("commit", "amend", "restack", "adopt", "remove", "undo"), { minLength: 3, maxLength: 8 }),
    async operations => withStack(async ({ cwd, commonDir, initial, store, engine }) => {
      let tracked = ["bottom", "top"];
      const anchors = new Map(initial.stacks[0].branches.map(layer => [layer.branch, layer.base]));
      let last: { id: string; tracked: string[]; tips: string } | undefined;
      for (const [index, operation] of operations.entries()) {
        const id = `model-${index}`;
        const tips = await git(cwd, "rev-parse", "bottom", "top");
        if (operation === "commit" || operation === "amend") {
          const file = operation === "commit" ? `trunk-${index}.txt` : "base.txt";
          if (operation === "amend" && tracked.length === 2) {
            await git(cwd, "switch", "-q", "bottom");
            await commit(cwd, "bottom.txt", `amended ${index}\n`, true);
            await git(cwd, "switch", "-q", "main");
          } else await commit(cwd, file, `trunk ${index}\n`);
          last = undefined;
        } else if (operation === "undo" && last) {
          await engine.undo(last.id);
          expect(await git(cwd, "rev-parse", "bottom", "top")).toBe(last.tips);
          tracked = last.tracked;
          last = undefined;
        } else if (operation === "restack" && tracked.length) {
          const plan = await engine.plan({ kind: "restack", root: tracked[0] });
          const receipt = await engine.apply(plan, id, index);
          last = { id, tracked, tips };
          const layers = ["main", ...tracked];
          for (let layer = 1; layer < layers.length; layer += 1) {
            expect((await runner.run(cwd, ["merge-base", "--is-ancestor", layers[layer - 1], layers[layer]])).exitCode).toBe(0);
          }
          for (const step of plan.steps) {
            const patchIds = async (range: string) => {
              const diff = await runner.run(cwd, ["log", "-p", range]);
              const patch = await runner.run(cwd, ["patch-id", "--stable"], { stdin: diff.stdout });
              return patch.stdout.trim().split("\n").filter(Boolean).map(line => line.split(" ")[0]).sort();
            };
            expect(await patchIds(`${step.newBase}..${step.newTip}`)).toEqual(await patchIds(`${step.oldBase}..${step.oldTip}`));
          }
          for (const move of receipt.moves) {
            const saved = await git(cwd, "rev-parse", `refs/pwragent/undo/${id}/heads/${move.branch}`);
            expect(saved).toBe(move.old);
            expect(await git(cwd, "rev-list", move.old!, "--not", saved)).toBe("");
          }
        } else if (operation === "remove" && tracked.length) {
          const branch = tracked.at(-1)!;
          const plan = await engine.plan({ kind: "remove", root: tracked[0], branch, mode: "forget" });
          await engine.apply(plan, id, index);
          last = { id, tracked, tips };
          tracked = tracked.slice(0, -1);
        } else if (operation === "adopt" && tracked.length === 0) {
          const state = await store.read(commonDir);
          // Adopt the current tips with the bases recorded before forgetting.
          const branches = initial.stacks[0].branches.map(({ branch }) => {
            const base = anchors.get(branch);
            return base ? { branch, base } : { branch };
          });
          const plan = await engine.plan({ kind: "adopt", repository, stack: { ...initial.stacks[0], branches } });
          expect(plan.catalogHash).toBe(state.sha256);
          await engine.apply(plan, id, index);
          last = { id, tracked, tips };
          tracked = branches.map(branch => branch.branch);
        }
        const result = await store.read(commonDir);
        for (const layer of result.catalog.stacks.flatMap(stack => stack.branches)) anchors.set(layer.branch, layer.base);
        expect(result.catalog.stacks.flatMap(stack => stack.branches.map(layer => layer.branch))).toEqual(tracked);
      }
    })), { numRuns: 1 });
});

test.each(Array.from({ length: 9 }, (_, i) => i + 1))("replay forecasts agree with rebase conflict files, and clean forecasts apply (trace %i)", async () => {
  await fc.assert(fc.asyncProperty(fc.subarray(["one.txt", "two.txt", "three.txt"]), fc.boolean(),
    (overlap, firstPatch) => withRepo(async (cwd, initial) => {
      const filenames = ["one.txt", "two.txt", "three.txt"];
      for (const file of filenames) await commit(cwd, file, "common\n");
      const base = await git(cwd, "rev-parse", "HEAD");
      await git(cwd, "switch", "-qc", "layer");
      if (firstPatch) await commit(cwd, "earlier.txt", "earlier\n");
      for (const file of filenames) {
        await writeFile(join(cwd, file), "feature\n");
      }
      await git(cwd, "add", "--", ...filenames);
      await git(cwd, "commit", "-qm", "feature");
      const tip = await git(cwd, "rev-parse", "HEAD");
      await git(cwd, "switch", "-q", "main");
      for (const file of overlap) await commit(cwd, file, "trunk\n");
      if (!overlap.length) await commit(cwd, "trunk.txt", initial);
      const store = memoryStore({
        schemaVersion: 1, repository, stacks: [{
          trunk: { branch: "main", head: base }, branches: [{ branch: "layer", base, head: tip }],
        }],
      });
      const engine = new StackEngine(runner, store, cwd, join(cwd, ".git"));
      const plan = await engine.plan({ kind: "restack", root: "layer" });
      const forecast = plan.steps[0].conflict;
      const oracle = await runner.run(cwd, ["rebase", "--onto", "main", base, "layer"]);
      if (oracle.exitCode === 0) {
        expect(forecast).toBeUndefined();
        await git(cwd, "reset", "--hard", tip);
        await engine.apply(plan, "forecast", 1);
        expect(await git(cwd, "rev-parse", "layer")).toBe(plan.steps[0].newTip);
      } else {
        expect(forecast).toBeDefined();
        expect(forecast?.commit).toBe(await git(cwd, "rev-parse", "REBASE_HEAD"));
        const files = (await git(cwd, "diff", "--name-only", "--diff-filter=U")).split("\n").sort();
        expect(forecast?.files.toSorted()).toEqual(files);
        await git(cwd, "rebase", "--abort");
      }
    })), { numRuns: 1 });
});
