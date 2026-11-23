import { parseGhStackCatalog, requireWritableCatalog, type GhStackCatalog } from "./catalog";
import { isOid, StackGit } from "./git";
import { planStack } from "./plan";
import type { ApplyHooks, CatalogStore, GitRunner, StackJournal, StackOperation, StackPlan, StackReceipt } from "./types";

export * from "./catalog";
export * from "./types";

function undoPrefix(id: string): string {
  if (!/^[a-z0-9-]{1,80}$/.test(id)) throw new Error("Invalid stack operation ID");
  return `refs/pwragent/undo/${id}`;
}

function sameCatalog(a: GhStackCatalog, b: GhStackCatalog): boolean {
  // The in-memory catalog and the store preserve field order across writes.
  return JSON.stringify(a) === JSON.stringify(b);
}

export class StackEngine {
  private readonly git: StackGit;

  constructor(runner: GitRunner, private readonly store: CatalogStore, cwd: string, private readonly commonDir: string) {
    this.git = new StackGit(runner, cwd);
  }

  plan(operation: StackOperation): Promise<StackPlan> {
    return planStack(this.git, this.store, this.commonDir, operation);
  }

  async apply(plan: StackPlan, id: string, when: number, hooks: ApplyHooks = {}, cleanPrefix = false): Promise<StackReceipt> {
    const prefix = undoPrefix(id);
    const conflict = plan.steps.some(step => step.conflict);
    if (conflict && !(cleanPrefix && plan.cleanPrefix)) throw new Error("The stack plan has a conflict");
    return this.store.withOperationLock(this.commonDir, async () => {
      const { catalog, sha256 } = await this.store.read(this.commonDir);
      requireWritableCatalog(catalog);
      if (sha256 !== plan.catalogHash) throw new Error("The stack catalog changed. Plan the operation again.");
      await hooks.beforeTransaction?.();
      const receipt: StackReceipt = {
        id, when, moves: plan.moves, before: plan.before, after: (conflict && plan.cleanPrefix) || plan.after,
      };
      const manifest = (await this.git.output(["hash-object", "-w", "--stdin"], JSON.stringify(receipt))).trim();
      if (!isOid(manifest)) throw new Error("Invalid undo receipt object");
      const creates = [`create ${prefix}/receipt ${manifest}`];
      for (const move of receipt.moves) {
        await this.git.tip(move.branch);
        if (move.old) creates.push(`create ${prefix}/heads/${move.branch} ${move.old}`);
      }
      const worktrees = await this.git.worktrees(receipt.moves);
      await this.checkWorktrees(worktrees);
      if (plan.steps.some(step => step.newTip && step.newTip !== step.newBase && step.newTip !== step.oldTip)) {
        await this.git.requireReplayWithoutSigning();
        for (const { path } of worktrees) await this.git.requireReplayWithoutSigning(path);
      }
      await hooks.begin?.({ direction: "apply", receipt, worktrees });
      try {
        await this.git.requireMembership(receipt.moves, worktrees);
        // Undo refs and branch refs become visible in the same transaction.
        await this.git.transaction(receipt.moves, plan.expectedTips, creates);
      } catch (error) {
        const absent = await this.git.run(["show-ref", "--exists", `${prefix}/receipt`]).then(
          result => result.exitCode === 2, () => false,
        );
        if (absent) await hooks.finish?.("aborted", receipt);
        throw error;
      }
      await this.finish("apply", receipt, sha256, receipt.moves, worktrees, hooks);
      return receipt;
    });
  }

  async undo(id: string, hooks: ApplyHooks = {}): Promise<StackReceipt> {
    const prefix = undoPrefix(id);
    return this.store.withOperationLock(this.commonDir, async () => {
      const { catalog, sha256 } = await this.store.read(this.commonDir);
      requireWritableCatalog(catalog);
      const receipt = JSON.parse(await this.git.output(["cat-file", "blob", `${prefix}/receipt`])) as StackReceipt;
      const before = parseGhStackCatalog(JSON.stringify(receipt.before));
      const after = parseGhStackCatalog(JSON.stringify(receipt.after));
      requireWritableCatalog(before);
      requireWritableCatalog(after);
      if (receipt.id !== id || !sameCatalog(catalog, after)) {
        throw new Error("The stack catalog changed after this operation");
      }
      const moves = receipt.moves.map(({ branch, old, next }) => ({ branch, old: next, next: old }));
      await hooks.beforeTransaction?.();
      const worktrees = await this.git.worktrees(moves);
      await this.checkWorktrees(worktrees);
      const manifest = (await this.git.output(["rev-parse", "--verify", `${prefix}/receipt`])).trim();
      if (!isOid(manifest)) throw new Error("Invalid undo receipt object");
      await hooks.begin?.({ direction: "undo", receipt, worktrees });
      try {
        await this.git.requireMembership(moves, worktrees);
        await this.git.transaction(moves, {}, [`create ${prefix}/undone ${manifest}`]);
      } catch (error) {
        const unchanged = await this.git.run(["show-ref", "--exists", `${prefix}/undone`]).then(
          result => result.exitCode === 2, () => false,
        );
        if (unchanged) await hooks.finish?.("aborted", receipt);
        throw error;
      }
      await this.finish("undo", receipt, sha256, moves, worktrees, hooks);
      return receipt;
    });
  }

  /** Called by the host under the operation lock, before releasing any recovery holds. */
  async recover(entry: StackJournal, hooks: ApplyHooks): Promise<void> {
    const { receipt, direction, worktrees } = entry;
    const prefix = undoPrefix(receipt.id);
    const marker = `${prefix}/${direction === "apply" ? "receipt" : "undone"}`;
    const state = await this.git.run(["show-ref", "--exists", marker]);
    if (state.exitCode === 2) {
      await hooks.finish?.("aborted", receipt);
      return;
    }
    if (state.exitCode !== 0) throw new Error("Cannot verify the stack operation's ref transaction");
    const durable = JSON.parse(await this.git.output(["cat-file", "blob", marker])) as StackReceipt;
    if (JSON.stringify(receipt) !== JSON.stringify(durable)) throw new Error("The stack journal differs from its undo receipt");
    const { catalog, sha256 } = await this.store.read(this.commonDir);
    requireWritableCatalog(catalog);
    const before = direction === "apply" ? receipt.before : receipt.after;
    const after = direction === "apply" ? receipt.after : receipt.before;
    const moves = direction === "apply" ? receipt.moves : receipt.moves.map(({ branch, old, next }) => ({ branch, old: next, next: old }));
    for (const { branch, next } of moves) {
      if (await this.git.tip(branch) !== next) throw new Error(`Cannot recover stack operation after ${branch} moved again`);
    }
    if (!sameCatalog(catalog, before) && !sameCatalog(catalog, after)) throw new Error("Cannot recover after the stack catalog changed");
    await this.git.requireMembership(moves, worktrees);
    // git read-tree's two-tree update is safe to repeat after a partial follow.
    // Equal catalogs also occur when a transaction only changed refs.
    await this.finish(direction, receipt, sha256, moves, worktrees, hooks);
  }

  private async checkWorktrees(worktrees: StackPlan["worktrees"]) {
    const blocked = await this.git.dirtyOverlap(worktrees);
    if (blocked.length) {
      throw new Error(blocked.map(({ path, files }) => `Local changes in ${path}: ${files.join(", ")}`).join("\n"));
    }
  }

  private async finish(
    direction: "apply" | "undo", receipt: StackReceipt, sha256: string, moves: StackReceipt["moves"],
    worktrees: StackPlan["worktrees"], hooks: ApplyHooks,
  ): Promise<void> {
    // Leave the journal in place if anything after the ref commit fails. It
    // names the old/new tips and worktrees for recovery and blocks other apps.
    try {
      await this.git.requireMembership(moves, worktrees);
      for (const worktree of worktrees) await this.git.follow(worktree);
      await this.git.requireMembership(moves, worktrees);
    } catch (error) {
      const current = await this.git.worktrees(moves).catch(() => null);
      if (current) {
        // Include a checkout discovered after commit in recovery. A newly
        // checked-out branch may already have the new tree, in which case
        // the same two-tree transition is a no-op.
        const all = new Map([...worktrees, ...current].map(item => [JSON.stringify([item.path, item.branch]), item]));
        if (all.size > worktrees.length) await hooks.begin?.({ direction, receipt, worktrees: [...all.values()] });
      }
      throw error;
    }
    await this.store.writeIfUnchanged(this.commonDir, direction === "apply" ? receipt.after : receipt.before, sha256);
    await hooks.finish?.("committed", receipt);
  }
}
