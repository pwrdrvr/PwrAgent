import path from "node:path";
import {
  CodexCliNotInstalledError,
  compareCodexCliVersions,
  MINIMUM_CODEX_CLI_VERSION,
  discoverCodexCommands,
  type CodexDiscoverySnapshot,
  type ResolvedCodexCommandCandidate,
} from "@pwrdrvr/codex-discovery";
import {
  discoverWindowsCodexCandidates,
  isValidatedCandidate,
} from "./codex-windows-launch";
import {
  CODEX_VERSION_PROBE_TIMEOUT_MS,
  probeCodexVersion,
} from "./codex-version-probe";

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
  discoverWindows?: typeof discoverWindowsCodexCandidates;
  failureTtlMs?: number;
  forceReuseTtlMs?: number;
  notInstalledTtlMs?: number;
  now?: () => number;
  platform?: NodeJS.Platform;
  /** Test seam for the desktop-owned `--version` re-probe. */
  probeVersion?: typeof probeCodexVersion;
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

  /**
   * Give a command that failed only its `--version` probe one more chance,
   * on a desktop-owned budget, before we report Codex as missing.
   *
   * `@pwrdrvr/codex-discovery` probes with a hard 2s timeout on every
   * platform. A timed-out probe is not surfaced as "slow" — it yields a
   * candidate with no version, which `normalizeCodexDiscoverySnapshot`
   * demotes (a version is required for protocol-compatibility gating), so
   * the snapshot reads exactly like "no Codex installed" and `resolve()`
   * throws `CodexCliNotInstalledError`. Nothing else retries: the app then
   * sits with Codex reported missing until the operator forces a refresh
   * from Settings.
   *
   * That is not hypothetical on a Windows shim chain (`cmd.exe -> node ->
   * codex.cmd` measures ~1.5s warm on the lab guest, against a 2s ceiling),
   * and it is not Windows-specific — the timeout is unconditional.
   * `e2e/codex-slow-version-probe.spec.ts` pins the behavior on any platform.
   *
   * "Reported missing" is the visible half on a machine with nothing else
   * installed. The quieter half shows up when there IS something else: the
   * timed-out command is demoted, and selection falls through to a
   * lower-priority candidate — so an operator's explicitly configured
   * `[models.codex] path` is silently replaced by whatever Codex happens to
   * be on the machine. Both are the same event, so the rule is keyed on
   * PRIORITY rather than on "nothing was selected":
   *
   * - A candidate is re-probed only if no candidate of equal or higher
   *   priority already validated (env > config > automatic, matching
   *   `normalizeCodexDiscoverySnapshot`). A healthy scan therefore
   *   re-probes nothing, which is what keeps
   *   `windows-codex-discovery.spec.ts`'s "exactly one version probe"
   *   assertion — and #1720's coalescing — true.
   * - Only candidates whose version could not be READ are eligible. A
   *   command that is absent (`not_found`), genuinely too old
   *   (`codex_too_old`), or a `.ps1` we refuse to launch is a settled
   *   answer and is left alone.
   * - One extra probe per eligible candidate, never a loop.
   *
   * The cost lands only on the path that was about to get the answer wrong.
   */
  private async reprobeUnreadVersions(
    snapshot: CodexDiscoverySnapshot,
    context: { env: NodeJS.ProcessEnv; platform: NodeJS.Platform },
  ): Promise<CodexDiscoverySnapshot> {
    const bestValidatedRank = snapshot.candidates.reduce(
      (best, candidate) =>
        isValidatedCandidate(candidate)
          ? Math.min(best, codexCandidateRank(candidate))
          : best,
      Number.POSITIVE_INFINITY,
    );
    const eligible = snapshot.candidates.filter(
      (candidate) =>
        isUnreadVersionCandidate(candidate)
        && codexCandidateRank(candidate) < bestValidatedRank,
    );
    if (eligible.length === 0) {
      return snapshot;
    }

    const probe = this.options.probeVersion ?? probeCodexVersion;
    const reprobed = new Map<
      string,
      CodexDiscoverySnapshot["candidates"][number]
    >();
    await Promise.all(
      eligible.map(async (candidate) => {
        const result = await probe({
          command: candidate.command,
          env: context.env,
          platform: context.platform,
          timeoutMs: CODEX_VERSION_PROBE_TIMEOUT_MS,
        });
        if (!result.version) {
          return;
        }
        const tooOld =
          compareCodexCliVersions(result.version, MINIMUM_CODEX_CLI_VERSION) < 0;
        reprobed.set(candidate.command, {
          command: candidate.command,
          source: candidate.source,
          executable: !tooOld,
          selected: false,
          version: result.version,
          ...(tooOld ? { failureReason: "codex_too_old" } : {}),
        });
      }),
    );
    if (reprobed.size === 0) {
      return snapshot;
    }
    return normalizeCodexDiscoverySnapshot({
      ...snapshot,
      candidates: snapshot.candidates.map(
        (candidate) => reprobed.get(candidate.command) ?? candidate,
      ),
    });
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
      const windowsCandidates = platform === "win32"
        ? await (
          this.options.discoverWindows ?? discoverWindowsCodexCandidates
        )({
          candidates: discovered.candidates,
          configuredCommand,
          env,
        })
        : [];
      const snapshot = await this.reprobeUnreadVersions(
        normalizeCodexDiscoverySnapshot({
          ...discovered,
          candidates: mergeCodexDiscoveryCandidates(
            discovered.candidates,
            windowsCandidates,
            platform,
          ),
        }),
        { env, platform },
      );
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

/**
 * Failure reasons that are a settled answer about a command, not a probe
 * that failed to get one. Re-probing these would only spawn a process to
 * learn what we already know.
 */
const SETTLED_CODEX_FAILURE_REASONS = new Set([
  "codex_too_old",
  "not_executable",
  "not_found",
  "powershell_shim_unsupported",
]);

/**
 * Selection priority, matching the fallback order
 * `normalizeCodexDiscoverySnapshot` applies: a fixed `PWRDRVR_CODEX_COMMAND`
 * beats a configured `[models.codex] path`, which beats anything found on
 * PATH or in a known install location. Lower is preferred.
 */
function codexCandidateRank(
  candidate: CodexDiscoverySnapshot["candidates"][number],
): number {
  switch (candidate.source) {
    case "env":
      return 0;
    case "config":
      return 1;
    default:
      return 2;
  }
}

/**
 * Whether this candidate's version is unknown *because the probe did not
 * report one* — a timeout, a killed child, an unparseable answer — rather
 * than because the command itself is unusable.
 *
 * `version_probe_timed_out` (from `classifyProbeFailure`) is the explicit
 * form of exactly the case this exists for, and is deliberately absent from
 * the settled set. The shared upstream probe reports its own timeout as a raw
 * `execFile` message instead, which lands here the same way: unrecognized
 * means unsettled.
 */
function isUnreadVersionCandidate(
  candidate: CodexDiscoverySnapshot["candidates"][number],
): boolean {
  if (candidate.version) {
    return false;
  }
  const reason = candidate.failureReason ?? candidate.versionFailureReason;
  return reason === undefined || !SETTLED_CODEX_FAILURE_REASONS.has(reason);
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
  const fixedIndex = normalizedCandidates.findIndex(
    (candidate) => candidate.source === "env" && isValidatedCandidate(candidate),
  );
  const configuredIndex = normalizedCandidates.findIndex(
    (candidate) => candidate.source === "config" && isValidatedCandidate(candidate),
  );
  const automaticIndex = normalizedCandidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(
      ({ candidate }) =>
        (candidate.source === "path" || candidate.source === "application")
        && isValidatedCandidate(candidate),
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
  if (platform !== "win32") {
    return merged;
  }
  // npm writes `codex`, `codex.cmd`, and `codex.ps1` side by side. Once one
  // of them validates, its unusable twins are noise on the Settings screen
  // and would only invite the operator to select a broken launch path.
  //
  // Scoped to automatic sources on purpose. A candidate the operator set
  // explicitly must keep its row even when a sibling validates: dropping it
  // hides both the fact that their path was rejected and the reason, and
  // leaves `configuredIndex` with nothing to select while the app quietly
  // launches a different binary.
  const validatedBases = new Set(
    merged
      .filter(isValidatedCandidate)
      .map((candidate) => stripExtension(candidate.command)),
  );
  return merged.filter(
    (candidate) =>
      isValidatedCandidate(candidate)
      || candidate.source === "env"
      || candidate.source === "config"
      || !validatedBases.has(stripExtension(candidate.command)),
  );
}

function stripExtension(command: string): string {
  const normalized = path.win32.normalize(command.trim()).toLowerCase();
  const extension = path.win32.extname(normalized);
  return extension
    ? normalized.slice(0, normalized.length - extension.length)
    : normalized;
}
