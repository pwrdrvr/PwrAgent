import {
  CodexCliNotInstalledError,
  compareCodexCliVersions,
  MINIMUM_CODEX_CLI_VERSION,
  discoverCodexCommands,
  type CodexDiscoverySnapshot,
  type ResolvedCodexCommandCandidate,
} from "@pwrdrvr/codex-discovery";
import { discoverCodexPowerShellCandidates } from "./codex-powershell";

export const CODEX_DISCOVERY_SUCCESS_TTL_MS = 5 * 60_000;
export const CODEX_DISCOVERY_NOT_INSTALLED_TTL_MS = 15_000;
export const CODEX_DISCOVERY_FAILURE_TTL_MS = 5_000;
export const CODEX_DISCOVERY_STALE_SUCCESS_TTL_MS = 30 * 60_000;
export const CODEX_DISCOVERY_FORCE_REUSE_TTL_MS = 5_000;

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
  promise: Promise<CodexDiscoverySnapshot>;
};

export type CodexDiscoveryCoordinatorOptions = {
  discover?: typeof discoverCodexCommands;
  discoverPowerShell?: typeof discoverCodexPowerShellCandidates;
  failureTtlMs?: number;
  forceReuseTtlMs?: number;
  notInstalledTtlMs?: number;
  now?: () => number;
  platform?: NodeJS.Platform;
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
  private readonly forceReuseTtlMs: number;
  private readonly inFlight = new Map<string, InFlightDiscovery>();
  private readonly notInstalledTtlMs: number;
  private readonly now: () => number;
  private probeTail: Promise<void> = Promise.resolve();
  private readonly staleSuccessTtlMs: number;
  private readonly successTtlMs: number;
  private generation = 0;

  constructor(private readonly options: CodexDiscoveryCoordinatorOptions) {
    this.discoverFn = options.discover ?? discoverCodexCommands;
    this.failureTtlMs =
      options.failureTtlMs ?? CODEX_DISCOVERY_FAILURE_TTL_MS;
    this.forceReuseTtlMs =
      options.forceReuseTtlMs ?? CODEX_DISCOVERY_FORCE_REUSE_TTL_MS;
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
    const cached = this.cache.get(key);

    if (request.force === true) {
      // A force request means "do not trust an old cache entry", not "launch
      // another process even though this exact target just finished or is
      // already being checked". This closes the sequential half of a renderer
      // stampede: late arrivals reuse the same main-owned result for five
      // seconds instead of lining up another `codex --version` child.
      if (active) {
        return await active.promise;
      }
      if (cached && this.now() - cached.cachedAt < this.forceReuseTtlMs) {
        return this.readOutcome(cached.outcome);
      }
      this.invalidate();
      return await this.startProbe(key, configuredCommand);
    }

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

    return await this.startProbe(key, configuredCommand);
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
  ): Promise<CodexDiscoverySnapshot> {
    const existing = this.inFlight.get(key);
    if (existing) {
      return await existing.promise;
    }

    const generation = this.generation;
    const promise = this.probeTail.then(
      async () => await this.runProbe(configuredCommand, generation),
    );
    this.probeTail = promise.then(
      () => undefined,
      () => undefined,
    );
    const active: InFlightDiscovery = { promise };
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
      // @pwrdrvr/codex-discovery resolves PATHEXT shims itself. Do not turn
      // its Windows PATH result into a configured candidate first: fixed and
      // automatic candidates are probed separately inside the package, which
      // would execute the same codex.cmd twice before candidate deduplication.
      const discovered = await this.discoverFn({
        configuredCommand,
        env,
        ...(this.options.platform ? { platform: this.options.platform } : {}),
      });
      const platform = this.options.platform ?? process.platform;
      const powerShellCandidates = platform === "win32"
          ? await (
            this.options.discoverPowerShell ?? discoverCodexPowerShellCandidates
          )({
            configuredCommand,
            env,
            includePath: !discovered.selectedCommand,
          })
        : [];
      const snapshot = normalizeCodexDiscoverySnapshot({
        ...discovered,
        candidates: mergeCodexDiscoveryCandidates(
          discovered.candidates,
          powerShellCandidates,
          platform,
        ),
      });
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

function normalizeCodexDiscoverySnapshot(
  snapshot: CodexDiscoverySnapshot,
): CodexDiscoverySnapshot {
  const normalizedCandidates = snapshot.candidates.map((candidate) => {
    if (
      candidate.selected
      && (
        !candidate.version
        || Boolean(candidate.failureReason)
        || Boolean(candidate.versionFailureReason)
      )
    ) {
      return {
        ...candidate,
        executable: false,
        selected: false,
        failureReason:
          candidate.failureReason
          ?? candidate.versionFailureReason
          ?? "version_not_reported",
      };
    }
    return candidate;
  });
  const isValidated = (
    candidate: (typeof normalizedCandidates)[number],
  ): boolean =>
    candidate.executable
    && Boolean(candidate.version)
    && !candidate.failureReason
    && !candidate.versionFailureReason;
  const fixedIndex = normalizedCandidates.findIndex(
    (candidate) => candidate.source === "env" && isValidated(candidate),
  );
  const configuredIndex = normalizedCandidates.findIndex(
    (candidate) => candidate.source === "config" && isValidated(candidate),
  );
  const automaticIndex = normalizedCandidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(
      ({ candidate }) =>
        (candidate.source === "path" || candidate.source === "application")
        && isValidated(candidate),
    )
    .sort(
      (left, right) =>
        compareCodexCliVersions(
          right.candidate.version,
          left.candidate.version,
        ),
    )[0]?.index ?? -1;
  const fallbackIndex = fixedIndex >= 0
    ? fixedIndex
    : configuredIndex >= 0
      ? configuredIndex
      : automaticIndex;
  const candidates = normalizedCandidates.map((candidate, index) => {
    const selected = index === fallbackIndex;
    return candidate.selected === selected
      ? candidate
      : { ...candidate, selected };
  });
  const selected = fallbackIndex >= 0 ? candidates[fallbackIndex] : undefined;
  const {
    selectedCommand: _selectedCommand,
    selectedSource: _selectedSource,
    ...rest
  } = snapshot;
  return selected
    ? {
        ...rest,
        candidates,
        selectedCommand: selected.command,
        selectedSource: selected.source,
      }
    : { ...rest, candidates };
}

function mergeCodexDiscoveryCandidates(
  discovered: CodexDiscoverySnapshot["candidates"],
  additional: CodexDiscoverySnapshot["candidates"],
  platform: NodeJS.Platform,
): CodexDiscoverySnapshot["candidates"] {
  const merged = [...discovered];
  for (const candidate of additional) {
    const existingIndex = merged.findIndex((existing) =>
      platform === "win32"
        ? existing.command.toLowerCase() === candidate.command.toLowerCase()
        : existing.command === candidate.command,
    );
    if (existingIndex >= 0) {
      merged[existingIndex] = candidate;
    } else {
      merged.push(candidate);
    }
  }
  return merged;
}
