import type { ThreadOverlayState } from "@pwragent/shared";

type Runtime = NonNullable<ThreadOverlayState["codexEnvironmentRuntime"]>;

/**
 * Live output of running environment actions, held in memory only.
 *
 * A detached action reports a fresh output snapshot every 500 ms while it
 * prints. Persisting each one rewrote the whole `threads.payload` row, so a
 * chatty dev server wrote WAL continuously. The tail is persisted at the run's
 * boundaries instead: exit, stop, failure and app shutdown. Any other write of
 * the thread's row also carries the current tail, since setters build their
 * row from a read that merges this layer.
 *
 * A live entry applies only while the stored run is still `started`. Once a
 * boundary write records the run as finished, the stored output wins and the
 * entry is pruned.
 */
export class CodexEnvironmentLiveOutput {
  private readonly outputByThreadKey = new Map<string, Map<string, string>>();

  set(threadKey: string, runId: string, output: string): void {
    let runs = this.outputByThreadKey.get(threadKey);
    if (!runs) {
      runs = new Map();
      this.outputByThreadKey.set(threadKey, runs);
    }
    runs.set(runId, output);
  }

  drop(threadKey: string, runId: string): void {
    const runs = this.outputByThreadKey.get(threadKey);
    if (!runs) return;
    runs.delete(runId);
    if (runs.size === 0) this.outputByThreadKey.delete(threadKey);
  }

  threadKeys(): string[] {
    return [...this.outputByThreadKey.keys()];
  }

  clear(): void {
    this.outputByThreadKey.clear();
  }

  /** Returns the same object when no live output applies. */
  apply<T extends ThreadOverlayState | undefined>(threadKey: string, overlay: T): T {
    const runs = this.outputByThreadKey.get(threadKey);
    const runtime = overlay?.codexEnvironmentRuntime;
    if (!runs || !runtime) return overlay;
    const merged = applyToRuntime(runtime, runs);
    return merged === runtime ? overlay : { ...overlay, codexEnvironmentRuntime: merged };
  }

  /** Forget entries for runs the stored runtime no longer shows as running. */
  prune(threadKey: string, runtime: ThreadOverlayState["codexEnvironmentRuntime"]): void {
    const runs = this.outputByThreadKey.get(threadKey);
    if (!runs) return;
    const running = new Set((runtime?.actionRuns ?? [])
      .filter((run) => run.status === "started")
      .map((run) => run.runId));
    for (const runId of runs.keys()) {
      if (!running.has(runId)) runs.delete(runId);
    }
    if (runs.size === 0) this.outputByThreadKey.delete(threadKey);
  }
}

function applyToRuntime(runtime: Runtime, outputByRunId: Map<string, string>): Runtime {
  let changed = false;
  const actionRuns = runtime.actionRuns?.map((run) => {
    const output = outputByRunId.get(run.runId);
    if (output === undefined || run.status !== "started" || run.output === output) return run;
    changed = true;
    return { ...run, output };
  });
  return changed ? { ...runtime, actionRuns } : runtime;
}
