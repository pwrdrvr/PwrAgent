import {
  federationShortLabelFor,
  federationShortNameKey,
  isFederationInstanceShortName,
  MAX_FEDERATION_SHORT_NAMES,
  mergeFederationInstanceShortNames,
  normalizeFederationShortName,
  sameFederationShortNameEntry,
  type FederationHostInfo,
  type FederationInstanceShortName,
} from "@pwragent/shared";
import {
  federationShortNameInputKey,
  federationShortNamesNeedGeneration,
  planFederationShortNames,
  type FederationShortNameGenerationResult,
  type FederationShortNameMachine,
  type FederationShortNamePlan,
} from "./federation-short-name-generator";

/** state.db meta key holding the merged map, as a JSON array of entries. */
export const FEDERATION_SHORT_NAMES_META_KEY = "federation_instance_short_names";

/**
 * How long the gateway waits after the last change before it asks the
 * model, so a startup burst of reconnects makes one call, not one per peer.
 */
export const FEDERATION_SHORT_NAME_QUIET_MS = 30_000;
/** The same wait after an operator hands a machine back to the gateway. */
const OPERATOR_QUIET_MS = 1_000;

/**
 * When the helper could not answer at all (Codex still starting, offline),
 * the same input is tried again after this long. An answer that came back
 * and failed validation is not retried until the machines change.
 */
export const FEDERATION_SHORT_NAME_RETRY_MS = 60 * 60_000;

/**
 * How long a tombstone stays in the map: long enough for every enrolled
 * peer to reconnect and merge the removal. Matches the celestial map.
 */
const TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60_000;

export type FederationShortNameInstance = {
  id: string;
  label: string;
  profileName?: string;
  host?: FederationHostInfo;
};

export type FederationShortNameDeps = {
  /** Undefined before app state exists (and in unit harnesses). */
  readMeta: () => string | undefined;
  writeMeta: (value: string) => void;
  /** The root gateway coordinates; every other instance only merges. */
  isCoordinator: () => boolean;
  /** Every live instance this one can see, itself included, revoked excluded. */
  listInstances: () => FederationShortNameInstance[];
  generate: (plan: FederationShortNamePlan) => Promise<FederationShortNameGenerationResult>;
  /** Send the full map to connected peers, except the one it came from. */
  broadcast: (entries: FederationInstanceShortName[], excludePeerId?: string) => void;
  /** Tell local renderers that short names changed. */
  publishChanged: () => void;
  log?: (message: string, fields: Record<string, unknown>) => void;
  now?: () => number;
};

/**
 * The federation-wide short-name map, one per runtime. The root gateway
 * names machines (through the helper model) and every instance merges the
 * gateway's map, persists it, and resolves short names from its own copy.
 *
 * Writes: the map persists as one state.db meta value, written only when a
 * merge or a generation actually changes it. A reconnect that re-sends an
 * unchanged map writes nothing.
 */
export class FederationShortNameCoordinator {
  private map?: Map<string, FederationInstanceShortName>;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private rerun = false;
  private disposed = false;
  /**
   * Generation inputs already tried in this process, and when. A key with
   * `retryAt` may be tried again after that time; one without never is.
   */
  private readonly attempted = new Map<string, { retryAt?: number }>();

  constructor(private readonly deps: FederationShortNameDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private entryMap(): Map<string, FederationInstanceShortName> {
    if (this.map) return this.map;
    const map = new Map<string, FederationInstanceShortName>();
    const raw = this.deps.readMeta();
    if (raw === undefined) {
      // Pre-init callers get a throwaway map; the persisted one loads later.
      return map;
    }
    try {
      const parsed: unknown = JSON.parse(raw || "[]");
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (map.size >= MAX_FEDERATION_SHORT_NAMES) break;
          if (isFederationInstanceShortName(entry)) map.set(entry.instanceId, entry);
        }
      }
    } catch {
      // Corrupt cache: the gateway's next broadcast rebuilds it.
    }
    this.map = map;
    return map;
  }

  private persist(): void {
    if (!this.map) return;
    this.deps.writeMeta(JSON.stringify([...this.map.values()]));
  }

  /** The protocol view, tombstones included. */
  entries(): FederationInstanceShortName[] {
    return [...this.entryMap().values()];
  }

  shortLabelFor(instanceId: string, label: string): string | undefined {
    return federationShortLabelFor(this.entryMap().get(instanceId), label);
  }

  /** The drawable short name and who chose it, for health reads. */
  shortNameFor(
    instanceId: string,
    label: string,
  ): { shortLabel: string; source: FederationInstanceShortName["source"] } | undefined {
    const entry = this.entryMap().get(instanceId);
    const shortLabel = federationShortLabelFor(entry, label);
    return shortLabel && entry ? { shortLabel, source: entry.source } : undefined;
  }

  /** Every instance broadcasts its copy on connect, as the celestial map does. */
  announce(excludePeerId?: string): void {
    const entries = this.entries();
    if (entries.length > 0) this.deps.broadcast(entries, excludePeerId);
  }

  /**
   * Merge a peer's snapshot. Returns true when the map changed, after
   * persisting, publishing, and re-sending it to everyone but the source:
   * a dual hub forwards the gateway's map down, and a client's offline
   * override rides up. Idempotent merges stop the fan-out.
   */
  apply(incoming: unknown, sourcePeerId: string): boolean {
    if (!Array.isArray(incoming)) return false;
    const expired = this.expireTombstones();
    const current = this.entries();
    const known = new Set(current.map((entry) => entry.instanceId));
    let room = MAX_FEDERATION_SHORT_NAMES - current.filter((entry) => !entry.removed).length;
    const accepted: FederationInstanceShortName[] = [];
    let dropped = 0;
    for (const entry of incoming) {
      if (!isFederationInstanceShortName(entry)) continue;
      if (known.has(entry.instanceId)) {
        accepted.push(entry);
      } else if (room > 0 || entry.removed) {
        accepted.push(entry);
        known.add(entry.instanceId);
        if (!entry.removed) room -= 1;
      } else {
        dropped += 1;
      }
    }
    if (dropped > 0) {
      this.deps.log?.("short-name snapshot exceeded the entry cap", { sourcePeerId, dropped });
    }
    const merged = mergeFederationInstanceShortNames(current, accepted);
    if (!merged.changed) {
      if (expired) this.persist();
      return false;
    }
    this.replace(merged.entries);
    this.persist();
    this.deps.publishChanged();
    this.deps.broadcast(this.entries(), sourcePeerId);
    // A dual hub's clients can join the gateway's view through this path,
    // and an incoming entry can collide with a local name.
    this.reconcile();
    return true;
  }

  private replace(entries: readonly FederationInstanceShortName[]): void {
    const map = this.entryMap();
    map.clear();
    for (const entry of entries) map.set(entry.instanceId, entry);
  }

  private expireTombstones(): boolean {
    const map = this.entryMap();
    let changed = false;
    for (const entry of [...map.values()]) {
      if (entry.removed && this.now() - entry.updatedAt > TOMBSTONE_TTL_MS) {
        map.delete(entry.instanceId);
        changed = true;
      }
    }
    return changed;
  }

  /** Tombstone a revoked instance and propagate the removal. */
  remove(instanceId: string, removedAt: number): void {
    const existing = this.entryMap().get(instanceId);
    if (!existing || existing.removed) return;
    this.write([{ ...existing, source: "auto", removed: true, updatedAt: Math.max(removedAt, existing.updatedAt + 1) }]);
  }

  /**
   * Write entries, then persist, publish and broadcast once. Skips entries
   * identical to what the map holds, and the whole write when nothing is
   * left, so callers can hand it a full desired state.
   */
  private write(entries: readonly FederationInstanceShortName[]): boolean {
    const map = this.entryMap();
    const changed = entries.filter((entry) => {
      const existing = map.get(entry.instanceId);
      return !existing || !sameFederationShortNameEntry(existing, entry);
    });
    if (changed.length === 0) return false;
    for (const entry of changed) map.set(entry.instanceId, entry);
    this.persist();
    this.deps.publishChanged();
    this.deps.broadcast(this.entries());
    return true;
  }

  /** Group live instances into machines by full label, with their names. */
  machines(): Array<FederationShortNameMachine & { instanceIds: string[] }> {
    const map = this.entryMap();
    const byLabel = new Map<string, FederationShortNameMachine & { instanceIds: string[] }>();
    for (const instance of this.deps.listInstances()) {
      let machine = byLabel.get(instance.label);
      if (!machine) {
        machine = { label: instance.label, profiles: [], instanceIds: [] };
        byLabel.set(instance.label, machine);
      }
      machine.instanceIds.push(instance.id);
      if (instance.profileName && !machine.profiles.includes(instance.profileName)) {
        machine.profiles.push(instance.profileName);
      }
      machine.host ??= instance.host;
    }
    for (const machine of byLabel.values()) {
      // The newest live entry for this label decides, per source: one
      // instance's override names the whole machine, and a newly enrolled
      // profile of a named machine inherits the name.
      let override: FederationInstanceShortName | undefined;
      let auto: FederationInstanceShortName | undefined;
      for (const id of machine.instanceIds) {
        const entry = map.get(id);
        if (!entry || entry.removed || entry.basis !== machine.label) continue;
        if (entry.source === "override") {
          if (!override || entry.updatedAt > override.updatedAt) override = entry;
        } else if (!auto || entry.updatedAt > auto.updatedAt) {
          auto = entry;
        }
      }
      if (override) machine.override = override.shortLabel;
      else if (auto) machine.current = auto.shortLabel;
    }
    return [...byLabel.values()];
  }

  /**
   * Coordinator pass: give every instance of a named machine its machine's
   * entry (a new profile of a known machine, a fresh override), then
   * schedule a model call when a machine has no usable name. Cheap and
   * write-free when nothing changed, so it can run on every connect.
   */
  reconcile(options?: { quietMs?: number }): void {
    if (this.disposed) return;
    const expired = this.expireTombstones();
    if (!this.deps.isCoordinator()) {
      if (expired) this.persist();
      return;
    }
    const machines = this.machines();
    const wrote = this.write(this.fillIn(machines));
    if (!wrote && expired) this.persist();
    if (!federationShortNamesNeedGeneration(machines)) {
      this.cancelTimer();
      return;
    }
    if (this.wasAttempted(federationShortNameInputKey(machines))) return;
    this.schedule(options?.quietMs ?? FEDERATION_SHORT_NAME_QUIET_MS);
  }

  private fillIn(
    machines: ReadonlyArray<FederationShortNameMachine & { instanceIds: string[] }>,
  ): FederationInstanceShortName[] {
    const map = this.entryMap();
    const writes: FederationInstanceShortName[] = [];
    for (const machine of machines) {
      const name = machine.override ?? machine.current;
      if (!name) continue;
      const source = machine.override ? "override" : "auto";
      for (const id of machine.instanceIds) {
        const existing = map.get(id);
        if (
          existing
          && !existing.removed
          && existing.basis === machine.label
          && existing.shortLabel === name
          && existing.source === source
        ) {
          continue;
        }
        writes.push({
          instanceId: id,
          shortLabel: name,
          basis: machine.label,
          source,
          updatedAt: this.nextUpdatedAt(existing),
        });
      }
    }
    return writes;
  }

  private wasAttempted(inputKey: string): boolean {
    const attempt = this.attempted.get(inputKey);
    return attempt !== undefined
      && (attempt.retryAt === undefined || this.now() < attempt.retryAt);
  }

  private nextUpdatedAt(existing: FederationInstanceShortName | undefined): number {
    return existing ? Math.max(this.now(), existing.updatedAt + 1) : this.now();
  }

  private schedule(quietMs: number): void {
    this.cancelTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runGeneration();
    }, quietMs);
    // A pending name never keeps the process alive.
    (this.timer as { unref?: () => void }).unref?.();
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Run any pending generation now (tests, and an explicit operator reset). */
  async flush(): Promise<void> {
    if (!this.timer) return;
    this.cancelTimer();
    await this.runGeneration();
  }

  private async runGeneration(): Promise<void> {
    if (this.disposed || !this.deps.isCoordinator()) return;
    if (this.running) {
      this.rerun = true;
      return;
    }
    const machines = this.machines();
    if (!federationShortNamesNeedGeneration(machines)) return;
    const inputKey = federationShortNameInputKey(machines);
    if (this.wasAttempted(inputKey)) return;
    this.attempted.set(inputKey, {});
    this.running = true;
    const startedAt = this.now();
    const plan = planFederationShortNames(machines);
    try {
      const result = await this.deps.generate(plan);
      if (this.disposed) return;
      const now = this.machines();
      if (federationShortNameInputKey(now) !== inputKey) {
        // The machines changed while the model thought. Its answer names a
        // set that no longer exists; the next pass asks again.
        this.deps.log?.("short names discarded: machines changed during generation", {
          elapsedMs: this.now() - startedAt,
        });
        this.rerun = true;
        return;
      }
      if (!result.ok) {
        if (!result.answered) {
          this.attempted.set(inputKey, { retryAt: this.now() + FEDERATION_SHORT_NAME_RETRY_MS });
        }
        this.deps.log?.("short-name generation failed; full labels stay", {
          reason: result.reason,
          answered: result.answered,
          candidates: plan.candidates.length,
          elapsedMs: this.now() - startedAt,
        });
        return;
      }
      const map = this.entryMap();
      const writes: FederationInstanceShortName[] = [];
      for (const machine of now) {
        const name = result.names.get(machine.label);
        if (!name || machine.override) continue;
        for (const id of machine.instanceIds) {
          const existing = map.get(id);
          writes.push({
            instanceId: id,
            shortLabel: name,
            basis: machine.label,
            source: "auto",
            updatedAt: existing
              && !existing.removed
              && existing.basis === machine.label
              && existing.source === "auto"
              && existing.shortLabel === name
              ? existing.updatedAt
              : this.nextUpdatedAt(existing),
          });
        }
      }
      this.write(writes);
      this.deps.log?.("short names generated", {
        candidates: plan.candidates.length,
        reserved: plan.reserved.length,
        renamed: writes.filter((entry) => {
          const machine = now.find((candidate) => candidate.label === entry.basis);
          return machine?.current !== undefined && machine.current !== entry.shortLabel;
        }).length,
        model: result.model,
        elapsedMs: this.now() - startedAt,
      });
    } finally {
      this.running = false;
      if (this.rerun && !this.disposed) {
        this.rerun = false;
        this.reconcile();
      }
    }
  }

  /**
   * Apply an operator name to every instance of the machine, or hand the
   * machine back to the gateway (`null`). Rejects a name another machine
   * already shows, so a rename can never make two machines look alike.
   */
  setOverride(instanceId: string, shortLabel: string | null): FederationInstanceShortName[] {
    const machines = this.machines();
    const machine = machines.find((candidate) => candidate.instanceIds.includes(instanceId));
    if (!machine) {
      throw new Error("That federation instance is not known here.");
    }
    const map = this.entryMap();
    if (shortLabel === null) {
      this.write(machine.instanceIds.flatMap((id) => {
        const existing = map.get(id);
        return existing && !existing.removed
          ? [{ ...existing, source: "auto" as const, removed: true, updatedAt: this.nextUpdatedAt(existing) }]
          : [];
      }));
      // The handed-back machine is a new input, even when the same one
      // failed before.
      this.attempted.clear();
      this.reconcile({ quietMs: OPERATOR_QUIET_MS });
      return this.entries();
    }
    const name = normalizeFederationShortName(shortLabel);
    if (!name) {
      throw new Error("A short name needs 1 to 12 characters.");
    }
    const key = federationShortNameKey(name);
    for (const other of machines) {
      if (other === machine) continue;
      const shown = other.override ?? other.current ?? other.label;
      if (federationShortNameKey(shown) === key || federationShortNameKey(other.label) === key) {
        throw new Error(`${other.label} already uses that name.`);
      }
    }
    this.write(machine.instanceIds.map((id) => ({
      instanceId: id,
      shortLabel: name,
      basis: machine.label,
      source: "override" as const,
      updatedAt: this.nextUpdatedAt(map.get(id)),
    })));
    return this.entries();
  }

  /** Merge an authoritative response (the gateway's answer to a forwarded override). */
  adopt(entries: unknown): void {
    if (!Array.isArray(entries)) return;
    const merged = mergeFederationInstanceShortNames(
      this.entries(),
      entries.filter(isFederationInstanceShortName),
    );
    if (!merged.changed) return;
    this.replace(merged.entries);
    this.persist();
    this.deps.publishChanged();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
  }

  /** Re-arm after a runtime restart; keeps the loaded map. */
  revive(): void {
    this.disposed = false;
  }
}
