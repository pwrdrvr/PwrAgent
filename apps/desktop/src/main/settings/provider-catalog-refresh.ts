import type {
  ProviderCatalogRefreshProviderState,
  ProviderCatalogRefreshState,
  ProviderCatalogRefreshStepStatus,
} from "@pwragent/shared";

export type ProviderCatalogRefreshProviderUpdate = {
  status: ProviderCatalogRefreshStepStatus;
  detail?: string;
  modelCount?: number;
  error?: string;
};

/**
 * What a refresh pass reports through. Aborting `signal` is the operator's
 * Cancel: a pass stops at its next checkpoint and terminates any agent it is
 * still probing.
 */
export type ProviderCatalogRefreshProgress = {
  signal: AbortSignal;
  onPhase: (phase: string | undefined) => void;
  onProvider: (id: string, update: ProviderCatalogRefreshProviderUpdate) => void;
};

export type ProviderCatalogRefreshCodexProgress = {
  signal: AbortSignal;
  /** Codex is up; only its model and account reads remain. */
  onConnected: () => void;
};

export type ProviderCatalogRefreshCoordinatorOptions = {
  now?: () => number;
  publish: (state: ProviderCatalogRefreshState) => void;
  /** Enabled ACP providers, listed before discovery reports on any of them. */
  listAcpProviders: () => Array<{ id: string; label: string }>;
  refreshCodex: (
    progress: ProviderCatalogRefreshCodexProgress,
  ) => Promise<{ modelCount?: number }>;
  refreshAcp: (progress: ProviderCatalogRefreshProgress) => Promise<void>;
};

export const CODEX_PROVIDER_CATALOG_ID = "codex";
// Codex reports two stages so a hang reads as "Codex will not start" or "its
// model list is slow" rather than one line for both.
const CODEX_STARTING_STAGE = "Starting Codex";
const CODEX_READING_STAGE = "Reading models and account";

const TERMINAL_STATUSES: ReadonlySet<ProviderCatalogRefreshStepStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
]);

/**
 * Runs the Settings "Refresh all providers" action and owns its progress.
 *
 * Codex and the ACP providers refresh concurrently, so one slow provider no
 * longer holds the others' results back. The state lives here rather than in
 * the renderer so that leaving Settings mid-run, or opening it in another
 * window, shows the same run instead of an idle button over a pass that is
 * still launching agents.
 *
 * Cancel settles the run immediately. Work that cannot be interrupted (a
 * Codex app-server request, local CLI discovery) finishes in the background,
 * and every late report from it is dropped because the run is no longer
 * running.
 */
export class ProviderCatalogRefreshCoordinator {
  private readonly now: () => number;
  private state?: ProviderCatalogRefreshState;
  private controller?: AbortController;
  private runSequence = 0;
  private revision = 0;

  constructor(private readonly options: ProviderCatalogRefreshCoordinatorOptions) {
    this.now = options.now ?? Date.now;
  }

  read(): ProviderCatalogRefreshState | undefined {
    return this.state;
  }

  /** Start a run, or return the one already running. */
  start(): ProviderCatalogRefreshState {
    if (this.state?.status === "running") {
      return this.state;
    }
    const controller = new AbortController();
    const runId = ++this.runSequence;
    const startedAt = this.now();
    this.controller = controller;
    this.state = {
      runId,
      revision: this.revision,
      status: "running",
      startedAt,
      providers: [
        {
          id: CODEX_PROVIDER_CATALOG_ID,
          label: "Codex",
          status: "running",
          detail: CODEX_STARTING_STAGE,
          startedAt,
        },
        ...this.options.listAcpProviders().map(
          (provider): ProviderCatalogRefreshProviderState => ({
            ...provider,
            status: "pending",
          }),
        ),
      ],
    };
    this.publish();
    void this.run(runId, controller.signal);
    return this.state;
  }

  cancel(runId: number): ProviderCatalogRefreshState | undefined {
    if (this.state?.runId === runId && this.state.status === "running") {
      this.controller?.abort();
      this.finish(runId, "cancelled");
    }
    return this.state;
  }

  dispose(): void {
    if (this.state?.status === "running") {
      this.cancel(this.state.runId);
    }
  }

  private async run(runId: number, signal: AbortSignal): Promise<void> {
    await Promise.all([
      this.runCodex(runId, signal),
      this.runAcp(runId, signal),
    ]);
    this.finish(runId, "completed");
  }

  private async runCodex(runId: number, signal: AbortSignal): Promise<void> {
    try {
      const result = await untilAborted(
        this.options.refreshCodex({
          signal,
          onConnected: () =>
            this.updateProvider(runId, CODEX_PROVIDER_CATALOG_ID, {
              status: "running",
              detail: CODEX_READING_STAGE,
            }),
        }),
        signal,
      );
      this.updateProvider(runId, CODEX_PROVIDER_CATALOG_ID, {
        status: "succeeded",
        ...(result.modelCount !== undefined
          ? { modelCount: result.modelCount }
          : {}),
      });
    } catch (error) {
      this.updateProvider(runId, CODEX_PROVIDER_CATALOG_ID, {
        status: "failed",
        error: errorMessage(error),
      });
    }
  }

  private async runAcp(runId: number, signal: AbortSignal): Promise<void> {
    try {
      await untilAborted(
        this.options.refreshAcp({
          signal,
          onPhase: (phase) => this.setPhase(runId, phase),
          onProvider: (id, update) => this.updateProvider(runId, id, update),
        }),
        signal,
      );
    } catch (error) {
      // The shared discovery step failed, so no provider waiting on it got
      // an answer.
      const message = errorMessage(error);
      for (const provider of this.state?.providers ?? []) {
        if (
          provider.id !== CODEX_PROVIDER_CATALOG_ID
          && !TERMINAL_STATUSES.has(provider.status)
        ) {
          this.updateProvider(runId, provider.id, {
            status: "failed",
            error: message,
          });
        }
      }
    }
  }

  private setPhase(runId: number, phase: string | undefined): void {
    const state = this.runningState(runId);
    if (!state || state.phase === phase) {
      return;
    }
    const { phase: _previous, ...rest } = state;
    this.state = phase ? { ...rest, phase } : rest;
    this.publish();
  }

  private updateProvider(
    runId: number,
    id: string,
    update: ProviderCatalogRefreshProviderUpdate,
  ): void {
    const state = this.runningState(runId);
    if (!state) {
      return;
    }
    const now = this.now();
    let changed = false;
    const providers = state.providers.map((provider) => {
      if (provider.id !== id || TERMINAL_STATUSES.has(provider.status)) {
        return provider;
      }
      changed = true;
      const terminal = TERMINAL_STATUSES.has(update.status);
      const {
        detail: _detail,
        modelCount: _modelCount,
        error: _error,
        ...base
      } = provider;
      return {
        ...base,
        status: update.status,
        ...(update.detail !== undefined ? { detail: update.detail } : {}),
        ...(update.modelCount !== undefined
          ? { modelCount: update.modelCount }
          : {}),
        ...(update.error !== undefined ? { error: update.error } : {}),
        ...(provider.startedAt === undefined && update.status !== "pending"
          ? { startedAt: now }
          : {}),
        ...(terminal ? { finishedAt: now } : {}),
      };
    });
    if (!changed) {
      return;
    }
    this.state = { ...state, providers };
    this.publish();
  }

  private finish(
    runId: number,
    status: "completed" | "cancelled",
  ): void {
    const state = this.runningState(runId);
    if (!state) {
      return;
    }
    const finishedAt = this.now();
    const { phase: _phase, ...rest } = state;
    this.state = {
      ...rest,
      status,
      finishedAt,
      providers: state.providers.map((provider) =>
        TERMINAL_STATUSES.has(provider.status)
          ? provider
          : {
              id: provider.id,
              label: provider.label,
              status: status === "cancelled" ? "cancelled" : "skipped",
              ...(provider.startedAt !== undefined
                ? { startedAt: provider.startedAt }
                : {}),
              finishedAt,
            },
      ),
    };
    this.controller = undefined;
    this.publish();
  }

  private runningState(runId: number): ProviderCatalogRefreshState | undefined {
    return this.state?.runId === runId && this.state.status === "running"
      ? this.state
      : undefined;
  }

  private publish(): void {
    if (this.state) {
      this.revision += 1;
      this.state = { ...this.state, revision: this.revision };
      this.options.publish(this.state);
    }
  }
}

/** Settle when `promise` does, or reject as soon as `signal` aborts. */
async function untilAborted<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  // The abandoned promise may still reject after a cancel; nobody awaits it.
  promise.catch(() => undefined);
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
