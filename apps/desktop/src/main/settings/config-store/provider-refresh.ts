import type {
  ProviderId,
  ProviderCandidateSummary,
  ProviderProjection,
} from "./config-domains";
import type { ProviderDiscoveryIntent } from "../provider-discovery-permit";

export type ProviderRefreshReason = ProviderDiscoveryIntent;

export type ProviderDiscoveryResult = Readonly<{
  selectedCommand?: string;
  selectedVersion?: string;
  candidates: readonly ProviderCandidateSummary[];
  executableIdentity?: Readonly<{
    realpath: string;
    size: number;
    mtimeMs: number;
  }>;
}>;

export type ProviderDiscoverer = (params: {
  provider: ProviderId;
  projection: ProviderProjection;
  reason: ProviderRefreshReason;
  signal: AbortSignal;
}) => Promise<ProviderDiscoveryResult>;

export class ProviderRefreshCoordinator {
  private readonly inFlight = new Map<string, {
    controller: AbortController;
    promise: Promise<ProviderProjection>;
  }>();
  private disposed = false;

  constructor(private readonly options: {
    discover: ProviderDiscoverer;
    now?: () => number;
    onComplete?: (params: {
      durationMs: number;
      outcome: "failure" | "reused" | "success";
      provider: ProviderId;
    }) => void;
    publish: (projection: ProviderProjection) => void;
    read: (provider: ProviderId) => ProviderProjection;
  }) {}

  refresh(
    provider: ProviderId,
    reason: ProviderRefreshReason,
  ): Promise<ProviderProjection> {
    if (this.disposed) {
      return Promise.resolve(this.options.read(provider));
    }
    const current = this.options.read(provider);
    const key = `${provider}:${current.dependencyFingerprint}`;
    const existing = this.inFlight.get(key);
    if (existing) {
      this.options.onComplete?.({
        durationMs: 0,
        outcome: "reused",
        provider,
      });
      return existing.promise;
    }

    const startedAt = (this.options.now ?? Date.now)();
    const controller = new AbortController();
    this.options.publish({
      ...current,
      validation: {
        ...current.validation,
        state: "checking",
        lastAttemptAt: startedAt,
        error: undefined,
      },
    });
    const promise = this.options.discover({
      provider,
      projection: current,
      reason,
      signal: controller.signal,
    }).then((result) => {
      const latest = this.options.read(provider);
      if (
        this.disposed
        || latest.dependencyFingerprint !== current.dependencyFingerprint
      ) {
        return latest;
      }
      const projection: ProviderProjection = {
        ...latest,
        lastKnownGood: {
          ...result,
          validatedAt: (this.options.now ?? Date.now)(),
        },
        validation: {
          state: "valid",
          lastAttemptAt: startedAt,
        },
      };
      this.options.publish(projection);
      this.options.onComplete?.({
        durationMs: (this.options.now ?? Date.now)() - startedAt,
        outcome: "success",
        provider,
      });
      return projection;
    }).catch((error) => {
      const latest = this.options.read(provider);
      if (
        this.disposed
        || latest.dependencyFingerprint !== current.dependencyFingerprint
      ) {
        return latest;
      }
      const projection: ProviderProjection = {
        ...latest,
        validation: {
          state: "failed",
          lastAttemptAt: startedAt,
          error: error instanceof Error ? error.message : String(error),
        },
      };
      this.options.publish(projection);
      this.options.onComplete?.({
        durationMs: (this.options.now ?? Date.now)() - startedAt,
        outcome: "failure",
        provider,
      });
      return projection;
    }).finally(() => {
      if (this.inFlight.get(key)?.promise === promise) {
        this.inFlight.delete(key);
      }
    });
    this.inFlight.set(key, { controller, promise });
    return promise;
  }

  dispose(): void {
    this.disposed = true;
    for (const refresh of this.inFlight.values()) {
      refresh.controller.abort();
    }
    this.inFlight.clear();
  }
}
