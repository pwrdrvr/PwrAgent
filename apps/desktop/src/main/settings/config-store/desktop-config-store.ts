import type { DesktopSettingsSecretName } from "@pwragent/shared";
import type { StateDb } from "../../state/state-db";
import {
  watchConfigFile,
  type ConfigFileWatcher,
  type ConfigFileWatcherFactory,
} from "./config-file-watcher";
import {
  CONFIG_STORE_DURABLE_SCHEMA_VERSION,
  PROVIDER_IDS,
  deepFreeze,
  normalizeConfigDomains,
  type ConfigDomainMap,
  type ConfigFileStatus,
  type ConfigStoreSnapshot,
  type ProviderId,
  type ProviderProjection,
  type SecretPresence,
} from "./config-domains";
import { DurableConfigSnapshotStore } from "./durable-config-snapshot";
import {
  ProviderRefreshCoordinator,
  type ProviderDiscoveryResult,
  type ProviderDiscoverer,
  type ProviderRefreshReason,
} from "./provider-refresh";
import { readRawConfigFile } from "./raw-config-file";

export type ConfigDomainChange<K extends keyof ConfigDomainMap> = Readonly<{
  version: number;
  changedDomains: readonly K[];
  values: Readonly<Pick<ConfigDomainMap, K>>;
}>;

export type ConfigStoreDiagnosticEvent = Readonly<{
  operation:
    | "config-parse"
    | "durable-read"
    | "durable-write"
    | "provider-refresh"
    | "watch-event";
  durationMs: number;
  outcome: "success" | "failure" | "reused" | "unchanged";
  detail?: Readonly<Record<string, string | number | boolean>>;
}>;

export type ConfigStoreDiagnosticsSnapshot = Readonly<{
  events: number;
  byOperation: Readonly<Record<ConfigStoreDiagnosticEvent["operation"], number>>;
}>;

type Subscription = Readonly<{
  domains: ReadonlySet<keyof ConfigDomainMap>;
  listener: (event: ConfigDomainChange<keyof ConfigDomainMap>) => void;
}>;

export class DesktopConfigStore {
  private snapshot: ConfigStoreSnapshot;
  private readonly durable: DurableConfigSnapshotStore;
  private readonly now: () => number;
  private readonly subscriptions = new Set<Subscription>();
  private diagnosticEventCount = 0;
  private readonly diagnosticOperationCounts: Record<
    ConfigStoreDiagnosticEvent["operation"],
    number
  > = {
    "config-parse": 0,
    "durable-read": 0,
    "durable-write": 0,
    "provider-refresh": 0,
    "watch-event": 0,
  };
  private watcher?: ConfigFileWatcher;
  private readonly providerRefresh?: ProviderRefreshCoordinator;
  private durableConfigRevision?: string;
  private readonly durableProviderIdentities = new Map<ProviderId, string>();

  constructor(private readonly options: {
    configPath: string;
    createFileWatcher?: ConfigFileWatcherFactory;
    stateDb: StateDb;
    discoverProvider?: ProviderDiscoverer;
    now?: () => number;
    onDiagnostic?: (event: ConfigStoreDiagnosticEvent) => void;
    readSecretPresence?: () => Partial<
      Record<DesktopSettingsSecretName, SecretPresence>
    >;
  }) {
    this.now = options.now ?? Date.now;
    this.durable = new DurableConfigSnapshotStore(options.stateDb);

    const durableStartedAt = this.now();
    const durableConfig = this.durable.readConfig();
    this.durableConfigRevision = durableConfig?.configRevision;
    const durableProviders = this.durable.readProviders();
    for (const provider of PROVIDER_IDS) {
      const projection = durableProviders[provider];
      if (projection) {
        this.durableProviderIdentities.set(
          provider,
          providerDurableIdentity(projection),
        );
      }
    }
    this.recordDiagnostic({
      operation: "durable-read",
      durationMs: this.now() - durableStartedAt,
      outcome: "success",
      detail: {
        configFound: Boolean(durableConfig),
        providersFound: Object.keys(durableProviders).length,
      },
    });
    const previousProviders = mergeDurableProviders(
      durableConfig?.domains.providers,
      durableProviders,
    );
    const defaults = normalizeConfigDomains({
      config: {},
      previousProviders,
    });
    this.snapshot = deepFreeze({
      version: 0,
      durableSchemaVersion: CONFIG_STORE_DURABLE_SCHEMA_VERSION,
      configFile: { kind: "missing", observedAt: this.now() },
      configRevision: durableConfig?.configRevision ?? "defaults",
      domains: durableConfig?.domains ?? defaults,
      secretPresence: options.readSecretPresence?.() ?? {},
    });
    this.reloadFromDisk("startup");

    if (options.discoverProvider) {
      this.providerRefresh = new ProviderRefreshCoordinator({
        discover: options.discoverProvider,
        now: this.now,
        read: (provider) => this.snapshot.domains.providers[provider],
        publish: (projection) => this.publishProvider(projection),
        onComplete: ({ durationMs, outcome, provider }) => {
          this.recordDiagnostic({
            operation: "provider-refresh",
            durationMs,
            outcome,
            detail: { provider },
          });
        },
      });
    }
  }

  read<K extends keyof ConfigDomainMap>(domain: K): ConfigDomainMap[K] {
    return this.snapshot.domains[domain];
  }

  version(): number {
    return this.snapshot.version;
  }

  fileStatus(): ConfigFileStatus {
    return this.snapshot.configFile;
  }

  configRevision(): string {
    return this.snapshot.configRevision;
  }

  readDiagnostics(): ConfigStoreDiagnosticsSnapshot {
    return deepFreeze({
      events: this.diagnosticEventCount,
      byOperation: { ...this.diagnosticOperationCounts },
    });
  }

  subscribe<K extends keyof ConfigDomainMap>(
    domains: readonly K[],
    listener: (event: ConfigDomainChange<K>) => void,
  ): () => void {
    const subscription: Subscription = {
      domains: new Set(domains),
      listener: listener as unknown as Subscription["listener"],
    };
    this.subscriptions.add(subscription);
    return () => {
      this.subscriptions.delete(subscription);
    };
  }

  reloadFromDisk(reason: "startup" | "self-write" | "watch"): void {
    const startedAt = this.now();
    const observation = readRawConfigFile(this.options.configPath, {
      now: this.now,
    });
    const unchanged = observation.kind === "missing"
      ? this.snapshot.configFile.kind === "missing"
      : observation.kind === "valid"
        && this.snapshot.configFile.kind === "valid"
        && observation.contentHash === this.snapshot.configFile.contentHash;
    if (
      reason !== "startup"
      && observation.kind !== "invalid"
      && unchanged
    ) {
      this.recordDiagnostic({
        operation: "config-parse",
        durationMs: this.now() - startedAt,
        outcome: "unchanged",
        detail: { reason },
      });
      return;
    }

    if (observation.kind === "valid") {
      const previousProviders = this.snapshot.domains.providers;
      const domains = normalizeConfigDomains({
        config: observation.config,
        previousProviders,
      });
      const next = this.publish({
        configFile: {
          kind: "valid",
          contentHash: observation.contentHash,
          observedAt: observation.observedAt,
        },
        configRevision: observation.contentHash,
        domains,
      });
      if (next.configRevision !== this.durableConfigRevision) {
        const durableStartedAt = this.now();
        this.durable.writeConfig({
          configRevision: next.configRevision,
          contentHash: observation.contentHash,
          domains: next.domains,
          schemaVersion: CONFIG_STORE_DURABLE_SCHEMA_VERSION,
          updatedAt: observation.observedAt,
        });
        this.durableConfigRevision = next.configRevision;
        this.recordDiagnostic({
          operation: "durable-write",
          durationMs: this.now() - durableStartedAt,
          outcome: "success",
          detail: { kind: "config" },
        });
      }
      this.recordDiagnostic({
        operation: "config-parse",
        durationMs: this.now() - startedAt,
        outcome: "success",
        detail: { reason },
      });
      if (reason !== "startup") {
        for (const provider of PROVIDER_IDS) {
          if (
            domains.providers[provider].configured.enabled
            && domains.providers[provider].dependencyFingerprint
              !== previousProviders[provider].dependencyFingerprint
          ) {
            void this.refreshProvider(provider, "config-change");
          }
        }
      }
      return;
    }

    if (observation.kind === "missing") {
      const domains = normalizeConfigDomains({
        config: {},
        previousProviders: this.snapshot.domains.providers,
      });
      this.publish({
        configFile: {
          kind: "missing",
          observedAt: observation.observedAt,
        },
        configRevision: "missing",
        domains,
      });
      this.recordDiagnostic({
        operation: "config-parse",
        durationMs: this.now() - startedAt,
        outcome: "success",
        detail: { reason },
      });
      return;
    }

    const serving = this.snapshot.version > 0
      || this.snapshot.configRevision !== "defaults"
      ? "last-known-good"
      : "defaults";
    this.publish({
      configFile: {
        kind: "invalid",
        contentHash: observation.contentHash,
        error: observation.error,
        observedAt: observation.observedAt,
        serving,
      },
      configRevision: this.snapshot.configRevision,
      domains: this.snapshot.domains,
    });
    this.recordDiagnostic({
      operation: "config-parse",
      durationMs: this.now() - startedAt,
      outcome: "failure",
      detail: { reason },
    });
  }

  startWatching(): void {
    if (this.watcher) {
      return;
    }
    this.watcher = (this.options.createFileWatcher ?? watchConfigFile)({
      configPath: this.options.configPath,
      onChange: () => {
        this.recordDiagnostic({
          operation: "watch-event",
          durationMs: 0,
          outcome: "success",
        });
        this.reloadFromDisk("watch");
      },
    });
  }

  async refreshProvider(
    provider: ProviderId,
    reason: ProviderRefreshReason,
  ): Promise<ProviderProjection> {
    if (!this.providerRefresh) {
      return this.snapshot.domains.providers[provider];
    }
    return await this.providerRefresh.refresh(provider, reason);
  }

  recordProviderDiscovery(
    provider: ProviderId,
    observation: ProviderDiscoveryResult & { error?: string },
  ): ProviderProjection {
    const current = this.snapshot.domains.providers[provider];
    const observedAt = this.now();
    const projection: ProviderProjection = observation.error
      ? {
          ...current,
          validation: {
            state: "failed",
            lastAttemptAt: observedAt,
            error: observation.error,
          },
        }
      : {
          ...current,
          lastKnownGood: {
            candidates: observation.candidates,
            ...(observation.executableIdentity
              ? { executableIdentity: observation.executableIdentity }
              : {}),
            ...(observation.selectedCommand
              ? { selectedCommand: observation.selectedCommand }
              : {}),
            ...(observation.selectedVersion
              ? { selectedVersion: observation.selectedVersion }
              : {}),
            validatedAt: observedAt,
          },
          validation: {
            state: "valid",
            lastAttemptAt: observedAt,
          },
        };
    this.publishProvider(projection);
    return this.snapshot.domains.providers[provider];
  }

  dispose(): void {
    this.watcher?.close();
    this.watcher = undefined;
    this.providerRefresh?.dispose();
    this.subscriptions.clear();
  }

  private publish(params: {
    configFile: ConfigFileStatus;
    configRevision: string;
    domains: ConfigDomainMap;
  }): ConfigStoreSnapshot {
    const previous = this.snapshot;
    const changedDomains = changedConfigDomains(previous.domains, params.domains);
    const next = deepFreeze({
      version: previous.version + 1,
      durableSchemaVersion: CONFIG_STORE_DURABLE_SCHEMA_VERSION,
      configFile: params.configFile,
      configRevision: params.configRevision,
      domains: params.domains,
      secretPresence: previous.secretPresence,
    });
    this.snapshot = next;
    this.notify(changedDomains, next);
    return next;
  }

  private publishProvider(projection: ProviderProjection): void {
    const current = this.snapshot.domains.providers[projection.provider];
    if (current.dependencyFingerprint !== projection.dependencyFingerprint) {
      return;
    }
    const providers = deepFreeze({
      ...this.snapshot.domains.providers,
      [projection.provider]: deepFreeze(projection),
    });
    this.publish({
      configFile: this.snapshot.configFile,
      configRevision: this.snapshot.configRevision,
      domains: deepFreeze({
        ...this.snapshot.domains,
        providers,
      }),
    });
    if (projection.validation.state === "valid" && projection.lastKnownGood) {
      const durableIdentity = providerDurableIdentity(projection);
      if (
        this.durableProviderIdentities.get(projection.provider)
        === durableIdentity
      ) {
        return;
      }
      const startedAt = this.now();
      this.durable.writeProvider(projection);
      this.durableProviderIdentities.set(projection.provider, durableIdentity);
      this.recordDiagnostic({
        operation: "durable-write",
        durationMs: this.now() - startedAt,
        outcome: "success",
        detail: { kind: "provider", provider: projection.provider },
      });
    }
  }

  private notify(
    changedDomains: readonly (keyof ConfigDomainMap)[],
    snapshot: ConfigStoreSnapshot,
  ): void {
    if (changedDomains.length === 0) {
      return;
    }
    for (const subscription of this.subscriptions) {
      const relevant = changedDomains.filter((domain) =>
        subscription.domains.has(domain),
      );
      if (relevant.length === 0) {
        continue;
      }
      const values = Object.fromEntries(
        relevant.map((domain) => [domain, snapshot.domains[domain]]),
      ) as Pick<ConfigDomainMap, keyof ConfigDomainMap>;
      subscription.listener({
        version: snapshot.version,
        changedDomains: relevant,
        values,
      });
    }
  }

  private recordDiagnostic(event: ConfigStoreDiagnosticEvent): void {
    this.diagnosticEventCount += 1;
    this.diagnosticOperationCounts[event.operation] += 1;
    this.options.onDiagnostic?.(event);
  }
}

function providerDurableIdentity(projection: ProviderProjection): string {
  if (!projection.lastKnownGood) {
    return `${projection.dependencyFingerprint}:none`;
  }
  const {
    validatedAt: _validatedAt,
    ...discovery
  } = projection.lastKnownGood;
  return JSON.stringify({
    dependencyFingerprint: projection.dependencyFingerprint,
    discovery,
  });
}

function changedConfigDomains(
  previous: ConfigDomainMap,
  next: ConfigDomainMap,
): Array<keyof ConfigDomainMap> {
  return (Object.keys(next) as Array<keyof ConfigDomainMap>).filter(
    (domain) => JSON.stringify(previous[domain]) !== JSON.stringify(next[domain]),
  );
}

function mergeDurableProviders(
  configProviders: Readonly<Record<ProviderId, ProviderProjection>> | undefined,
  providerRows: Partial<Record<ProviderId, ProviderProjection>>,
): Readonly<Record<ProviderId, ProviderProjection>> | undefined {
  if (!configProviders && Object.keys(providerRows).length === 0) {
    return undefined;
  }
  return Object.fromEntries(
    PROVIDER_IDS.map((provider) => [
      provider,
      providerRows[provider] ?? configProviders?.[provider],
    ]).filter((entry): entry is [ProviderId, ProviderProjection] => Boolean(entry[1])),
  ) as Record<ProviderId, ProviderProjection>;
}
