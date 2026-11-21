import { isEnvironmentGroupGone } from "./checkout-machine-evidence";
import { createHash, randomUUID } from "node:crypto";
import { ResourceCheckoutAuthority, MAX_CHECKOUT_HOLD_MS, rejectCheckout, type CheckoutStatus } from "@pwragent/owner-core/resource-checkout-authority";
import type { CheckoutActor, CheckoutDefinition, CheckoutStore } from "@pwragent/owner-core/resource-checkout-storage";
import {
  RESOURCE_CHECKOUTS_CONTRACT_VERSION, type ResourceAuthority, type ResourceCheckoutActionResult,
  type ResourceCheckoutsSnapshot, type ResourceViewer, type ResourceDomain, type ResourceAdvertisement,
} from "@pwragent/shared/contracts/resource-checkouts";
import { isAppServerBackendKind } from "@pwragent/shared/contracts/navigation";
import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import { parseCheckoutAction, object, text } from "./checkout-input";
import type { ExternalBinding } from "./checkout-configuration";
import { projectCheckoutDomain } from "./checkout-projection";

export const CHECKOUT_FEDERATION_METHOD = "resourceCheckouts.authority.v1";
const REFRESH_MS = 2_000;

type Store = CheckoutStore & { close(): void };

type Options = {
  viewer: ResourceViewer;
  machineStore?: Store;
  externalStore?: Store;
  bindings: ExternalBinding[];
  allowAgentDrafts?: boolean;
  bootId?: string;
  readMachineAdvertisements?: () => ResourceAdvertisement[];
  requestPeer: <T>(instanceId: string, request: unknown) => Promise<T>;
  warn: (error: unknown) => void;
  now?: () => number;
};

type ExternalView = { authority: ResourceAuthority; resource: ResourceDomain };

export class DesktopResourceCheckoutService {
  private readonly now: () => number;
  private readonly machine?: ResourceCheckoutAuthority;
  private readonly machineDefinition: CheckoutDefinition;
  private readonly external?: ResourceCheckoutAuthority;
  private readonly hosted = new Set<string>();
  private readonly operator: CheckoutActor;
  private readonly listeners = new Set<(revision: number) => void>();
  private readonly remoteViews = new Map<string, ExternalView>();
  private readonly timer: NodeJS.Timeout;
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
      scope: "machine", capacity: 1, counted: false, authorityId: machineKey, epoch: 1,
      maxHoldMs: MAX_CHECKOUT_HOLD_MS, publication: "published", revision: 1, updatedAt: this.now(),
    };
    if (machineStore) {
      try {
        this.machine = new ResourceCheckoutAuthority(machineStore, this.now, randomUUID);
        this.machine.ensure(this.machineDefinition);
        if (options.bootId) this.machine.reconcilePriorMachineBoot(machineKey, options.bootId);
      } catch (error) {
        this.machineConflict = true;
        options.warn(error);
      }
    } else {
      this.machineConflict = true;
    }
    if (externalStore) {
      this.external = new ResourceCheckoutAuthority(externalStore, this.now, randomUUID);
      for (const binding of bindings) {
        if (!this.isLocalAuthority(binding)) continue;
        try {
          this.external.ensure(binding.definition);
          this.hosted.add(binding.definition.resourceId);
        } catch (error) {
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

  private operatorFor(instanceId: string): CheckoutActor {
    return {
      key: JSON.stringify([instanceId, "operator"]),
      holder: { kind: "operator", label: instanceId === this.options.viewer.instanceId ? "Operator" : "Federation operator" },
      manage: instanceId === this.options.viewer.instanceId,
    };
  }

  threadActor(backend: AppServerBackendKind, threadId: string): CheckoutActor {
    return {
      key: JSON.stringify([this.options.viewer.instanceId, backend, threadId]),
      holder: { kind: "thread", thread: { backend, threadId, title: "Agent thread" } },
      manage: this.options.allowAgentDrafts === true,
    };
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
    const unresolved = () => this.authorityView(def, "machine_broker", "unresolved");
    try {
      if (!this.machine || this.machineConflict) {
        return [{ authority: unresolved(), resource: projectCheckoutDomain({ definition: def, generation: 0, grants: [], queue: [] }, actor, unresolved()) }];
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
    return { authority, resource: projectCheckoutDomain(saved ?? { definition, generation: 0, grants: [], queue: [] }, actor, authority) };
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
    return local;
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
      const revision = ++this.revision;
      for (const listener of this.listeners) listener(revision);
    }
    return {
      contractVersion: RESOURCE_CHECKOUTS_CONTRACT_VERSION, revision: this.revision, observedAt: this.now(),
      viewer: this.options.viewer, authorities, resources, registerGate,
    };
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
      if (!binding.allowedInstances.includes(this.options.viewer.instanceId)) return undefined;
      const response = await this.options.requestPeer<CheckoutStatus | null>(binding.authorityInstanceId, {
        operation: "status", resourceId, key, epoch: binding.definition.epoch, subject: this.subject(actor),
      });
      return response ?? undefined;
    }
    if (binding) return this.hosted.has(resourceId) ? this.external?.status(actor, key, resourceId) : undefined;
    return this.machineConflict ? undefined : this.machine?.status(actor, key, resourceId);
  }

  async perform(value: unknown, actor = this.operator): Promise<ResourceCheckoutActionResult> {
    let action;
    try {
      action = parseCheckoutAction(value);
    } catch (error) {
      return rejectCheckout("policy", error instanceof Error ? error.message : "Invalid checkout action.");
    }
    try {
      if (this.closing || this.closed) return rejectCheckout("authority_unreachable", "The checkout authority is shutting down.");
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
      if (binding) {
        if (this.isLocalAuthority(binding)) {
          if (!this.hosted.has(action.resourceId)) return rejectCheckout("ownership_unresolved", "The configured authority could not confirm this definition.");
          return this.external!.perform(actor, action);
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

  admitEnvironmentAction(jobId: string, purpose: string, threadId?: string) {
    if (!this.machine || this.machineConflict || this.closing || this.closed) throw new Error("The machine checkout authority is unavailable.");
    const machine = this.machine;
    const actor: CheckoutActor = threadId ? this.threadActor("codex", threadId) : {
      key: JSON.stringify([this.options.viewer.instanceId, "automation", jobId]),
      holder: { kind: "automation", label: "Environment action" },
      manage: false,
    };
    const token = machine.admitLocalJob(this.machineDefinition.resourceId, actor, purpose, {
      id: jobId, machineBootId: this.options.bootId, executor: this.options.viewer.instanceLabel + " · " + this.options.viewer.profile,
    });
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
    if (request.operation === "read") return this.externalView(binding, actor);
    if (request.operation === "status") return this.external!.status(actor, text(request.key, "request key"), id) ?? null;
    if (request.operation !== "perform") throw new Error("Unknown checkout authority operation.");
    const action = parseCheckoutAction(request.action);
    if (action.kind === "register_definition" || action.resourceId !== id) throw new Error("The action does not match the authority binding.");
    const result = this.external!.perform(actor, action);
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
      holder: { kind: "thread", thread: { backend, threadId, title: "Federation agent thread", instanceId: sourceInstanceId } },
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
    clearInterval(this.timer);
    this.listeners.clear();
    const jobs = [...this.admittedJobs.values()];
    for (const job of jobs) {
      try { job.stop(); }
      catch (error) { this.options.warn(error); }
    }
    if (this.admittedJobs.size && graceMs > 0) {
      let deadline: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all(jobs.map((job) => job.settled)),
        new Promise<void>((resolve) => { deadline = setTimeout(resolve, graceMs); }),
      ]);
      clearTimeout(deadline);
    }
    for (const job of this.admittedJobs.values()) {
      try { job.markRecovery(); }
      catch (error) { this.options.warn(error); }
    }
    this.admittedJobs.clear();
    this.closed = true;
    this.options.machineStore?.close();
    this.options.externalStore?.close();
  }
}
