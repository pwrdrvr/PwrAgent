import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { StackEngine, requireWritableCatalog, type ApplyHooks, type GhStackCatalog, type RefMove, type StackJournal, type StackOperation, type StackReceipt, type StackPlan } from "@pwragent/owner-core/stacks/engine/index";
import { stackRoot } from "@pwragent/owner-core/stacks/engine/plan";
import { isOid, StackGit } from "@pwragent/owner-core/stacks/engine/git";
import { StackCoordinator, StackOperationError, type StackApplyOptions, type StackNotification, type StackParticipant, type StackThreadRef } from "@pwragent/owner-core/stacks/stack-coordinator";
import { ThreadStartNotAdmittedError } from "@pwragent/owner-core/thread-creation-lifecycle";
import { buildThreadIdentityKey } from "@pwragent/shared/contracts/navigation";
import { federatedThreadIdentityKey } from "@pwragent/shared/contracts/federation";
import { stackLayerBinding, type StackSummary } from "@pwragent/shared/stacks/stack-status";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { readForgeRepositoryRemotes } from "../pr-status/git-remote";
import { getDesktopOverlayStore } from "../storage/desktop-overlay-store";
import { GhStackCatalogStore, STACK_OPERATION_JOURNAL, stackGitRunner, type RuntimeJournal, type StackProvisioning } from "./stack-engine-ports";
import { PR_METADATA_PRIORITY } from "../pr-status/pr-metadata-process";
import { readStackClones, StackReadObservation } from "./stack-reader";
import { applyStackLayerEdits, captureStackLayerEdits } from "../app-server/git-workspace-handoff-service";
import { updateLocalSubthreadOrder } from "../app-server/subthread-order-actions";

import { pushStackLayers } from "@pwragent/owner-core/stacks/engine/publish";
import type { StackLayer } from "@pwragent/shared/stacks/stack-status";
import { describeStackAutomationBlock } from "@pwragent/shared/stacks/stack-automation";
import type { ForgeCiClient } from "../pr-status/forge-ci-client";
import type { ForgeRepository } from "../pr-status/forge-tool-contract";
import { completeStackPublication, readStackTrunk, readStackPublishTarget, stackPublishRemote } from "./github-stack-publish";

type StackPublishRequest = {
  number: number;
  actor: StackThreadRef;
  repository: ForgeRepository;
  directories: readonly string[];
  expectedHead: string;
  automated: boolean;
  signal?: AbortSignal;
  readGate: () => Promise<{ layer: StackLayer; stack: StackSummary }>;
  github: ForgeCiClient["requestGithub"];
};

export type StackToolArgs = StackApplyOptions & {
  operation?: StackOperation["kind"];
  stack?: string;
  branch?: string;
  name?: string;
  from?: string;
  stopBefore?: string;
  mode?: "detach" | "forget";
  branches?: string[];
  planId?: string;
  opId?: string;
  threadId?: string;
  action?: "status" | "abort" | "undo" | "continue" | "release_thread" | "interrupt" | "route_conflict" | "set_lead";
};

type StackScope = {
  directories: readonly string[];
  repository: string;
  branch?: string;
  infer(): Promise<StackSummary[]>;
  sync?: {
    repository: ForgeRepository;
    github: ForgeCiClient["requestGithub"];
    signal?: AbortSignal;
  };
};

function pathKey(value: string) {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function stackLeadKey(commonDir: string, root: string): string {
  return createHash("sha256").update(JSON.stringify([commonDir, root])).digest("hex");
}

function stackPublishProofRef(repository: string, branch: string): string {
  const hash = createHash("sha256").update(JSON.stringify([repository.toLowerCase(), branch])).digest("hex");
  return `refs/pwragent/stack-publish/${hash}`;
}

async function readPublishProof(git: StackGit, ref: string, branch: string, tip: string | null) {
  const result = await git.run(["show-ref", "--verify", "--hash", ref]);
  if (result.exitCode !== 0) return undefined;
  const oid = result.stdout.trim();
  if (!isOid(oid)) throw new Error("Invalid publish receipt");
  const receipt = JSON.parse(await git.output(["cat-file", "blob", oid])) as StackReceipt;
  const move = receipt.moves.find((move) => move.branch === branch && move.next === tip);
  const durable = move && await git.run(["rev-parse", "--verify", `refs/pwragent/undo/${receipt.id}/receipt`]);
  const boundaries = durable && durable.exitCode === 0 && durable.stdout.trim() === oid
    ? [move?.old, Object.hasOwn(receipt.publishBoundaries ?? {}, branch) ? receipt.publishBoundaries?.[branch] : undefined]
      .filter((value): value is string => typeof value === "string" && isOid(value)) : [];
  return { oid, boundaries };
}

export async function prepareStackPublishReceipt(git: StackGit, receipt: StackReceipt, carried?: { branch: string; tip: string }) {
  const refs = await Promise.all(receipt.moves.map(async ({ branch, old }) => {
    const ref = stackPublishProofRef(receipt.before.repository, branch);
    const previous = await readPublishProof(git, ref, branch, old);
    return { branch, ref, previous };
  }));
  receipt.publishBoundaries = Object.fromEntries(refs.flatMap(({ branch, previous }) => {
    const tip = carried?.branch === branch ? carried.tip : previous?.boundaries.at(-1);
    return tip ? [[branch, tip]] : [];
  }));
  return (manifest: string) => refs.map(({ ref, previous }) => previous
    ? `update ${ref} ${manifest} ${previous.oid}`
    : `create ${ref} ${manifest}`);
}
const ownerEpoch = randomUUID();

export class StackOperationsService {
  private readonly sessions = new Map<string, StackCoordinator>();
  private readonly finishing = new Map<string, Promise<StackThreadRef | undefined>>();
  private readonly abandoning = new Map<string, Promise<boolean>>();

  constructor(
    private readonly epoch: string = ownerEpoch,
    private readonly readStacks?: (cwd: string) => Promise<readonly StackSummary[]>,
  ) {}

  private async validateLayerApply(cwd: string, plan: StackPlan): Promise<void> {
    const { operation } = plan;
    if (!this.readStacks || (operation.kind !== "restack" && operation.kind !== "sync")) return;
    const stack = (await this.readStacks(cwd)).find((entry) => !entry.inferred
      && entry.name === operation.root && entry.repository === plan.before.repository.toLowerCase());
    const moved = new Set([...plan.moves, ...plan.steps].map(({ branch }) => branch));
    const held = stack?.layers.find((layer) => moved.has(layer.branch) && layer.heldBy)?.heldBy;
    if (held) throw new StackOperationError("stack_parent_open", describeStackAutomationBlock(held));
  }

  async resumeInterrupted(directories: readonly string[], registry: DesktopBackendRegistry): Promise<string[]> {
    const observation = new StackReadObservation();
    // Recovery keys on the journal because an interrupted adoption may not
    // have written its catalog yet. The locked recovery still verifies it.
    const candidates = await observation.hints.markerCandidates(directories, STACK_OPERATION_JOURNAL);
    const clones = await observation.checkoutsByClone(candidates);
    const results = await Promise.allSettled(clones.map((clone) => this.recoverClone(clone, registry)));
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
      if (args.action === "set_lead") {
        return await registry.withStackWorktreeMutation(clone.commonDir, () => store.withOperationLock(clone.commonDir, async () => {
          const { catalog } = await store.read(clone.commonDir);
          requireWritableCatalog(catalog);
          const stack = catalog.stacks.find((candidate) => candidate.branches.some(({ branch }) => branch === args.stack));
          const root = stack && stackRoot(stack);
          if (!stack || !root) throw new StackOperationError("ambiguous_layer", "Select a tracked stack by a member branch.");
          const moves = (await Promise.all(stack.branches.map(async ({ branch }) => {
            const tip = await git.tip(branch);
            return tip ? { branch, old: tip, next: tip } : undefined;
          }))).flatMap((item) => item ? [item] : []);
          const owners = await this.participants(git, moves, catalog, registry);
          const target = owners.filter((owner) => owner.threadId === args.threadId && !owner.locked);
          const key = stackLeadKey(clone.commonDir, root);
          const storage = getDesktopOverlayStore();
          const lead = (await storage.listThreadMetadata()).find((thread) => thread.stackLead?.includes(key) && !thread.archived);
          if (lead && (lead.threadId !== actor.threadId || lead.backend !== actor.backend)) {
            throw new StackOperationError("forbidden", "Only the current stack lead can transfer the lead.");
          }
          if (target.length !== 1) throw new StackOperationError("ambiguous_layer", "Select one local, unlocked layer thread.");
          const { threadId, backend } = target[0]!;
          storage.setStackLead(key, { threadId, backend });
          return { stack: root, lead: { threadId, backend } };
        }));
      }
      if (args.action === "undo") return await session.undo(actor, args.opId!);
      if (args.action === "release_thread") return session.releaseThread(actor, args.opId!, args.threadId!);
      if (args.action === "interrupt") return await session.interrupt(actor, args.opId!);
      if (args.action === "route_conflict") return await session.routeConflict(actor, args.opId!);
      const opId = args.opId!;
      try {
        if (args.action === "abort") return await session.abort(actor, opId);
        return args.action === "continue" ? await session.continue(actor, opId) : session.status(actor, opId);
      } catch (error) {
        if (!(error instanceof StackOperationError) || error.code !== "not_found") throw error;
        if (!registry.hasStackNotice(actor, opId) && args.action === "continue") {
          await this.recoverClone(clone, registry, actor, opId);
        }
        if (registry.hasStackNotice(actor, opId)) return { opId, status: "done" };
        throw error;
      }
    }
    if (tool === "apply_stack_operation" && args.planId) return session.apply(actor, args.planId);
    const operation = await this.resolveOperation(args, scope, clone.commonDir, store, git);
    const forecast = await session.plan(actor, operation, { newThread: args.newThread, carryChanges: args.carryChanges, askToSettle: args.askToSettle });
    return tool === "apply_stack_operation" ? session.apply(actor, forecast.planId) : forecast;
  }

  async publish(request: StackPublishRequest, registry: DesktopBackendRegistry): Promise<{ head: string; pushed: boolean }> {
    const { actor, automated, directories, github, number, repository, signal } = request;
    const repoKey = `${repository.host}:${repository.owner}/${repository.repo}`.toLowerCase();
    const initial = await request.readGate();
    const candidates = (await readStackClones(directories, {
      signal,
      priority: () => automated ? PR_METADATA_PRIORITY.background : PR_METADATA_PRIORITY.selected,
    })).filter(({ catalog }) => catalog.status === "ok"
      && catalog.catalog.repository.toLowerCase() === repoKey
      && catalog.catalog.stacks.some(({ branches }) => branches.some((layer) => layer.branch === initial.layer.branch)));
    if (candidates.length !== 1) throw new Error("Publishing requires one tracked checkout for this layer");
    const clone = candidates[0]!;
    const { commonDir } = clone;
    const store = new GhStackCatalogStore();
    const git = new StackGit(stackGitRunner, clone.cwd);
    const engine = new StackEngine(stackGitRunner, store, clone.cwd, commonDir);
    const opId = randomUUID();

    return await registry.withStackWorktreeMutation(commonDir, async () => {
      signal?.throwIfAborted();
      const current = await request.readGate();
      const { layer } = current;
      if (layer.branch !== initial.layer.branch || current.stack.key !== initial.stack.key) throw new Error("Stack moved before publishing");
      const { catalog } = await store.read(commonDir);
      requireWritableCatalog(catalog);
      const stack = catalog.stacks.find(({ branches }) => branches.some(({ branch }) => branch === layer.branch));
      if (!stack) throw new Error("Stack moved before publishing");
      const index = stack.branches.findIndex(({ branch }) => branch === layer.branch);
      const branch = stack.branches[index]!;
      const tip = await git.tip(branch.branch);
      if (!tip) throw new Error("The layer's local branch is missing");
      const owners = await this.participants(git, [{ branch: branch.branch, old: tip, next: tip }], catalog, registry);
      if (owners.length !== 1 || owners[0]!.backend !== actor.backend || owners[0]!.threadId !== actor.threadId
        || owners[0]!.locked || (automated && owners[0]!.active)) {
        throw new StackOperationError("ambiguous_layer", "Publishing needs the local layer owner's available worktree.");
      }

      const release = registry.holdStackThread(actor, opId);
      try {
        const remote = await stackPublishRemote(git, repository);
        const observedParent = current.stack.layers[index - 1]?.pullRequest?.number;
        const target = await readStackPublishTarget(repository, stack, index, number, github, signal, observedParent, request.expectedHead);
        const { remoteHead, merged } = target;
        if (layer.health === "parent_merged" && !merged) throw new Error("The parent merge could not be verified");
        const parent = stack.branches[index - 1];
        if (!merged && parent && target.parentHead !== await git.tip(parent.branch)) {
          throw new Error("The parent PR no longer matches its local branch");
        }

        // A retry after local commit uses the exact journalled rewrite. A
        // remote update that was never contained in the pre-replay tip fails
        // here even if the live PR currently names it.
        const proofRef = stackPublishProofRef(repoKey, branch.branch);
        const proof = await readPublishProof(git, proofRef, branch.branch, tip);
        let verifiedBoundary: string | undefined;
        for (const boundary of [tip, ...(proof?.boundaries ?? [])]) {
          if (await git.ancestor(remoteHead, boundary)) { verifiedBoundary = boundary; break; }
        }
        if (!verifiedBoundary) throw new Error("Remote head contains work outside the local replay");
        const previous = verifiedBoundary;

        let operation: StackOperation | undefined;
        const root = stackRoot(stack)!;
        if (merged && (!parent?.pullRequest?.merged || branch.base !== stack.trunk.head)) {
          operation = { kind: "sync", root, branch: branch.branch, onto: await readStackTrunk(git, remote, stack.trunk.branch, true), merged };
        } else if (!merged && layer.health === "needs_restack") {
          operation = { kind: "restack", root, from: branch.branch, stopBefore: stack.branches[index + 1]?.branch };
        }

        // Finish stale replays before sending any check-triggering update.
        let head = tip;
        if (operation) {
          const plan = await engine.plan(operation);
          const conflict = plan.steps.find((step) => step.conflict);
          if (conflict) throw new StackOperationError("forecast_conflict", `Replay of ${conflict.branch} conflicts in ${conflict.conflict!.files.join(", ")}.`);
          if (plan.blocked.length) throw new StackOperationError("dirty_overlap", "Local changes overlap the replay.");
          await request.readGate();
          const notification: StackNotification = { opId, actor, kind: operation.kind, operation,
            participants: owners, steps: plan.steps, moves: plan.moves };
          const carried = { branch: branch.branch, tip: previous };
          const receipt = await this.runJournalled(clone, registry, store, engine, git, {
            beforeTransaction: async () => { await request.readGate(); signal?.throwIfAborted(); },
            prepareReceipt: (receipt) => prepareStackPublishReceipt(git, receipt, carried),
          }, notification, (journal) => engine.apply(plan, opId, Date.now(), journal));
          await this.completeUnderWorktreeLock(clone, registry, store, git, notification);
          head = receipt.moves.find((move) => move.branch === branch.branch)?.next ?? tip;
        }

        await store.withOperationLock(commonDir, async () => {
          const freshRemote = await stackPublishRemote(git, repository);
          if (freshRemote !== remote) throw new Error("The stack's remote changed");
          await request.readGate();
          signal?.throwIfAborted();
          const move = { branch: branch.branch, expected: remoteHead, previous, next: head };
          await completeStackPublication(() => target.retarget(), async () => {
            await request.readGate();
            signal?.throwIfAborted();
            await pushStackLayers(git, remote, [move]);
          });
        });
        return { head, pushed: head !== remoteHead };
      } finally {
        release();
      }
    });
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
    if (args.operation === "sync" && branch && scope.sync) {
      const stack = matched[0]!;
      const index = stack.branches.findIndex((entry) => entry.branch === branch);
      const number = stack.branches[index]?.pullRequest?.number;
      if (index < 1 || !number) throw new StackOperationError("ambiguous_layer", "Select the tracked child pull request.");
      const { repository, github, signal } = scope.sync;
      const remote = await stackPublishRemote(git, repository);
      const target = await readStackPublishTarget(repository, stack, index, number, github, signal);
      if (!target.merged) throw new StackOperationError("invalid_arguments", "The child's parent PR has not merged.");
      const onto = await readStackTrunk(git, remote, stack.trunk.branch);
      return { kind: "sync", root, branch, onto, merged: target.merged };
    }
    if (args.operation === "restack") return { kind: "restack", root, from: args.from, stopBefore: args.stopBefore };
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
      validateApply: (plan) => this.validateLayerApply(clone.cwd, plan),
      participants: async (moves, catalog) => await this.participants(git, moves, catalog, registry),
      hold: (thread, opId) => registry.holdStackThread(thread, opId),
      subscribe: (listener) => registry.onEvent(listener),
      exclusive: (fn) => registry.withStackWorktreeMutation(clone.commonDir, fn),
      requestWork: (actor, owner, prompt, key, signal) => registry.requestStackLayerWork(actor, owner, prompt, key, signal),
      interrupt: (thread, opId) => registry.interruptStackLayer(thread, opId),
      complete: (_receipt, notification) => this.complete(clone, registry, store, git, notification),
      abandon: (actor, opId) => this.abandonProvisioning(clone, registry, store, git, actor, opId),
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

  private complete(clone: { cwd: string; commonDir: string }, registry: DesktopBackendRegistry, store: GhStackCatalogStore,
    git: StackGit, notification: StackNotification): Promise<StackThreadRef | undefined> {
    const abandoning = this.abandoning.get(clone.commonDir);
    if (abandoning) return abandoning.then(() => this.complete(clone, registry, store, git, notification));
    const active = this.finishing.get(clone.commonDir);
    if (active) return active;
    const work = registry.withStackWorktreeMutation(clone.commonDir, () =>
      this.completeUnderWorktreeLock(clone, registry, store, git, notification))
      .finally(() => { this.finishing.delete(clone.commonDir); });
    this.finishing.set(clone.commonDir, work);
    return work;
  }

  // A publish keeps the worktree lock through its remote lease. The normal
  // coordinator acquires that lock for the completion phase separately.
  private async completeUnderWorktreeLock(clone: { cwd: string; commonDir: string }, registry: DesktopBackendRegistry,
    store: GhStackCatalogStore, git: StackGit, notification: StackNotification): Promise<StackThreadRef | undefined> {
    let child: StackThreadRef | undefined;
    let found = false;
    await store.recover(clone.commonDir, async (entry) => {
      if (!entry.committed || entry.notification.opId !== notification.opId) {
        throw new StackOperationError("gh_stack_busy", "Another stack operation owns this journal.");
      }
      found = true;
      const saved = entry.notification;
      if (!registry.hasStackNotice(saved.actor, saved.opId)) {
        if (!saved.provisioningAbandoned) child = await this.provision(clone, registry, store, git, entry);
        await registry.publishStackCompletion(saved.actor, saved.opId, saved.kind, child, saved.provisioningAbandoned);
      }
      if (!saved.provisioningAbandoned || entry.provisioning?.stage === "pending") await this.releaseCarry(git, saved);
    });
    if (!found && !registry.hasStackNotice(notification.actor, notification.opId)) {
      throw new StackOperationError("not_found", "The stack completion journal is unavailable.");
    }
    return child;
  }

  private async abandonProvisioning(clone: { commonDir: string }, registry: DesktopBackendRegistry,
    store: GhStackCatalogStore, git: StackGit, actor: StackThreadRef, opId: string): Promise<boolean> {
    if (this.finishing.has(clone.commonDir) || this.abandoning.has(clone.commonDir)) {
      throw new StackOperationError("gh_stack_busy", "Stack completion is already running.");
    }
    let abandoned = false;
    const work = registry.withStackWorktreeMutation(clone.commonDir, () => store.recover(clone.commonDir, async (entry) => {
      const { notification, receipt } = entry;
      if (!entry.committed || notification.kind !== "add_branch" || !notification.options?.newThread
        || notification.opId !== opId || notification.actor.backend !== actor.backend || notification.actor.threadId !== actor.threadId) return "retain";
      if (!registry.hasStackNotice(actor, opId)) {
        notification.provisioningAbandoned = true;
        await store.markJournalCommitted(clone.commonDir, entry, notification);
        await this.notify(clone.commonDir, registry, git, receipt, notification);
        await registry.publishStackCompletion(actor, opId, notification.kind, undefined, true);
      }
      // The snapshot may be the only complete copy after a partial carry.
      // Leaving provisioning does not authorize removal of its checkout.
      if (entry.provisioning?.stage === "pending") await this.releaseCarry(git, notification);
      abandoned = true;
    })).then(() => abandoned).finally(() => { this.abandoning.delete(clone.commonDir); });
    this.abandoning.set(clone.commonDir, work);
    return await work;
  }

  private async releaseCarry(git: StackGit, notification: StackNotification): Promise<void> {
    if (!notification.carry?.ref) return;
    const ref = `refs/pwragent/stack-carry/${notification.opId}`;
    const observed = await git.run(["show-ref", "--exists", ref]);
    if (observed.exitCode === 2) return;
    await git.output(["update-ref", "-d", ref, notification.carry.ref]);
  }

  private async provision(clone: { cwd: string; commonDir: string }, registry: DesktopBackendRegistry, store: GhStackCatalogStore,
    git: StackGit, entry: RuntimeJournal): Promise<StackThreadRef | undefined> {
    const { receipt, notification } = entry;
    const operation = notification.operation;
    if (!operation || (operation.kind !== "adopt" && operation.kind !== "add_branch")) return undefined;
    const root = operation.kind === "adopt" ? stackRoot(operation.stack) : operation.root;
    if (!root) return undefined;
    const key = stackLeadKey(clone.commonDir, root);
    const storage = getDesktopOverlayStore();
    const metadata = await storage.listThreadMetadata();
    const recorded = metadata.find((thread) => thread.stackLead?.includes(key));
    const bottomTip = await git.tip(root);
    const bottom = recorded?.archived && bottomTip ? (await this.participants(git,
      [{ branch: root, old: bottomTip, next: bottomTip }], receipt.after, registry))[0] : undefined;
    const lead = recorded && !recorded.archived ? recorded : bottom ?? notification.actor;
    if (!recorded || recorded.archived) {
      storage.setStackLead(key, lead);
    }
    if (operation.kind !== "add_branch" || !notification.options?.newThread) return undefined;
    const move = receipt.moves.find(({ branch }) => branch === operation.branch);
    const tip = move?.next;
    if (!move || !tip || await git.tip(move.branch) !== tip) {
      throw new StackOperationError("stale_plan", "The new branch changed before its worktree could be provisioned.");
    }
    const checkpoint = (provisioning: StackProvisioning) => store.writeProvisioning(clone.commonDir, entry, provisioning);
    let state = entry.provisioning;
    if (state?.stage === "checkout_failed") {
      throw new StackOperationError("stack_checkout_failed",
        `The checkout setup failed at ${state.worktree.path}. Its files were kept. Inspect the checkout and abandon provisioning before starting a thread manually.`);
    }
    if (state?.stage !== "pending" && state?.stage !== "reserved" && state?.stage !== "accepted") {
      throw await this.provisioningUncertain(registry, entry, state?.stage === "admitting" ? state.worktree.path : undefined);
    }
    const backend = notification.actor.backend;
    const parent = state.stage === "pending" ? { backend: lead.backend, threadId: lead.threadId } : state.lead;
    const assertOwner = async (child?: StackThreadRef) => {
      const [owner] = await this.participants(git, [{ ...move, old: tip }], receipt.after, registry, true);
      if (owner && (owner.backend !== child?.backend || owner.threadId !== child.threadId)) {
        throw new StackOperationError("ambiguous_layer", "The new layer is already checked out by another thread.");
      }
      return owner;
    };
    if (state.stage !== "pending" && (path.relative(clone.commonDir, state.worktree.commonDir) !== ""
      || state.worktree.branch !== move.branch || state.worktree.tip !== move.next)) {
      throw new StackOperationError("stale_plan", "The reserved worktree no longer matches the stack operation.");
    }
    const inspectAccepted = async (accepted: Extract<StackProvisioning, { stage: "accepted" }>) => {
      const { child, worktree, codex } = accepted;
      if (child.backend !== backend || !child.threadId) return "unverified";
      await registry.prepareStackWorktree(clone.cwd, worktree, { create: false, ownerThreadId: backend === "codex" ? child.threadId : undefined });
      if (await assertOwner(child)) return "present";
      if (backend !== "codex") return "unverified";
      // A live owner may still have the child in an older App Server
      // generation. Absence can authorize replacement only after owner restart.
      const home = codex && codex.ownerEpoch !== this.epoch ? codex.home : undefined;
      const observed = await registry.inspectCodexStackThread(child, worktree.path, home);
      return observed === "missing" && !home ? "unverified" : observed;
    };
    let acceptedPresent = false;
    if (state.stage === "accepted") {
      const observed = await inspectAccepted(state);
      if (observed === "missing" && !(await storage.getThreadMetadata(state.child))?.parent) {
        // A previously registered child (including a marker installed before
        // the parent write) cannot be replaced by this operation.
        await registry.prepareStackWorktree(clone.cwd, state.worktree, { create: false });
        const reserved = { stage: "reserved" as const, worktree: state.worktree, lead: parent };
        await checkpoint(reserved);
        state = reserved;
      } else if (observed === "present") {
        acceptedPresent = true;
      } else {
        throw await this.provisioningUncertain(registry, entry, state.worktree.path);
      }
    }
    if (state.stage !== "accepted") {
      let reservation = state.stage === "reserved" ? state.worktree : undefined;
      try {
        await registry.startThread({
          backend, cwd: clone.cwd, workMode: "worktree", requiredWorkMode: "worktree",
          branchName: move.branch, worktreeBranchMode: "attached", parentThreadId: parent.threadId, parentThreadBackend: parent.backend,
          pendingStart: { startId: notification.opId, title: move.branch },
          stackWorktree: {
            prepare: async () => {
              if (!reservation) {
                reservation = await registry.reserveStackWorktree({ ...clone, backend, branch: move.branch, tip });
                await checkpoint({ stage: "reserved", worktree: reservation, lead: parent });
              }
              const worktree = reservation;
              const workspace = await registry.prepareStackWorktree(clone.cwd, worktree, {
                create: true,
                onAddFailed: () => checkpoint({ stage: "checkout_failed", worktree, lead: parent }),
              });
              await assertOwner();
              if (notification.carry) await applyStackLayerEdits(workspace.cwd, notification.carry, tip);
              return workspace;
            },
            admit: async (submit) => {
              if (!reservation) throw new Error("The stack worktree was not prepared.");
              await registry.prepareStackWorktree(clone.cwd, reservation, { create: false });
              await assertOwner();
              await checkpoint({ stage: "admitting", worktree: reservation, lead: parent });
              const worktree = reservation;
              const result = await submit().catch(async (error: unknown) => {
                if (error instanceof ThreadStartNotAdmittedError) await checkpoint({ stage: "reserved", worktree, lead: parent });
                throw error;
              });
              await checkpoint({
                stage: "accepted", worktree, lead: parent, child: { backend, threadId: result.threadId },
                ...(backend === "codex" && result.codexHome ? { codex: { home: result.codexHome, ownerEpoch: this.epoch } } : {}),
              });
              return result;
            },
          },
        });
      } catch (error) {
        if (entry.provisioning?.stage === "admitting") {
          throw await this.provisioningUncertain(registry, entry, entry.provisioning.worktree.path);
        }
        throw error;
      }
      state = entry.provisioning;
    }
    if (state?.stage !== "accepted" || state.child.backend !== backend || !state.child.threadId) {
      throw await this.provisioningUncertain(registry, entry);
    }
    const { child, worktree } = state;
    if (!acceptedPresent && await inspectAccepted(state) !== "present") throw await this.provisioningUncertain(registry, entry, worktree.path);
    await registry.registerStackLayerThread(child, parent, worktree.path);
    const existing = await storage.getThreadMetadata(child);
    const leadOverlay = await storage.getThreadOverlayState(parent);
    if (leadOverlay?.subthreadOrder?.[0] !== child.threadId) {
      await updateLocalSubthreadOrder({ backend: parent.backend, parentThreadId: parent.threadId,
        threadIds: [child.threadId, ...(leadOverlay?.subthreadOrder ?? []).filter((id) => id !== child.threadId)] });
    }
    if (existing?.title?.text !== move.branch) await registry.renameThread({ ...child, name: move.branch });
    return child;
  }

  private async provisioningUncertain(registry: DesktopBackendRegistry, { notification, provisioning }: RuntimeJournal, checkout?: string) {
    const { actor, opId, carry } = notification;
    const message = [
      `PwrAgent could not confirm the provider start for stack operation ${opId}.`,
      ...(provisioning?.stage === "accepted" ? [`The provider reported thread ${provisioning.child.threadId}.`] : []),
      checkout ? `Inspect the checkout at ${checkout} and the provider's thread list.` : "Inspect the branch checkout and the provider's thread list.",
      "To abandon provisioning and keep the Git changes, ask this thread to run manage_stack_operation with action \"abort\" and the operation ID.",
      ...(carry ? [`The saved edits are at refs/pwragent/stack-carry/${opId}.`] : []),
    ].join(" ");
    await registry.publishStackNotice(actor, {
      opId, kind: "add_branch", branch: ":provisioning", stack: "", by: { threadId: actor.threadId, actor: "agent" },
      from: null, to: null, changedFiles: [], undo: `refs/pwragent/undo/${opId}`,
      completion: { provisioningIssue: message },
    });
    return new StackOperationError("stack_provisioning_uncertain", message);
  }

  private async prepareCarry(registry: DesktopBackendRegistry, git: StackGit, notification: StackNotification): Promise<void> {
    if (!notification.options?.carryChanges || notification.operation?.kind !== "add_branch") return;
    const branch = notification.operation.branch;
    const move = notification.moves?.find((candidate) => candidate.branch === branch);
    const source = await registry.resolveThreadWorkspaceCwd(notification.actor.backend, notification.actor.threadId);
    if (!source || !move?.next) {
      throw new StackOperationError("invalid_arguments", "Carry changes requires a local source worktree and a new layer.");
    }
    const worktrees = (await git.output(["worktree", "list", "--porcelain", "-z"])).split("\0")
      .filter((line) => line.startsWith("worktree ")).map((line) => ({ path: line.slice("worktree ".length) }));
    const sourceRoot = pathKey(await realpath(source));
    const worktreeRoots = await Promise.all(worktrees.map(({ path }) => realpath(path).then(pathKey, () => undefined)));
    if (!worktreeRoots.includes(sourceRoot)) {
      throw new StackOperationError("invalid_arguments", "Carry changes requires a source in the same clone.");
    }
    notification.carry = await captureStackLayerEdits(source, move.next, worktrees);
  }

  private async notify(commonDir: string, registry: DesktopBackendRegistry, git: StackGit, receipt: StackReceipt, { opId, kind, actor, participants, steps, interrupted }: StackNotification) {
    if (kind === "remove" || kind === "undo") {
      const [before, after] = kind === "undo" ? [receipt.after, receipt.before] : [receipt.before, receipt.after];
      const rootsByBranch = new Map(after.stacks.flatMap((stack) =>
        stack.branches.map(({ branch }) => [branch, stackRoot(stack)!] as const)));
      for (const stack of before.stacks) {
        const root = stackRoot(stack);
        const surviving = stack.branches.find(({ branch }) => rootsByBranch.has(branch));
        const nextRoot = surviving && rootsByBranch.get(surviving.branch);
        if (root && nextRoot && root !== nextRoot) {
          getDesktopOverlayStore().moveStackLead(stackLeadKey(commonDir, root), stackLeadKey(commonDir, nextRoot));
        }
      }
    }
    for (const participant of participants) {
      const moved = receipt.moves.find((entry) => entry.branch === participant.branch);
      if (!moved || moved.old === moved.next || registry.hasStackNotice(participant, opId, participant.branch)) continue;
      const move = kind === "undo" ? { branch: moved.branch, old: moved.next, next: moved.old } : moved;
      const catalog = kind === "undo" ? receipt.before : receipt.after;
      const stack = catalog.stacks.find((entry) => entry.branches.some((branch) => branch.branch === move.branch));
      const index = stack?.branches.findIndex((branch) => branch.branch === move.branch) ?? -1;
      const files = move.old && move.next
        ? (await git.output(["diff", "--name-only", "-z", move.old, move.next])).split("\0").filter(Boolean).slice(0, 100)
        : [];
      const step = steps?.find(({ branch }) => branch === move.branch);
      const stats = step && step.oldBase !== step.newBase
        ? (await git.output(["diff", "--numstat", "-z", "--no-renames", step.oldBase, step.newBase])).split("\0").filter(Boolean)
        : [];
      const lower = { branch: step?.parent ?? "", added: 0, removed: 0, files: [] as string[] };
      for (const row of stats) {
        const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(row);
        if (!match) continue;
        lower.added += Number(match[1]) || 0;
        lower.removed += Number(match[2]) || 0;
        if (lower.files.length < 100) lower.files.push(match[3]!);
      }
      const cwd = participant.path;
      const status = cwd ? await git.output(["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], undefined, cwd)
        .catch(() => undefined) : "";
      const readPaths = new Set(cwd ? registry.readStackPaths(participant)
        .map((file) => pathKey(path.relative(cwd, path.resolve(cwd, file)))) : []);
      const staleReads = (lower.files.length ? lower.files : files).filter((file) => readPaths.has(pathKey(file)));
      await registry.publishStackNotice(participant, {
        opId, kind, by: { threadId: actor.threadId, actor: "agent" }, stack: (stack && stackRoot(stack)) ?? move.branch,
        branch: move.branch, from: move.old, to: move.next, changedFiles: files,
        ...(step?.proof ? { proof: { patchIdsMatch: true, dropped: step.proof.dropped.map(({ commit }) => commit) } } : {}),
        ...(stats.length ? { below: [lower] } : {}),
        staleReads,
        worktree: { followed: cwd ? "reset --keep" : "not checked out",
          keptDirty: status?.split("\0").filter(Boolean).slice(0, 100).map((entry) => entry.slice(3)) },
        ...(interrupted?.some((thread) => thread.backend === participant.backend && thread.threadId === participant.threadId)
          ? { interruptedBy: "operator" } : {}),
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
    await this.prepareCarry(registry, git, notification);
    const journal = store.journalHooks(clone.commonDir, notification);
    let currentEntry: StackJournal | undefined;
    const applyHooks: ApplyHooks = {
      ...journal, ...hooks,
      ...((notification.kind === "restack" || notification.kind === "sync") && {
        prepareReceipt: hooks.prepareReceipt ?? ((receipt) => prepareStackPublishReceipt(git, receipt)),
      }),
      finish: async (outcome, receipt) => {
        if (outcome === "committed") {
          if (currentEntry) await store.markJournalCommitted(clone.commonDir, currentEntry, notification);
          await this.notify(clone.commonDir, registry, git, receipt, notification);
        }
        if (outcome !== "committed" || notification.kind === "undo") {
          if (outcome === "aborted") await this.releaseCarry(git, notification);
          if (outcome === "committed") await registry.publishStackCompletion(notification.actor, notification.opId, notification.kind);
          await journal.finish?.(outcome, receipt);
        }
      },
    };
    let operationStarted = false;
    try {
      return await operate({ ...applyHooks, begin: async (entry) => {
        await applyHooks.begin?.(entry);
        currentEntry = entry;
        operationStarted = true;
        if (notification.carry?.ref) {
          await git.output(["update-ref", `refs/pwragent/stack-carry/${notification.opId}`, notification.carry.ref, ""]);
        }
      } });
    } catch (error) {
      if (operationStarted && await store.hasJournal(clone.commonDir)) {
        let recovered: StackReceipt | undefined;
        await store.recover(clone.commonDir, async (entry) => {
          if (entry.notification.opId !== notification.opId) throw error;
          const finish = async (outcome: "committed" | "aborted", receipt: StackReceipt) => {
            if (outcome === "aborted") return await this.releaseCarry(git, notification);
            if (!entry.committed) await store.markJournalCommitted(clone.commonDir, entry, notification);
            await this.notify(clone.commonDir, registry, git, receipt, notification);
            if (notification.kind === "undo") await registry.publishStackCompletion(notification.actor, notification.opId, notification.kind);
            recovered = receipt;
          };
          if (entry.committed) await finish("committed", entry.receipt);
          else await engine.recover(entry, { finish });
          return recovered && notification.kind !== "undo" ? "retain" : undefined;
        });
        if (recovered) return recovered;
      }
      throw error;
    }
  }

  private async recoverClone(clone: { cwd: string; commonDir: string }, registry: DesktopBackendRegistry, actor?: StackThreadRef, opId?: string): Promise<void> {
    const store = new GhStackCatalogStore();
    if (!await store.hasJournal(clone.commonDir)) return;
    const git = new StackGit(stackGitRunner, clone.cwd);
    const engine = new StackEngine(stackGitRunner, store, clone.cwd, clone.commonDir);
    let pending: StackNotification | undefined;
    await registry.withStackWorktreeMutation(clone.commonDir, () => store.recover(clone.commonDir, async (entry) => {
      const release: Array<() => void> = [];
      try {
        const { receipt, direction, notification } = entry;
        if (opId && (notification.opId !== opId || notification.actor.backend !== actor?.backend
          || notification.actor.threadId !== actor.threadId)) return "retain";
        if (entry.committed) {
          await this.notify(clone.commonDir, registry, git, receipt, notification);
          if (notification.kind === "undo") {
            await registry.publishStackCompletion(notification.actor, notification.opId, notification.kind);
            return;
          }
          pending = notification;
          return "retain";
        }
        const moves = direction === "apply" ? receipt.moves : receipt.moves.map(({ branch, old, next }) => ({ branch, old: next, next: old }));
        const participants = await this.participants(git, moves, direction === "apply" ? receipt.before : receipt.after, registry);
        for (const thread of participants) {
          if (thread.remote || thread.locked || (thread.active && (thread.backend !== actor?.backend || thread.threadId !== actor.threadId))) {
            throw new StackOperationError("gh_stack_busy", `Finish the active work on ${thread.branch} before recovering the interrupted stack operation.`);
          }
          release.push(registry.holdStackThread(thread, notification.opId));
        }
        await engine.recover(entry, { finish: async (outcome) => {
          if (outcome === "aborted") await this.releaseCarry(git, notification);
          else {
            await store.markJournalCommitted(clone.commonDir, entry, notification);
            await this.notify(clone.commonDir, registry, git, receipt, notification);
            if (notification.kind === "undo") await registry.publishStackCompletion(notification.actor, notification.opId, notification.kind);
            else pending = notification;
          }
        } });
        return pending ? "retain" : undefined;
      } finally {
        for (const unlock of release.reverse()) unlock();
      }
    }));
    if (pending) await this.complete(clone, registry, store, git, pending);
  }

  private async participants(git: StackGit, moves: readonly RefMove[], catalog: GhStackCatalog, registry: DesktopBackendRegistry,
    forceRefresh = false): Promise<StackParticipant[]> {
    if (!moves.length) return [];
    const worktrees = await git.worktrees([...moves]);
    const threads = await registry.listThreads({ callerReason: "stack-operation", forceRefresh });
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
      owners.push({ ...thread, title, locked, branch, path: worktrees.find((entry) => entry.branch === branch)?.path,
        active: registry.stackThreadActive(thread), remote: false });
    }
    return owners;
  }
}
