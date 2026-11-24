import { executeResourceCheckout, recoverResourceCheckout } from "@pwragent/owner-core/resource-checkout-executor";
import { createPwrSuiteLabCheckoutAdapter, type ApprovedLabCheckout } from "./pwrsuitelab-checkout-adapter";
import { isEnvironmentGroupGone } from "./checkout-machine-evidence";
import { createHash, randomUUID } from "node:crypto";
import {
  CheckoutDefinitionConflictError, ResourceCheckoutAuthority, MAX_CHECKOUT_HOLD_MS, rejectCheckout, type CheckoutStatus, type CheckoutToken,
} from "@pwragent/owner-core/resource-checkout-authority";
import type {
  CheckoutActor, CheckoutDefinition, CheckoutDomainRecord, CheckoutStore,
} from "@pwragent/owner-core/resource-checkout-storage";
import {
  RESOURCE_CHECKOUTS_CONTRACT_VERSION, type ResourceAuthority, type ResourceCheckoutActionResult,
  type ResourceCheckoutsSnapshot, type ResourceViewer, type ResourceDomain, type ResourceAdvertisement, type ResourceCheckoutActionRequest,
  type ResourceHolder, type ResourceOwnershipConflict, type ResourceThreadRef,
} from "@pwragent/shared/contracts/resource-checkouts";
import { isAppServerBackendKind } from "@pwragent/shared/contracts/navigation";
import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import { parseCheckoutAction, parseCheckoutToken, object, text } from "./checkout-input";
import type { ExternalBinding } from "./checkout-configuration";
import { labelResourceThreads, projectCheckoutDomain, UNEXPLAINED_OWNERSHIP_CONFLICT } from "./checkout-projection";
import { misboundAuthorityConflict, OWNERSHIP_CONFLICTS } from "./checkout-ownership";

export const CHECKOUT_FEDERATION_METHOD = "resourceCheckouts.authority.v1";
const REFRESH_MS = 2_000;

type Store = CheckoutStore & { close(): void };

type Options = {
  viewer: ResourceViewer;
  machineStore?: Store;
  /** Why no machine store was passed, for the operator. */
  machineUnresolved?: ResourceOwnershipConflict;
  /**
   * Opens the machine store under this machine's identity. `adopted` is true
   * only when this call took the store over from another identity; another
   * profile on the root may already have done that.
   */
  adoptMachineStore?: () => { store: Store; adopted: boolean };
  machineCpuCount?: number;
  externalStore?: Store;
  /** Why no Federation store was passed, for the operator. */
  externalUnresolved?: ResourceOwnershipConflict;
  bindings: ExternalBinding[];
  allowAgentDrafts?: boolean;
  approvedLabCheckouts?: ReadonlyMap<string, ApprovedLabCheckout>;
  bootId?: string;
  readMachineAdvertisements?: () => ResourceAdvertisement[];
  requestPeer: <T>(instanceId: string, request: unknown) => Promise<T>;
  /**
   * A thread's current title, when this instance can name it: its own
   * threads, and peers' threads it has seen. Holders are stored with the
   * title they had when they asked, so a rename shows on the next read.
   */
  threadTitle?: (thread: ResourceThreadRef) => string | undefined;
  warn: (error: unknown) => void;
  now?: () => number;
};

type CheckoutDelegation = Extract<ResourceCheckoutActionRequest, { kind: "delegate_execution" }>;
type OwnershipAction = Extract<ResourceCheckoutActionRequest, { kind: "resolve_ownership" }>;
type ExternalView = { authority: ResourceAuthority; resource: ResourceDomain };

export class DesktopResourceCheckoutService {
  private readonly now: () => number;
  private machine?: ResourceCheckoutAuthority;
  private machineStore?: Store;
  private readonly machineDefinition: CheckoutDefinition;
  private readonly external?: ResourceCheckoutAuthority;
  private readonly hosted = new Set<string>();
  /** Hosted definitions whose saved record conflicts with the configuration. */
  private readonly changedDefinitions = new Set<string>();
  private readonly operator: CheckoutActor;
  private readonly listeners = new Set<(revision: number) => void>();
  private readonly remoteViews = new Map<string, ExternalView>();
  private readonly threadsWithCheckouts = new Set<string>();
  private readonly timer: NodeJS.Timeout;
  private readonly shutdown = new AbortController();
  private readonly providerWorkInFlight = new Map<string, string>();
  private readonly providerJobs = new Map<Promise<unknown>, () => void>();
  private readonly admittedJobs = new Map<string, {
    check(): void;
    stop(): void;
    markRecovery(): void;
    settled: Promise<void>;
  }>();
  private revision = 0;
  private fingerprint = "";
  private refreshPending?: Promise<void>;
  private closed = false;
  private closing?: Promise<void>;
  private machineConflict = false;
  /** The adopted machine store came from another identity in this process. */
  private machineAdopted = false;
  private machineConflictExplanation: ResourceOwnershipConflict = UNEXPLAINED_OWNERSHIP_CONFLICT;
  private lastAdvertisementScan = -Infinity;
  private localAdvertisements: ResourceAdvertisement[] = [];

  constructor(private readonly options: Options) {
    const { viewer, machineStore, externalStore, bindings } = options;
    const initialWallClock = Date.now();
    const initialMonotonicClock = performance.now();
    this.now = options.now ?? (() => Math.floor(Math.max(Date.now(), initialWallClock + performance.now() - initialMonotonicClock)));
    this.operator = this.operatorFor(viewer.instanceId);
    const machineKey = `machine:${viewer.machineId ?? "unresolved"}:cpu`;
    this.machineDefinition = {
      resourceId: machineKey, canonicalKey: machineKey, displayName: "This machine", kindLabel: "Machine compute",
      scope: "machine", capacity: Math.max(1, options.machineCpuCount ?? 1), counted: true, authorityId: machineKey, epoch: 1,
      maxHoldMs: MAX_CHECKOUT_HOLD_MS, publication: "published", revision: 2, updatedAt: this.now(),
    };
    this.machineStore = machineStore;
    if (machineStore) {
      try {
        this.machine = new ResourceCheckoutAuthority(machineStore, this.now, randomUUID);
        this.machine.ensure(this.machineDefinition, { machineCpuPool: true });
        if (options.bootId) this.machine.reconcilePriorMachineBoot(machineKey, options.bootId);
      } catch (error) {
        this.machineConflict = true;
        this.machineConflictExplanation = error instanceof CheckoutDefinitionConflictError
          ? OWNERSHIP_CONFLICTS.machineDefinitionChanged
          : OWNERSHIP_CONFLICTS.machineStoreUnavailable;
        options.warn(error);
      }
    } else {
      this.machineConflict = true;
      this.machineConflictExplanation = options.machineUnresolved ?? OWNERSHIP_CONFLICTS.machineStoreUnavailable;
    }
    if (externalStore) {
      this.external = new ResourceCheckoutAuthority(externalStore, this.now, randomUUID);
      for (const binding of bindings) {
        if (!this.isLocalAuthority(binding)) continue;
        try {
          this.external.ensure(binding.definition);
          this.hosted.add(binding.definition.resourceId);
        } catch (error) {
          if (error instanceof CheckoutDefinitionConflictError) this.changedDefinitions.add(binding.definition.resourceId);
          options.warn(error);
        }
      }
    }
    this.timer = setInterval(() => {
      for (const job of this.admittedJobs.values()) job.check();
      this.poll();
      void this.refreshPeers();
    }, REFRESH_MS);
    this.timer.unref();
  }

  private isLocalAuthority(binding: ExternalBinding): boolean {
    return binding.authorityInstanceId === this.options.viewer.instanceId
      && binding.authorityMachineId === this.options.viewer.machineId;
  }

  /**
   * A binding that names this instance as owner on another machine. It is
   * not a peer: asking "ourselves" over Federation would fail as an unknown
   * outcome instead of a definite refusal.
   */
  private isMisbound(binding: ExternalBinding): boolean {
    return binding.authorityInstanceId === this.options.viewer.instanceId && !this.isLocalAuthority(binding);
  }

  private operatorFor(instanceId: string): CheckoutActor {
    return {
      key: JSON.stringify([instanceId, "operator"]),
      holder: { kind: "operator", label: instanceId === this.options.viewer.instanceId ? "Operator" : "Federation operator" },
      manage: instanceId === this.options.viewer.instanceId,
    };
  }

  threadActor(backend: AppServerBackendKind, threadId: string): CheckoutActor {
    const { instanceId, instanceLabel, profile } = this.options.viewer;
    return {
      key: JSON.stringify([instanceId, backend, threadId]),
      // Other profiles and peers read this holder as stored, so it carries
      // the title and owner they cannot look up themselves.
      holder: { kind: "thread", thread: {
        backend, threadId, title: this.threadTitle({ backend, threadId, instanceId }, "Agent thread"),
        instanceId, instanceLabel: `${instanceLabel} · ${profile}`,
      } },
      manage: this.options.allowAgentDrafts === true,
    };
  }

  private threadTitle(thread: Omit<ResourceThreadRef, "title">, fallback: string): string {
    try {
      return this.options.threadTitle?.({ ...thread, title: fallback })?.trim() || fallback;
    } catch (error) {
      this.options.warn(error);
      return fallback;
    }
  }

  /** Every thread a view names, with the current title where this instance knows it. */
  private labelView(view: ExternalView): ExternalView {
    return { ...view, resource: labelResourceThreads(view.resource, (thread) => ({ ...thread, title: this.threadTitle(thread, thread.title) })) };
  }

  private authorityView(definition: CheckoutDefinition, kind: ResourceAuthority["kind"], status: ResourceAuthority["status"]): ResourceAuthority {
    return {
      authorityId: definition.authorityId, kind, status, epoch: definition.epoch,
      label: kind === "machine_broker" ? "Machine checkout authority" : "Federation checkout authority",
      endpointLabel: kind === "machine_broker" ? "Shared PwrAgent root" : "Configured Federation owner",
    };
  }

  private machineAdvertisements(): ResourceAdvertisement[] {
    if (this.now() - this.lastAdvertisementScan >= 10_000) {
      this.lastAdvertisementScan = this.now();
      try { this.localAdvertisements = this.options.readMachineAdvertisements?.() ?? []; }
      catch (error) { this.localAdvertisements = []; this.options.warn(error); }
    }
    return this.localAdvertisements;
  }

  private localMachineView(actor: CheckoutActor): ExternalView[] {
    const def = this.machineDefinition;
    try {
      if (!this.machine || this.machineConflict) {
        const authority = this.authorityView(def, "machine_broker", "unresolved");
        return [{ authority, resource: projectCheckoutDomain({
          definition: { ...def, publication: "pending_registration" }, generation: 0, grants: [], queue: [],
        }, actor, authority, false, this.machineConflictExplanation) }];
      }
      const authority = this.authorityView(def, "machine_broker", "reachable");
      return this.machine.records().filter(({ definition }) => definition.publication !== "pending_registration"
        || definition.draftOwnerInstanceId === this.options.viewer.instanceId).map((record) => {
        const resource = projectCheckoutDomain(record, actor, authority);
        if (record.definition.resourceId === def.resourceId) {
          resource.advertisements = [{
            instanceId: this.options.viewer.instanceId, instanceLabel: this.options.viewer.instanceLabel,
            profile: this.options.viewer.profile, isViewer: true, onViewerMachine: Boolean(this.options.viewer.machineId),
            freshness: "fresh", observedAt: def.updatedAt,
          }, ...this.machineAdvertisements()];
        }
        return { authority, resource };
      });
    } catch (error) {
      this.options.warn(error);
      const authority = this.authorityView(def, "machine_broker", "unreachable");
      return [{ authority, resource: projectCheckoutDomain({ definition: def, generation: 0, grants: [], queue: [] }, actor, authority) }];
    }
  }

  private externalView(binding: ExternalBinding, actor: CheckoutActor): ExternalView {
    const definition = binding.definition;
    const local = this.isLocalAuthority(binding);
    const saved = local && this.hosted.has(definition.resourceId)
      ? this.external?.records(definition.resourceId)[0]
      : undefined;
    const authority = this.authorityView(definition, "federation_coordinator", saved ? "reachable"
      : local || binding.authorityInstanceId === this.options.viewer.instanceId ? "unresolved" : "unreachable");
    const approved = this.options.approvedLabCheckouts?.get(definition.resourceId);
    const managed = !!saved && approved?.resourceId === definition.resourceId && approved.expiresAt > this.now();
    return {
      authority,
      resource: projectCheckoutDomain(
        saved ?? { definition, generation: 0, grants: [], queue: [] }, actor, authority, managed, this.bindingConflict(binding),
      ),
    };
  }

  /** Why a binding this instance should host is unresolved. */
  private bindingConflict(binding: ExternalBinding): ResourceOwnershipConflict {
    if (!this.isLocalAuthority(binding)) return misboundAuthorityConflict(binding.authorityMachineId);
    if (!this.external) return this.options.externalUnresolved ?? OWNERSHIP_CONFLICTS.federationStoreUnavailable;
    if (this.changedDefinitions.has(binding.definition.resourceId)) return OWNERSHIP_CONFLICTS.definitionChanged;
    return UNEXPLAINED_OWNERSHIP_CONFLICT;
  }

  private readView(actor: CheckoutActor, remotes: ReadonlyMap<string, ExternalView>): ExternalView[] {
    const bindings = this.options.bindings.filter((binding) => this.isLocalAuthority(binding)
      || binding.allowedInstances.includes(this.options.viewer.instanceId));
    const external = new Set(bindings.map(({ definition }) => definition.canonicalKey));
    const local = this.localMachineView(actor).filter(({ resource }) => !external.has(resource.canonicalKey));
    for (const binding of bindings) {
      try {
        local.push(remotes.get(binding.definition.resourceId) ?? this.externalView(binding, actor));
      } catch (error) {
        this.options.warn(error);
        const authority = this.authorityView(binding.definition, "federation_coordinator", "unreachable");
        local.push({ authority, resource: projectCheckoutDomain({
          definition: binding.definition, queue: [], grants: [], generation: 0,
        }, actor, authority) });
      }
    }
    return local.map((view) => this.labelView(view));
  }

  read(): ResourceCheckoutsSnapshot {
    const views = this.readView(this.operator, this.remoteViews);
    const authorities = [...new Map(views.map(({ authority }) => [authority.authorityId, authority])).values()];
    const resources = views.map(({ resource }) => resource);
    const registerGate = this.machineConflict
      ? { allowed: false as const, reason: "ownership_unresolved" as const, detail: "The machine store is unresolved." }
      : { allowed: true as const };
    const fingerprint = JSON.stringify([authorities, resources, registerGate]);
    if (fingerprint !== this.fingerprint) {
      this.fingerprint = fingerprint;
      this.threadsWithCheckouts.clear();
      const rememberThread = (holder: ResourceHolder) => {
        if (holder.kind !== "thread") return;
        const { backend, threadId, instanceId } = holder.thread;
        if (instanceId === undefined || instanceId === this.options.viewer.instanceId) {
          this.threadsWithCheckouts.add(JSON.stringify([backend, threadId]));
        }
      };
      for (const resource of resources) {
        for (const { holder } of resource.allocations) rememberThread(holder);
        for (const { requester } of resource.queue) rememberThread(requester);
      }
      const revision = ++this.revision;
      for (const listener of this.listeners) listener(revision);
    }
    return {
      contractVersion: RESOURCE_CHECKOUTS_CONTRACT_VERSION, revision: this.revision, observedAt: this.now(),
      viewer: this.options.viewer, authorities, resources, registerGate,
    };
  }

  /** Discovery hint from the last owner poll. Mutations still check ownership at the authority. */
  hasAgentCheckoutToCleanUp(backend: AppServerBackendKind, threadId: string): boolean {
    return this.threadsWithCheckouts.has(JSON.stringify([backend, threadId]));
  }

  subscribe(listener: (revision: number) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private poll(): void {
    if (!this.closing && !this.closed) this.read();
  }

  refreshPeers(): Promise<void> {
    if (this.closing || this.closed) return Promise.resolve();
    this.refreshPending ??= this.refreshRemoteViews().finally(() => { this.refreshPending = undefined; });
    return this.refreshPending;
  }

  private async refreshRemoteViews(): Promise<void> {
    const bindings = this.options.bindings.filter((binding) => binding.authorityInstanceId !== this.options.viewer.instanceId
      && binding.allowedInstances.includes(this.options.viewer.instanceId));
    await Promise.all(bindings.map(async (binding) => {
      const id = binding.definition.resourceId;
      const latest = await this.readPeerView(binding);
      if (this.closed) return;
      if (latest) {
        this.remoteViews.set(id, latest);
      } else {
        const old = this.remoteViews.get(id);
        if (old) this.remoteViews.set(id, {
          authority: { ...old.authority, status: "unreachable" },
          resource: { ...old.resource, condition: "unreachable", actions: {},
            allocations: old.resource.allocations.map((grant) => ({ ...grant, lastKnown: true })) },
        });
      }
    }));
    this.poll();
  }

  private async readPeerView(binding: ExternalBinding, actor?: CheckoutActor): Promise<ExternalView | undefined> {
    const id = binding.definition.resourceId;
    try {
      const view = await this.options.requestPeer<ExternalView>(binding.authorityInstanceId, {
        operation: "read", resourceId: id, epoch: binding.definition.epoch, ...(actor ? { subject: this.subject(actor) } : {}),
      });
      if (view.authority.authorityId !== binding.definition.authorityId
        || view.authority.epoch !== binding.definition.epoch
        || view.resource.resourceId !== id || view.resource.canonicalKey !== binding.definition.canonicalKey) return undefined;
      return view;
    } catch {
      return undefined;
    }
  }

  private subject(actor: CheckoutActor): { backend: AppServerBackendKind; threadId: string } | undefined {
    return actor.holder.kind === "thread" ? { backend: actor.holder.thread.backend, threadId: actor.holder.thread.threadId } : undefined;
  }

  async discover(actor: CheckoutActor): Promise<ExternalView[]> {
    const remotes = new Map<string, ExternalView>();
    await Promise.all(this.options.bindings.map(async (binding) => {
      if (binding.authorityInstanceId !== this.options.viewer.instanceId
        && binding.allowedInstances.includes(this.options.viewer.instanceId)) {
        const view = await this.readPeerView(binding, actor);
        if (view) remotes.set(binding.definition.resourceId, view);
      }
    }));
    return this.readView(actor, remotes);
  }

  async status(actor: CheckoutActor, resourceId: string, key: string): Promise<CheckoutStatus | undefined> {
    const binding = this.options.bindings.find((candidate) => candidate.definition.resourceId === resourceId);
    if (binding && !this.isLocalAuthority(binding)) {
      if (this.isMisbound(binding) || !binding.allowedInstances.includes(this.options.viewer.instanceId)) return undefined;
      const response = await this.options.requestPeer<CheckoutStatus | null>(binding.authorityInstanceId, {
        operation: "status", resourceId, key, epoch: binding.definition.epoch, subject: this.subject(actor),
      });
      return response ?? undefined;
    }
    if (binding) return this.hosted.has(resourceId) ? this.external?.status(actor, key, resourceId) : undefined;
    return this.machineConflict ? undefined : this.machine?.status(actor, key, resourceId);
  }

  async perform(value: unknown, actor = this.operator, handoff = false): Promise<ResourceCheckoutActionResult> {
    let action;
    try {
      action = parseCheckoutAction(value);
    } catch (error) {
      return rejectCheckout("policy", error instanceof Error ? error.message : "Invalid checkout action.");
    }
    try {
      if (action.kind === "delegate_execution" && !handoff) return rejectCheckout("not_authorized", "Use the authorized checkout handoff route.");
      if (this.closing || this.closed) return rejectCheckout("authority_unreachable", "The checkout authority is shutting down.");
      if (action.kind === "resolve_ownership") return this.resolveOwnership(actor, action);
      if (action.kind === "register_definition") {
        if (!this.machine || this.machineConflict) return rejectCheckout("ownership_unresolved", "Machine ownership is unresolved.");
        const { draft } = action;
        if (this.options.bindings.some(({ definition }) => definition.canonicalKey === draft.canonicalKey)) {
          return rejectCheckout("conflict", "This canonical key has a configured Federation authority.");
        }
        const owner = this.options.viewer.instanceId;
        const resourceId = "draft:" + createHash("sha256").update(JSON.stringify([owner, draft.canonicalKey])).digest("hex");
        return this.machine.perform(actor, action, { draft: {
          ...this.machineDefinition, resourceId, canonicalKey: draft.canonicalKey, draftOwnerInstanceId: owner,
          displayName: draft.displayName, kindLabel: draft.kindLabel, scope: draft.allocationScope,
          counted: draft.sharing.mode === "counted", capacity: draft.sharing.mode === "counted" ? draft.sharing.capacity : 1,
          publication: "pending_registration", updatedAt: this.now(),
          ...(draft.instructionsSource ? { instructions: {
            revision: 1, title: "Draft operating instructions", source: "pwragent", sourceLabel: "Local draft",
            excerpt: draft.instructionsSource, updatedAt: this.now(),
          } } : {}),
        } });
      }
      const binding = this.options.bindings.find((candidate) => candidate.definition.resourceId === action.resourceId);
      const executor = action.kind === "delegate_execution"
        ? this.checkoutExecutor(action.executor, binding)
        : undefined;
      if (action.kind === "delegate_execution" && !executor) {
        return rejectCheckout("not_authorized", "The requested executor is outside this resource's authorized instances.");
      }
      if (binding) {
        if (this.isLocalAuthority(binding)) {
          if (!this.hosted.has(action.resourceId)) return rejectCheckout("ownership_unresolved", "The configured authority could not confirm this definition.");
          return this.performWithExecutor(this.external!, actor, action, executor);
        }
        if (this.isMisbound(binding)) {
          return rejectCheckout("ownership_unresolved", misboundAuthorityConflict(binding.authorityMachineId).reason);
        }
        if (!binding.allowedInstances.includes(this.options.viewer.instanceId)) return rejectCheckout("not_authorized", "This instance cannot use the resource.");
        if (this.remoteViews.get(action.resourceId)?.authority.status === "unreachable") {
          return rejectCheckout("authority_unreachable", "The configured Federation authority is unreachable.");
        }
        return await this.options.requestPeer(binding.authorityInstanceId, {
          operation: "perform", resourceId: action.resourceId, action, epoch: binding.definition.epoch, subject: this.subject(actor),
        });
      }
      if (!this.machine || this.machineConflict) return rejectCheckout("ownership_unresolved", "Machine ownership is unresolved.");
      if (action.kind === "delegate_execution") return this.performWithExecutor(this.machine, actor, action, executor);
      return this.machine.perform(actor, action, {
        draftOwnerInstanceId: this.options.viewer.instanceId,
        proveFenced: (job) => action.resourceId === this.machineDefinition.resourceId
          && !!job.machineBootId && job.machineBootId === this.options.bootId
          && job.processGroupId !== undefined && isEnvironmentGroupGone(job.processGroupId),
      });
    } catch (error) {
      this.options.warn(error);
      return { outcome: "unknown", message: "The authority did not confirm the outcome. Check status or retry with the same key." };
    } finally {
      this.poll();
      void this.refreshPeers();
    }
  }

  async executeLabCheckout(
    actor: CheckoutActor, token: CheckoutToken, cost: number | "recover", signal = this.shutdown.signal,
  ): Promise<"rejected" | "released" | "recovery_required" | { outcome: "started" | "recovering"; jobId: string }> {
    if (this.closing || this.closed || signal.aborted) return "rejected";
    const binding = this.options.bindings.find(({ definition }) => definition.resourceId === token.resourceId);
    if (!binding || binding.definition.epoch !== token.epoch) return "rejected";
    if (!this.isLocalAuthority(binding)) {
      if (this.isMisbound(binding) || !binding.allowedInstances.includes(this.options.viewer.instanceId)) return "rejected";
      return await this.options.requestPeer(binding.authorityInstanceId, {
        operation: "lab_execution", resourceId: token.resourceId, epoch: token.epoch, token, cost, subject: this.subject(actor),
      });
    }
    const approved = this.options.approvedLabCheckouts?.get(token.resourceId);
    if (approved?.resourceId !== token.resourceId || !this.external || !this.hosted.has(token.resourceId)) return "rejected";
    const authority = this.external;
    const adapter = createPwrSuiteLabCheckoutAdapter(approved, this.now);
    const key = JSON.stringify([token.resourceId, token.allocationId, token.epoch, token.generation]);
    if (cost === "recover") {
      const job = authority.providerJob(actor, token);
      if (!job?.provider || job.executor !== adapter.id || job.provider.adapterScope !== adapter.scope) return "rejected";
      if (!this.providerWorkInFlight.has(key)) {
        this.providerWorkInFlight.set(key, job.id);
        const work = recoverResourceCheckout({ actor, authority, token, adapter }).catch(this.options.warn);
        this.providerJobs.set(work, () => { authority.markJobRecovery(token, job.id); });
        void work.then(() => {
          this.providerJobs.delete(work);
          this.providerWorkInFlight.delete(key);
        });
      }
      return { outcome: "recovering", jobId: job.id };
    }
    const jobId = randomUUID();
    const started = Promise.withResolvers<{ outcome: "started"; jobId: string }>();
    const work = executeResourceCheckout({
      actor, token, authority, adapter, policy: approved.policy, jobId,
      costMinorUnits: cost, signal: this.shutdown.signal,
      onBound: () => {
        this.providerWorkInFlight.set(key, jobId);
        started.resolve({ outcome: "started", jobId });
      },
    }).catch((error) => {
      this.options.warn(error);
      return "recovery_required" as const;
    });
    this.providerJobs.set(work, () => { authority.markJobRecovery(token, jobId); });
    void work.then(() => {
      this.providerJobs.delete(work);
      if (this.providerWorkInFlight.get(key) === jobId) this.providerWorkInFlight.delete(key);
    });
    return await Promise.race([started.promise, work]);
  }

  handoffInstanceId(): string {
    return this.options.viewer.instanceId;
  }

  /**
   * Apply the operator's fix for an unresolved authority. Each resolution is
   * recorded under its request key in the store it changes, so a retry after
   * success returns the same result.
   */
  private resolveOwnership(actor: CheckoutActor, action: OwnershipAction): ResourceCheckoutActionResult {
    if (!actor.manage || actor.holder.kind !== "operator") {
      return rejectCheckout("not_authorized", "Only this instance's operator can resolve ownership.");
    }
    const binding = this.options.bindings.find((candidate) => candidate.definition.resourceId === action.resourceId);
    if (binding) {
      const id = binding.definition.resourceId;
      if (!this.isLocalAuthority(binding) || !this.external) return rejectCheckout("not_applicable", this.bindingConflict(binding).remedy);
      if (!this.changedDefinitions.has(id)) return this.external.resolveOwnership(actor, action);
      if (action.resolution !== "accept_definition") return rejectCheckout("not_applicable", OWNERSHIP_CONFLICTS.definitionChanged.remedy);
      const result = this.external.resolveOwnership(actor, action, (record) => { record.definition = binding.definition; });
      if (result.outcome === "accepted") {
        this.changedDefinitions.delete(id);
        this.hosted.add(id);
      }
      return result;
    }
    if (action.resourceId !== this.machineDefinition.resourceId) {
      return rejectCheckout("not_applicable", "This resource has no ownership conflict.");
    }
    const offered = this.machineConflict ? this.machineConflictExplanation.resolution?.kind : undefined;
    if (!offered) {
      return this.machine && !this.machineConflict
        ? this.machine.resolveOwnership(actor, action)
        : rejectCheckout("not_applicable", this.machineConflictExplanation.remedy);
    }
    if (action.resolution !== offered) return rejectCheckout("not_applicable", this.machineConflictExplanation.remedy);
    if (offered === "accept_definition" && this.machine) {
      const result = this.machine.resolveOwnership(actor, action, (record) => this.acceptMachineDefinition(record));
      if (result.outcome === "accepted") this.machineResolved(this.machine);
      return result;
    }
    if (!this.machine) {
      const adopt = this.options.adoptMachineStore;
      if (!adopt) return rejectCheckout("not_applicable", this.machineConflictExplanation.remedy);
      let opened: { store: Store; adopted: boolean };
      try {
        opened = adopt();
      } catch (error) {
        this.options.warn(error);
        return rejectCheckout("not_applicable", OWNERSHIP_CONFLICTS.machineStoreUnavailable.remedy);
      }
      const machine = new ResourceCheckoutAuthority(opened.store, this.now, randomUUID);
      try {
        machine.ensure(this.machineDefinition, { machineCpuPool: true });
      } catch (error) {
        // A copied record is replaced below; anything else leaves nothing half bound.
        if (!(error instanceof CheckoutDefinitionConflictError)) {
          opened.store.close();
          this.options.warn(error);
          return rejectCheckout("not_applicable", OWNERSHIP_CONFLICTS.machineStoreUnavailable.remedy);
        }
      }
      this.machineStore = opened.store;
      this.machine = machine;
      this.machineAdopted = opened.adopted;
    }
    const adopted = this.machineAdopted;
    const result = this.machine.resolveOwnership(actor, action, (record, now) => {
      this.acceptMachineDefinition(record);
      // Holds and waiters copied from the other machine never held this one.
      // When another profile on this root adopted first, they are its own.
      if (!adopted) return;
      record.grants = [];
      record.queue = [];
      record.cleanupVerifiedAt = now;
    });
    if (result.outcome === "accepted") this.machineResolved(this.machine);
    return result;
  }

  /**
   * The first profile to initialize the counted pool set its capacity, and a
   * later CPU sample can't resize it under live reservations, so keep it.
   */
  private acceptMachineDefinition(record: CheckoutDomainRecord): void {
    const saved = record.definition;
    if (saved.counted) {
      record.definition = { ...this.machineDefinition, capacity: saved.capacity };
      return;
    }
    // A pre-release single-slot record: its holds took the whole machine.
    record.definition = this.machineDefinition;
    for (const hold of [...record.grants, ...record.queue]) hold.units = this.machineDefinition.capacity;
  }

  private machineResolved(machine: ResourceCheckoutAuthority): void {
    this.machineConflict = false;
    if (!this.options.bootId) return;
    try {
      // The constructor skipped this while the machine was unresolved.
      machine.reconcilePriorMachineBoot(this.machineDefinition.resourceId, this.options.bootId);
    } catch (error) {
      this.options.warn(error);
    }
  }

  private performWithExecutor(
    authority: ResourceCheckoutAuthority, actor: CheckoutActor, action: ResourceCheckoutActionRequest, executor?: CheckoutActor,
  ): ResourceCheckoutActionResult {
    const result = authority.perform(actor, action, { executor });
    if (action.kind === "delegate_execution" && result.outcome === "accepted"
      && (!executor || !authority.delegationIsCurrent(actor, action, executor))) {
      return rejectCheckout("stale_generation", "The recorded delegation no longer has an idle grant to route.");
    }
    return result;
  }

  private checkoutExecutor(
    executor: CheckoutDelegation["executor"],
    binding?: ExternalBinding,
  ): CheckoutActor | undefined {
    const { instanceId, backend, threadId } = executor;
    if (binding ? instanceId !== binding.authorityInstanceId && !binding.allowedInstances.includes(instanceId)
      : instanceId !== this.options.viewer.instanceId) return undefined;
    return this.peerActor(instanceId, { backend, threadId });
  }

  admitMachineJob(jobId: string, purpose: string, options: {
    thread?: { backend: AppServerBackendKind; threadId: string }; retainExistingGrant?: boolean;
  } = {}) {
    if (!this.machine || this.machineConflict || this.closing || this.closed) throw new Error("The machine checkout authority is unavailable.");
    const machine = this.machine;
    const actor: CheckoutActor = options.thread ? this.threadActor(options.thread.backend, options.thread.threadId) : {
      key: JSON.stringify([this.options.viewer.instanceId, "automation", jobId]),
      holder: { kind: "automation", label: purpose },
      manage: false,
    };
    const token = machine.admitLocalJob(this.machineDefinition.resourceId, actor, purpose, {
      id: jobId, machineBootId: this.options.bootId, executor: this.options.viewer.instanceLabel + " · " + this.options.viewer.profile,
    }, options.retainExistingGrant);
    if (!token) throw new Error("Machine capacity is reserved. Check Resources and retry when capacity is available.");
    this.poll();
    let cancelled = false;
    const completion = Promise.withResolvers<void>();
    const markRecovery = () => { machine.markJobRecovery(token, jobId); };
    return {
      watch: (stop: () => void): void => {
        const cancel = () => {
          if (cancelled) return;
          cancelled = true;
          stop();
        };
        const check = () => {
          try {
            if (!machine.jobMayRun(token, jobId)) cancel();
          } catch (error) {
            this.options.warn(error);
            cancel();
          }
        };
        this.admittedJobs.set(jobId, { check, stop: cancel, markRecovery, settled: completion.promise });
        check();
      },
      active: (processGroupId?: number): void => {
        try {
          if (!machine.activateJob(token, jobId, processGroupId)) this.admittedJobs.get(jobId)?.stop();
          this.poll();
        } catch (error) {
          this.options.warn(error);
          this.admittedJobs.get(jobId)?.stop();
        }
      },
      finish: (verified: boolean): void => {
        this.admittedJobs.delete(jobId);
        try {
          if (this.closed) return;
          if (verified) machine.finishJob(token, jobId);
          else markRecovery();
          if (!this.closing) this.poll();
        } catch (error) {
          this.options.warn(error);
        } finally {
          completion.resolve();
        }
      },
    };
  }

  receivePeer(sourceInstanceId: string, value: unknown): unknown {
    if (this.closing || this.closed) throw new Error("The checkout authority is shutting down.");
    const request = object(value);
    const id = text(request.resourceId, "resource ID");
    const binding = this.options.bindings.find((candidate) => candidate.definition.resourceId === id);
    if (!binding || !this.isLocalAuthority(binding) || !this.hosted.has(id) || !binding.allowedInstances.includes(sourceInstanceId)) {
      throw new Error("This owner has no checkout authority available to the authenticated peer for that resource.");
    }
    if (request.epoch !== binding.definition.epoch) throw new Error("The configured authority epoch is stale.");
    const actor = this.peerActor(sourceInstanceId, request.subject);
    if (request.operation === "read") return this.labelView(this.externalView(binding, actor));
    if (request.operation === "status") return this.external!.status(actor, text(request.key, "request key"), id) ?? null;
    if (request.operation === "lab_execution") {
      const token = parseCheckoutToken(request.token);
      if (token.resourceId !== id || token.epoch !== binding.definition.epoch
        || (request.cost !== "recover" && (typeof request.cost !== "number" || !Number.isSafeInteger(request.cost) || request.cost < 0))) {
        throw new Error("Invalid provider execution request.");
      }
      return this.executeLabCheckout(actor, token, request.cost);
    }
    if (request.operation !== "perform") throw new Error("Unknown checkout authority operation.");
    const action = parseCheckoutAction(request.action);
    if (action.kind === "register_definition" || action.resourceId !== id) throw new Error("The action does not match the authority binding.");
    const executor = action.kind === "delegate_execution" ? this.checkoutExecutor(action.executor, binding) : undefined;
    if (action.kind === "delegate_execution" && !executor) {
      return rejectCheckout("not_authorized", "The requested executor is outside this resource's authorized instances.");
    }
    const result = this.performWithExecutor(this.external!, actor, action, executor);
    this.poll();
    return result;
  }

  private peerActor(sourceInstanceId: string, subject: unknown): CheckoutActor {
    if (subject === undefined) return this.operatorFor(sourceInstanceId);
    const claims = object(subject);
    const backend = text(claims.backend, "backend");
    if (!isAppServerBackendKind(backend)) throw new Error("Invalid backend.");
    const threadId = text(claims.threadId, "thread ID");
    // The authenticated owner can delegate a subject on its own instance only.
    return {
      key: JSON.stringify([sourceInstanceId, backend, threadId]), manage: false,
      holder: { kind: "thread", thread: {
        backend, threadId, instanceId: sourceInstanceId,
        title: this.threadTitle({ backend, threadId, instanceId: sourceInstanceId }, "Federation agent thread"),
      } },
    };
  }

  close(graceMs = 2_000): Promise<void> {
    if (this.closing) return this.closing;
    const completion = Promise.withResolvers<void>();
    this.closing = completion.promise;
    void this.drainAndClose(graceMs).then(completion.resolve, completion.reject);
    return this.closing;
  }

  private async drainAndClose(graceMs: number): Promise<void> {
    this.shutdown.abort();
    clearInterval(this.timer);
    this.listeners.clear();
    const jobs = [...this.admittedJobs.values()];
    for (const job of jobs) {
      try { job.stop(); }
      catch (error) { this.options.warn(error); }
    }
    if ((this.admittedJobs.size || this.providerJobs.size) && graceMs > 0) {
      let deadline: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all([...jobs.map((job) => job.settled), ...this.providerJobs.keys()]),
        new Promise<void>((resolve) => { deadline = setTimeout(resolve, graceMs); }),
      ]);
      clearTimeout(deadline);
    }
    for (const job of this.admittedJobs.values()) {
      try { job.markRecovery(); }
      catch (error) { this.options.warn(error); }
    }
    this.admittedJobs.clear();
    for (const markRecovery of this.providerJobs.values()) {
      try { markRecovery(); }
      catch (error) { this.options.warn(error); }
    }
    this.providerJobs.clear();
    this.closed = true;
    this.machineStore?.close();
    this.options.externalStore?.close();
  }
}
