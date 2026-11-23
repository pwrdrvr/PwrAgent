import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { StackEngine, requireWritableCatalog, type ApplyHooks, type GhStackCatalog, type RefMove, type StackOperation, type StackReceipt } from "@pwragent/owner-core/stacks/engine/index";
import { stackRoot } from "@pwragent/owner-core/stacks/engine/plan";
import { StackGit } from "@pwragent/owner-core/stacks/engine/git";
import { StackCoordinator, StackOperationError, type StackNotification, type StackParticipant, type StackThreadRef } from "@pwragent/owner-core/stacks/stack-coordinator";
import { buildThreadIdentityKey } from "@pwragent/shared/contracts/navigation";
import { federatedThreadIdentityKey } from "@pwragent/shared/contracts/federation";
import { stackLayerBinding, type StackSummary } from "@pwragent/shared/stacks/stack-status";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { readForgeRepositoryRemotes } from "../pr-status/git-remote";
import { getDesktopOverlayStore } from "../storage/desktop-overlay-store";
import { GhStackCatalogStore, stackGitRunner } from "./stack-engine-ports";
import { readStackClones } from "./stack-reader";

export type StackToolArgs = {
  operation?: StackOperation["kind"];
  stack?: string;
  branch?: string;
  name?: string;
  from?: string;
  mode?: "detach" | "forget";
  branches?: string[];
  planId?: string;
  opId?: string;
  threadId?: string;
  action?: "status" | "abort" | "undo" | "continue" | "release_thread";
};

type StackScope = {
  directories: readonly string[];
  repository: string;
  branch?: string;
  infer(): Promise<StackSummary[]>;
};

function pathKey(value: string) {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export class StackOperationsService {
  private readonly sessions = new Map<string, StackCoordinator>();

  async resumeInterrupted(directories: readonly string[], registry: DesktopBackendRegistry): Promise<string[]> {
    const results = await Promise.allSettled((await readStackClones(directories))
      .map((clone) => this.recoverClone(clone, registry)));
    return results.flatMap((result) => result.status === "rejected" ? [String(result.reason)] : []);
  }

  async call(
    tool: "plan_stack_operation" | "apply_stack_operation" | "manage_stack_operation",
    args: StackToolArgs,
    actor: StackThreadRef,
    scope: StackScope,
    registry: DesktopBackendRegistry,
  ): Promise<unknown> {
    const clones = await readStackClones(scope.directories);
    const matches = await Promise.all(clones.map(async (clone) => ({ clone, linked: (await readForgeRepositoryRemotes(clone.cwd))
      .some(({ host, owner, repo }) => `${host}:${owner}/${repo}`.toLowerCase() === scope.repository) })));
    const linked = matches.filter((candidate) => candidate.linked);
    const clone = linked.length === 1 ? linked[0]?.clone : undefined;
    if (!clone) throw new StackOperationError("ambiguous_repository", "Use a thread linked to one checkout of the selected repository.");
    if (clone.catalog.status === "catalog_schema_unknown") {
      throw new StackOperationError("catalog_schema_unknown", "This checkout uses a newer gh stack catalog.");
    }
    if (clone.catalog.status === "catalog_invalid" || clone.catalog.status === "unavailable") {
      throw new StackOperationError("catalog_invalid", "The gh stack catalog could not be read safely.");
    }
    if (tool === "apply_stack_operation" || args.action === "undo") await this.recoverClone(clone, registry, actor);
    const store = new GhStackCatalogStore();
    const git = new StackGit(stackGitRunner, clone.cwd);
    const session = this.session(clone, store, git, registry);
    if (tool === "manage_stack_operation") {
      if (args.action === "undo") return await session.undo(actor, args.opId!);
      if (args.action === "abort") return session.abort(actor, args.opId!);
      if (args.action === "continue") return await session.continue(actor, args.opId!);
      if (args.action === "release_thread") return session.releaseThread(actor, args.opId!, args.threadId!);
      return session.status(actor, args.opId!);
    }
    if (tool === "apply_stack_operation" && args.planId) return session.apply(actor, args.planId);
    const operation = await this.resolveOperation(args, scope, clone.commonDir, store, git);
    const forecast = await session.plan(actor, operation);
    return tool === "apply_stack_operation" ? session.apply(actor, forecast.planId) : forecast;
  }

  private async resolveOperation(args: StackToolArgs, scope: StackScope, commonDir: string, store: GhStackCatalogStore, git: StackGit): Promise<StackOperation> {
    const { catalog } = await store.read(commonDir);
    requireWritableCatalog(catalog);
    if (catalog.repository && catalog.repository.toLowerCase() !== scope.repository) {
      throw new StackOperationError("ambiguous_repository", "The selected repository does not match this checkout's catalog.");
    }
    const branch = args.branch ?? scope.branch;
    const selector = args.stack ?? (args.operation === "add_branch" ? scope.branch : branch);
    if (args.operation === "adopt") {
      const requested = args.branches;
      const stacks = (await scope.infer()).filter((stack) => stack.inferred && stack.repository === scope.repository
        && (requested ? requested.join("\0") === stack.layers.map((layer) => layer.branch).join("\0")
          : !selector || stack.name === selector || stack.layers.some((layer) => layer.branch === selector)));
      if (stacks.length !== 1) throw new StackOperationError("ambiguous_layer", "Select one inferred open pull request chain to adopt.");
      const inferred = stacks[0]!;
      const trunkHead = await git.tip(inferred.trunk);
      if (!trunkHead) throw new StackOperationError("invalid_arguments", "The inferred trunk needs a local branch.");
      const branches = await Promise.all(inferred.layers.map(async (layer) => {
        const head = await git.tip(layer.branch);
        const parentTip = await git.tip(layer.parent);
        if (!head || !parentTip) throw new StackOperationError("invalid_arguments", `Both ${layer.branch} and ${layer.parent} need local branches.`);
        const base = (await git.output(["merge-base", parentTip, head])).trim();
        return {
          branch: layer.branch, head, base,
          ...(layer.pullRequest ? { pullRequest: { number: layer.pullRequest.number } } : {}),
        };
      }));
      return { kind: "adopt", repository: scope.repository, stack: { trunk: { branch: inferred.trunk, head: trunkHead }, branches } };
    }
    const matched = catalog.stacks.filter((stack) => !selector || stackRoot(stack) === selector
      || stack.branches.some((layer) => layer.branch === selector));
    const root = matched.length === 1 ? stackRoot(matched[0]!) : undefined;
    if (!root) throw new StackOperationError("ambiguous_layer", "Select one tracked stack by its bottom branch or a member branch.");
    if (args.operation === "restack") return { kind: "restack", root, from: args.from };
    if (args.operation === "add_branch" && (args.name || args.branch)) return { kind: "add_branch", root, branch: (args.name ?? args.branch)! };
    if (args.operation === "remove" && branch) return { kind: "remove", root, branch, mode: args.mode ?? "forget" };
    throw new StackOperationError("invalid_arguments", "Specify the operation and its branch.");
  }

  private session(clone: { cwd: string; commonDir: string }, store: GhStackCatalogStore, git: StackGit, registry: DesktopBackendRegistry): StackCoordinator {
    const existing = this.sessions.get(clone.commonDir);
    if (existing) return existing;
    const engine = new StackEngine(stackGitRunner, store, clone.cwd, clone.commonDir);
    const coordinator = new StackCoordinator({
      newId: randomUUID,
      now: Date.now,
      plan: (operation) => engine.plan(operation),
      participants: async (moves, catalog) => await this.participants(git, moves, catalog, registry),
      hold: (thread) => registry.holdStackThread(thread),
      subscribe: (listener) => registry.onEvent(listener),
      exclusive: (fn) => registry.withStackWorktreeMutation(clone.commonDir, fn),
      apply: (plan, id, now, hooks, notification) => this.runJournalled(clone, registry, store, engine, git, hooks, notification,
        (journal) => engine.apply(plan, id, now, journal)),
      undo: (id, hooks, notification) => this.runJournalled(clone, registry, store, engine, git, hooks, notification,
        (journal) => engine.undo(id, journal)),
      receipt: async (id) => {
        if (!/^[a-z0-9-]{1,80}$/.test(id)) throw new StackOperationError("invalid_arguments", "Use the operation ID returned by apply_stack_operation.");
        return JSON.parse(await git.output(["cat-file", "blob", `refs/pwragent/undo/${id}/receipt`])) as StackReceipt;
      },
    });
    this.sessions.set(clone.commonDir, coordinator);
    return coordinator;
  }

  private async notify(registry: DesktopBackendRegistry, git: StackGit, receipt: StackReceipt, { opId, kind, actor, participants }: StackNotification) {
    for (const participant of participants) {
      const moved = receipt.moves.find((entry) => entry.branch === participant.branch);
      if (!moved || moved.old === moved.next) continue;
      const move = kind === "undo" ? { branch: moved.branch, old: moved.next, next: moved.old } : moved;
      const catalog = kind === "undo" ? receipt.before : receipt.after;
      const stack = catalog.stacks.find((entry) => entry.branches.some((branch) => branch.branch === move.branch));
      const index = stack?.branches.findIndex((branch) => branch.branch === move.branch) ?? -1;
      const files = move.old && move.next
        ? (await git.output(["diff", "--name-only", "-z", move.old, move.next])).split("\0").filter(Boolean).slice(0, 100)
        : [];
      registry.publishStackNotice(participant, {
        opId, kind, by: { threadId: actor.threadId, actor: "agent" }, stack: (stack && stackRoot(stack)) ?? move.branch,
        branch: move.branch, from: move.old, to: move.next, changedFiles: files,
        ...(stack && index >= 0 ? { position: [index + 1, stack.branches.length], parent: stack.branches[index - 1]?.branch ?? stack.trunk.branch } : {}),
        undo: `refs/pwragent/undo/${receipt.id}`,
      });
    }
  }

  private async runJournalled(
    clone: { cwd: string; commonDir: string },
    registry: DesktopBackendRegistry,
    store: GhStackCatalogStore,
    engine: StackEngine,
    git: StackGit,
    hooks: ApplyHooks,
    notification: StackNotification,
    operate: (journal: ApplyHooks) => Promise<StackReceipt>,
  ): Promise<StackReceipt> {
    const journal = store.journalHooks(clone.commonDir, notification);
    const applyHooks: ApplyHooks = {
      ...journal, ...hooks,
      finish: async (outcome, receipt) => {
        if (outcome === "committed") await this.notify(registry, git, receipt, notification);
        await journal.finish?.(outcome, receipt);
      },
    };
    let operationStarted = false;
    try {
      return await operate({ ...applyHooks, begin: async (entry) => {
        await applyHooks.begin?.(entry);
        operationStarted = true;
      } });
    } catch (error) {
      if (operationStarted && await store.hasJournal(clone.commonDir)) {
        let recovered: StackReceipt | undefined;
        await store.recover(clone.commonDir, async (entry) => {
          if (entry.notification.opId !== notification.opId) throw error;
          await engine.recover(entry, { finish: async (outcome, receipt) => {
            if (outcome === "aborted") return;
            await this.notify(registry, git, receipt, notification);
            recovered = receipt;
          } });
        });
        if (recovered) return recovered;
      }
      throw error;
    }
  }

  private async recoverClone(clone: { cwd: string; commonDir: string }, registry: DesktopBackendRegistry, actor?: StackThreadRef): Promise<void> {
    const store = new GhStackCatalogStore();
    if (!await store.hasJournal(clone.commonDir)) return;
    const git = new StackGit(stackGitRunner, clone.cwd);
    const engine = new StackEngine(stackGitRunner, store, clone.cwd, clone.commonDir);
    await registry.withStackWorktreeMutation(clone.commonDir, () => store.recover(clone.commonDir, async (entry) => {
      const release: Array<() => void> = [];
      try {
        const { receipt, direction, notification } = entry;
        const moves = direction === "apply" ? receipt.moves : receipt.moves.map(({ branch, old, next }) => ({ branch, old: next, next: old }));
        const participants = await this.participants(git, moves, direction === "apply" ? receipt.before : receipt.after, registry);
        for (const thread of participants) {
          if (thread.remote || thread.locked || (thread.active && (thread.backend !== actor?.backend || thread.threadId !== actor.threadId))) {
            throw new StackOperationError("gh_stack_busy", `Finish the active work on ${thread.branch} before recovering the interrupted stack operation.`);
          }
          release.push(registry.holdStackThread(thread));
        }
        await engine.recover(entry, { finish: async (outcome) => {
          if (outcome === "committed") await this.notify(registry, git, receipt, notification);
        } });
      } finally {
        for (const unlock of release.reverse()) unlock();
      }
    }));
  }

  private async participants(git: StackGit, moves: readonly RefMove[], catalog: GhStackCatalog, registry: DesktopBackendRegistry): Promise<StackParticipant[]> {
    if (!moves.length) return [];
    const worktrees = await git.worktrees([...moves]);
    const threads = await registry.listThreads({ callerReason: "stack-operation" });
    if (registry.isIncompleteThreadList(threads)) throw new StackOperationError("ambiguous_layer", "Complete local thread ownership is unavailable.");
    const overlays = await Promise.all(threads.map(async (thread) => {
      const ref = { backend: thread.source, threadId: thread.id };
      const overlay = await getDesktopOverlayStore().getThreadOverlayState(ref);
      const paths = new Set([
        ...(thread.linkedDirectories ?? []).map((dir) => dir.worktreePath ?? dir.path),
        ...(overlay?.extraLinkedDirectories ?? []).map((dir) => dir.worktreePath ?? dir.path),
        ...(overlay?.worktreeRegistrations ?? []).map((dir) => dir.worktreePath),
      ]);
      const roots = await Promise.all([...paths].map(async (directory) => pathKey(await realpath(directory).catch(() => directory))));
      return { ...ref, key: buildThreadIdentityKey(ref.backend, ref.threadId), title: thread.title, locked: Boolean(overlay?.lock), paths: roots };
    }));
    const storage = getDesktopOverlayStore();
    const prs = storage.readNavigationPullRequests(overlays);
    const repositoryPr = (pr: { provider: string; org: string; repo: string }) =>
      `${pr.provider}:${pr.org}/${pr.repo}`.toLowerCase() === catalog.repository.toLowerCase();
    const bindings = overlays.map((thread, index) => ({ ...thread, attached: (prs[index] ?? [])
      .filter(repositoryPr).map(({ number }) => number) }));
    const remote = (await storage.listRemoteThreadPins()).flatMap(({ ref, summary }) => summary ? [{
      key: federatedThreadIdentityKey(ref), title: summary.title, paths: [], remote: true as const,
      attached: (summary.prs ?? []).filter(repositoryPr).map(({ number }) => number),
    }] : []);
    const paths = await Promise.all(worktrees.map(async ({ path, branch }) => ({ path: pathKey(await realpath(path)), branch })));
    const owners: StackParticipant[] = [];
    for (const { branch } of moves) {
      const pullRequest = catalog.stacks.flatMap((stack) => stack.branches).find((layer) => layer.branch === branch)?.pullRequest?.number;
      const binding = stackLayerBinding({ branch, pullRequest, worktrees: paths, threads: [...bindings, ...remote] });
      if (binding.role === "ambiguous") throw new StackOperationError("ambiguous_layer", `Multiple checkouts or threads claim ${branch}.`);
      if (binding.role === "remote") throw new StackOperationError("layer_remote", `${branch} is assigned to ${binding.thread.title} on another instance.`);
      if (binding.role !== "layer") continue;
      const { backend, threadId, title, locked } = bindings.find(({ key }) => key === binding.thread.key)!;
      const thread = { backend, threadId };
      owners.push({ ...thread, title, locked, branch, active: registry.stackThreadActive(thread), remote: false });
    }
    return owners;
  }
}
