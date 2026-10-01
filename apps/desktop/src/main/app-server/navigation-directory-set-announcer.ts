import type { AgentEvent, NavigationDirectorySummary } from "@pwragent/shared";
import {
  NAVIGATION_DIRECTORY_SET_CHANGED_METHOD,
  navigationInvalidationMayChangeMembership,
  navigationQueryEventRequiresRefresh,
} from "@pwragent/shared";

/**
 * The thread-list reuse window. A provider can list a thread that PwrAgent
 * never saw start (a Codex CLI session in a new folder), and the owner only
 * learns of it when that cache refills. Re-checking on this interval keeps a
 * watched owner no staler than a viewer that re-read it would be.
 */
export const DIRECTORY_SET_RECHECK_INTERVAL_MS = 5 * 60_000;
/** Coalesces a burst of input changes into one index build. */
const DIRECTORY_SET_SETTLE_MS = 250;

export type DirectorySetChangeReason = "changed" | "subscribed";

/**
 * The fields a viewer matches a project on, and nothing that changes with
 * thread activity. `repositoryKey` on the wire is the Git status cache's
 * `originRepository`.
 */
export function directorySetFingerprint(
  directories: readonly NavigationDirectorySummary[],
): string {
  return JSON.stringify([...directories]
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    .map((directory) => [
      directory.key,
      directory.kind,
      directory.label,
      directory.path ?? null,
      directory.gitStatus?.originRepository ?? null,
      directory.localAvailability ?? null,
    ]));
}

/**
 * Whether an owner event can change its directory set. Events known to touch
 * a single thread row cannot, with one exception: a directory's Git status
 * carries its origin, which is part of the set.
 */
export function directorySetMayHaveChanged(event: AgentEvent): boolean {
  const method = event.notification.method as string;
  if (method === NAVIGATION_DIRECTORY_SET_CHANGED_METHOD) {
    return false;
  }
  if (method === "navigation/directoryGitStatus/updated") {
    return true;
  }
  return navigationQueryEventRequiresRefresh(method, event.notification.params)
    && navigationInvalidationMayChangeMembership(method);
}

/**
 * Tells `directory_set` subscribers when this owner's directory set changes,
 * so a viewer can trust an index it read for as long as no announcement
 * arrives.
 *
 * Every complete-scope index build reports its directories to `observe`, and
 * a build whose set differs from the previous one announces the change. A
 * viewer's read is itself a build, so nothing the owner serves goes
 * unannounced. While watched, the owner also rebuilds without being asked:
 * after any input that can change the set (an owner event that can change
 * membership, a launchpad write), and on `DIRECTORY_SET_RECHECK_INTERVAL_MS`
 * with a provider refresh, for threads that appear outside PwrAgent.
 *
 * Only reads. The provider refresh writes nothing in steady state.
 */
export class NavigationDirectorySetAnnouncer {
  private fingerprint: string | undefined;
  private watched = false;
  private unsubscribeInputs: (() => void) | undefined;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private recheckTimer: ReturnType<typeof setInterval> | undefined;
  private rebuilding = false;
  private pending: { refreshProviders: boolean } | undefined;

  constructor(private readonly options: {
    publish: (reason: DirectorySetChangeReason) => void;
    rebuild: (options: { refreshProviders: boolean }) => Promise<unknown>;
    subscribeInputs: (changed: () => void) => () => void;
    onRebuildError?: (error: unknown) => void;
    recheckIntervalMs?: number;
    settleMs?: number;
  }) {}

  /** Report the directories of a complete-scope owner index build. */
  observe(directories: readonly NavigationDirectorySummary[]): void {
    const next = directorySetFingerprint(directories);
    const previous = this.fingerprint;
    this.fingerprint = next;
    if (this.watched && previous !== undefined && previous !== next) {
      this.options.publish("changed");
    }
  }

  setWatched(watched: boolean): void {
    if (watched === this.watched) {
      return;
    }
    this.watched = watched;
    if (watched) {
      this.unsubscribeInputs = this.options.subscribeInputs(() => this.schedule(false));
      this.recheckTimer = setInterval(
        () => this.schedule(true),
        this.options.recheckIntervalMs ?? DIRECTORY_SET_RECHECK_INTERVAL_MS,
      );
      this.recheckTimer.unref?.();
      return;
    }
    this.unsubscribeInputs?.();
    this.unsubscribeInputs = undefined;
    clearInterval(this.recheckTimer);
    this.recheckTimer = undefined;
    clearTimeout(this.settleTimer);
    this.settleTimer = undefined;
    this.pending = undefined;
  }

  dispose(): void {
    this.setWatched(false);
  }

  private schedule(refreshProviders: boolean): void {
    if (!this.watched) {
      return;
    }
    this.pending = { refreshProviders: refreshProviders || Boolean(this.pending?.refreshProviders) };
    if (this.settleTimer || this.rebuilding) {
      return;
    }
    this.settleTimer = setTimeout(() => {
      this.settleTimer = undefined;
      void this.rebuild();
    }, this.options.settleMs ?? DIRECTORY_SET_SETTLE_MS);
    this.settleTimer.unref?.();
  }

  private async rebuild(): Promise<void> {
    const pending = this.takePending();
    if (!pending || !this.watched) {
      return;
    }
    this.rebuilding = true;
    try {
      await this.options.rebuild(pending);
    } catch (error) {
      this.options.onRebuildError?.(error);
    } finally {
      this.rebuilding = false;
    }
    // An input that changed during the build may not be in it.
    const next = this.takePending();
    if (next) {
      this.schedule(next.refreshProviders);
    }
  }

  private takePending(): { refreshProviders: boolean } | undefined {
    const pending = this.pending;
    this.pending = undefined;
    return pending;
  }
}
