import { requireWritableCatalog, type GhStack, type GhStackBranch, type GhStackCatalog } from "./catalog";
import { isOid, StackGit } from "./git";
import { replayStep } from "./replay";
import type { CatalogStore, StackOperation, StackPlan } from "./types";

export function stackRoot(stack: GhStack): string | undefined {
  return stack.branches[0]?.branch;
}

async function collectTips(git: StackGit, branches: GhStackBranch[]) {
  const entries = await Promise.all(branches.map(async ({ branch }) => [branch, await git.tip(branch)] as const));
  return Object.fromEntries(entries);
}

function requireTip(tips: StackPlan["expectedTips"], branch: string): string {
  const tip = tips[branch];
  if (!tip) throw new Error(`Local branch ${branch} is missing`);
  return tip;
}

async function restack(git: StackGit, plan: StackPlan, stack: GhStack, first: number) {
  const tips = plan.expectedTips;
  const parentAt = (index: number) => stack.branches[index - 1] ?? stack.trunk;
  for (let index = first; index < stack.branches.length; index += 1) {
    const layer = stack.branches[index];
    const parent = parentAt(index);
    const oldTip = requireTip(tips, layer.branch);
    const newBase = plan.moves.find(move => move.branch === parent.branch)?.next ?? requireTip(tips, parent.branch);
    const oldBase = layer.base || (await git.output(["merge-base", newBase, oldTip])).trim();
    if (!isOid(oldBase)) throw new Error(`Cannot find the base of ${layer.branch}`);
    if (oldBase === newBase && await git.ancestor(oldBase, oldTip)) {
      layer.head = oldTip;
      layer.base = newBase;
      continue;
    }
    const prefix = structuredClone(plan.after);
    const step = await replayStep(git, { branch: layer.branch, parent: parent.branch, oldBase, newBase, oldTip });
    plan.steps.push(step);
    if (step.conflict) {
      if (plan.operation.kind === "restack" && plan.moves.length) plan.cleanPrefix = prefix;
      return;
    }
    if (!step.newTip) throw new Error(`Missing replay output for ${layer.branch}`);
    if (step.newTip !== oldTip) plan.moves.push({ branch: layer.branch, old: oldTip, next: step.newTip });
    layer.head = step.newTip;
    layer.base = newBase;
  }
}

function assertAdoptable(catalog: GhStackCatalog, stack: GhStack, repository: string) {
  if (!repository || (catalog.repository && catalog.repository.toLowerCase() !== repository.toLowerCase())) {
    throw new Error("The inferred stack belongs to a different repository");
  }
  const occupied = new Set(catalog.stacks.flatMap(existing => existing.branches.map(layer => layer.branch)));
  const names = [stack.trunk, ...stack.branches].map(layer => layer.branch);
  if (!stack.branches.length || new Set(names).size !== names.length || stack.branches.some(layer => occupied.has(layer.branch))) {
    throw new Error("The inferred chain overlaps a tracked stack or repeats a branch");
  }
}

export async function planStack(git: StackGit, store: CatalogStore, commonDir: string, operation: StackOperation): Promise<StackPlan> {
  const { catalog: before, sha256 } = await store.read(commonDir);
  requireWritableCatalog(before);
  const after = structuredClone(before);
  let stack: GhStack;
  if (operation.kind === "adopt") {
    stack = structuredClone(operation.stack);
    assertAdoptable(before, stack, operation.repository);
    after.repository ||= operation.repository;
    after.stacks.push(stack);
  } else {
    const match = after.stacks.find(candidate => stackRoot(candidate) === operation.root);
    if (!match) throw new Error("The stack is no longer tracked");
    stack = match;
  }
  const expectedTips = await collectTips(git, [stack.trunk, ...stack.branches]);
  const plan: StackPlan = {
    operation, expectedTips, steps: [], moves: [], worktrees: [], blocked: [], catalogHash: sha256, before, after,
  };
  if (operation.kind === "add_branch") {
    const { branch } = operation;
    await git.output(["check-ref-format", "--branch", branch]);
    if (before.stacks.some(({ trunk, branches }) => trunk.branch === branch || branches.some(layer => layer.branch === branch))) {
      throw new Error(`Branch ${branch} is already tracked in the stack catalog`);
    }
    if (await git.tip(branch) !== null) throw new Error(`Branch ${branch} already exists`);
    const top = stack.branches.at(-1) ?? stack.trunk;
    const tip = requireTip(expectedTips, top.branch);
    stack.branches.push({ branch, head: tip, base: tip });
    plan.moves.push({ branch, old: null, next: tip });
  } else if (operation.kind === "remove") {
    const index = stack.branches.findIndex(layer => layer.branch === operation.branch);
    if (index < 0) throw new Error("The branch is no longer in this stack");
    const removed = stack.branches[index];
    const child = stack.branches[index + 1];
    if (child && operation.mode === "detach" && !child.base) {
      const childTip = requireTip(expectedTips, child.branch);
      const anchors = [removed.head, expectedTips[removed.branch]];
      for (const anchor of anchors) {
        if (anchor && isOid(anchor) && await git.ancestor(anchor, childTip) &&
            (!child.base || await git.ancestor(child.base, anchor))) {
          child.base = anchor;
        }
      }
      if (!child.base) throw new Error(`Cannot determine the old parent boundary for ${child.branch}`);
    }
    stack.branches.splice(index, 1);
    if (!stack.branches.length) after.stacks.splice(after.stacks.indexOf(stack), 1);
    if (child && operation.mode === "detach") await restack(git, plan, stack, index);
    if (child && operation.mode === "forget") {
      // Preserve the forgotten patches in the child's range on a future restack.
      if (removed.base) child.base = removed.base;
      else delete child.base;
    }
  } else {
    const from = operation.kind === "restack" ? operation.from : undefined;
    const first = from === undefined ? 0 : stack.branches.findIndex(layer => layer.branch === from);
    if (first < 0) throw new Error("The starting branch is no longer in this stack");
    if (first === 0) stack.trunk.head = requireTip(expectedTips, stack.trunk.branch);
    await restack(git, plan, stack, first);
  }
  plan.worktrees = await git.worktrees(plan.moves);
  plan.blocked = await git.dirtyOverlap(plan.worktrees);
  return plan;
}
