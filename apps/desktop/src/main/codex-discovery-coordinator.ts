import {
  CodexCliNotInstalledError,
  MINIMUM_CODEX_CLI_VERSION,
  discoverCodexCommands,
  type CodexDiscoverySnapshot,
  type ResolvedCodexCommandCandidate,
} from "@pwrdrvr/codex-discovery";

export const CODEX_DISCOVERY_SUCCESS_TTL_MS = 5 * 60_000;
export const CODEX_DISCOVERY_NOT_INSTALLED_TTL_MS = 15_000;
export const CODEX_DISCOVERY_FAILURE_TTL_MS = 5_000;
export const CODEX_DISCOVERY_STALE_SUCCESS_TTL_MS = 30 * 60_000;

type DiscoveryOutcome =
  | {
      kind: "snapshot";
      snapshot: CodexDiscoverySnapshot;
    }
  | {
      error: unknown;
      kind: "failure";
    };

type DiscoveryCacheEntry = {
  cachedAt: number;
  outcome: DiscoveryOutcome;
};

type InFlightDiscovery = {
  forced: boolean;
  promise: Promise<CodexDiscoverySnapshot>;
};

export type CodexDiscoveryCoordinatorOptions = {
  discover?: typeof discoverCodexCommands;
  failureTtlMs?: number;
  notInstalledTtlMs?: number;
  now?: () => number;
  resolveEnv: () => Promise<NodeJS.ProcessEnv>;
  staleSuccessTtlMs?: number;
  successTtlMs?: number;
};

export type CodexDiscoveryRequest = {
  allowStaleSuccess?: boolean;
  force?: boolean;
};

/**
 * Owns executable discovery for every desktop Codex consumer.
 *
 * Real probes always await the desktop's hydrated login-shell environment.
 * Settings may reuse a bounded stale success while another non-forced refresh
 * is already checking the filesystem; launches never do, so a reconnect waits
 * for the fresh result before spawning.
 */
export class CodexDiscoveryCoordinator {
  private readonly cache = new Map<string, DiscoveryCacheEntry>();
  private readonly discoverFn: typeof discoverCodexCommands;
  private readonly failureTtlMs: number;
  private readonly inFlight = new Map<string, InFlightDiscovery>();
  private readonly notInstalledTtlMs: number;
  private readonly now: () => number;
  private readonly staleSuccessTtlMs: number;
  private readonly successTtlMs: number;
  private generation = 0;

  constructor(private readonly options: CodexDiscoveryCoordinatorOptions) {
    this.discoverFn = options.discover ?? discoverCodexCommands;
    this.failureTtlMs =
      options.failureTtlMs ?? CODEX_DISCOVERY_FAILURE_TTL_MS;
    this.notInstalledTtlMs =
      options.notInstalledTtlMs ?? CODEX_DISCOVERY_NOT_INSTALLED_TTL_MS;
    this.now = options.now ?? Date.now;
    this.staleSuccessTtlMs =
      options.staleSuccessTtlMs ?? CODEX_DISCOVERY_STALE_SUCCESS_TTL_MS;
    this.successTtlMs =
      options.successTtlMs ?? CODEX_DISCOVERY_SUCCESS_TTL_MS;
  }

  invalidate(): void {
    this.generation += 1;
    this.cache.clear();
  }

  async discover(
    configuredCommand?: string,
    request: CodexDiscoveryRequest = {},
  ): Promise<CodexDiscoverySnapshot> {
    const key = configuredCommand?.trim() ?? "";
    const active = this.inFlight.get(key);

    if (request.force === true) {
      if (active?.forced) {
        return await active.promise;
      }
      this.invalidate();
      if (active) {
        try {
          await active.promise;
        } catch {
          // The forced probe below supersedes the earlier result.
        }
        return await this.discover(configuredCommand, request);
      }
      return await this.startProbe(key, configuredCommand, true);
    }

    const cached = this.cache.get(key);
    if (cached && this.isFresh(cached)) {
      return this.readOutcome(cached.outcome);
    }

    if (active) {
      if (
        request.allowStaleSuccess === true
        && cached
        && this.isSafeStaleSuccess(cached)
      ) {
        return cached.outcome.kind === "snapshot"
          ? cached.outcome.snapshot
          : await active.promise;
      }
      return await active.promise;
    }

    return await this.startProbe(key, configuredCommand, false);
  }

  async resolve(
    configuredCommand?: string,
    request: Omit<CodexDiscoveryRequest, "allowStaleSuccess"> = {},
  ): Promise<ResolvedCodexCommandCandidate> {
    const snapshot = await this.discover(configuredCommand, {
      ...request,
      allowStaleSuccess: false,
    });
    const selected = snapshot.candidates.find((candidate) => candidate.selected);
    if (selected) {
      return {
        command: selected.command,
        source: selected.source,
        version: selected.version,
      };
    }

    const rejectedOldCodex = snapshot.candidates.find(
      (candidate) => candidate.failureReason === "codex_too_old",
    );
    if (rejectedOldCodex) {
      throw new Error(
        `Codex CLI ${rejectedOldCodex.version ?? "unknown"} is older than `
        + `the minimum supported version ${MINIMUM_CODEX_CLI_VERSION}: `
        + rejectedOldCodex.command,
      );
    }
    throw new CodexCliNotInstalledError();
  }

  private isFresh(entry: DiscoveryCacheEntry): boolean {
    const age = this.now() - entry.cachedAt;
    if (entry.outcome.kind === "failure") {
      return age < this.failureTtlMs;
    }
    const ttlMs = entry.outcome.snapshot.selectedCommand
      ? this.successTtlMs
      : this.notInstalledTtlMs;
    return age < ttlMs;
  }

  private isSafeStaleSuccess(entry: DiscoveryCacheEntry): boolean {
    return (
      entry.outcome.kind === "snapshot"
      && Boolean(entry.outcome.snapshot.selectedCommand)
      && this.now() - entry.cachedAt < this.staleSuccessTtlMs
    );
  }

  private readOutcome(outcome: DiscoveryOutcome): CodexDiscoverySnapshot {
    if (outcome.kind === "failure") {
      throw outcome.error;
    }
    return outcome.snapshot;
  }

  private async startProbe(
    key: string,
    configuredCommand: string | undefined,
    forced: boolean,
  ): Promise<CodexDiscoverySnapshot> {
    const existing = this.inFlight.get(key);
    if (existing) {
      return await existing.promise;
    }

    const generation = this.generation;
    const promise = this.runProbe(configuredCommand, generation);
    const active: InFlightDiscovery = { forced, promise };
    this.inFlight.set(key, active);
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(key) === active) {
        this.inFlight.delete(key);
      }
    }
  }

  private async runProbe(
    configuredCommand: string | undefined,
    generation: number,
  ): Promise<CodexDiscoverySnapshot> {
    try {
      const env = await this.options.resolveEnv();
      const snapshot = await this.discoverFn({ configuredCommand, env });
      if (generation === this.generation) {
        this.cache.set(configuredCommand?.trim() ?? "", {
          cachedAt: this.now(),
          outcome: { kind: "snapshot", snapshot },
        });
      }
      return snapshot;
    } catch (error) {
      if (generation === this.generation) {
        this.cache.set(configuredCommand?.trim() ?? "", {
          cachedAt: this.now(),
          outcome: { error, kind: "failure" },
        });
      }
      throw error;
    }
  }
}
