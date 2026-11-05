import type { AgentEvent } from "@pwragent/shared";
import {
  buildThreadIdentityKey,
  NAVIGATION_DIRECTORY_SET_CHANGED_METHOD,
  navigationInvalidationMayChangeMembership,
  navigationQueryEventRequiresRefresh,
  navigationWorkingStatePath,
  readNavigationDirectoryScope,
} from "@pwragent/shared";
import type { NavigationQueryIndex } from "./navigation-query-projection";

/** Membership authority outlives row freshness, but never a membership boundary. */
export class NavigationDirectoryScope {
  private revision = 0;
  private byThread?: Map<string, Set<string>>;
  private byPath?: Map<string, Set<string>>;

  checkpoint(): number { return this.revision; }

  /** Called at event ingress, before asynchronous recording or listener fan-out. */
  invalidate(event: AgentEvent): void {
    if (event.federationTarget?.scope === "remote") return;
    const method = event.notification.method;
    const sourceMethod = method === "navigation/invalidated"
      ? (event.notification.params as { sourceMethod?: unknown }).sourceMethod : method;
    if (method !== NAVIGATION_DIRECTORY_SET_CHANGED_METHOD
      && !(navigationQueryEventRequiresRefresh(method, event.notification.params)
        && navigationInvalidationMayChangeMembership(sourceMethod))) return;
    this.revision += 1;
    this.byThread = undefined;
    this.byPath = undefined;
  }

  /** Only the latest unfiltered owner scan may call this, with its ingress fence. */
  remember(index: NavigationQueryIndex, checkpoint: number): void {
    if (checkpoint !== this.revision) return;
    this.byThread = undefined;
    this.byPath = undefined;
    if (index.coverage?.state !== "complete") return;
    const members = new Map<string, Set<string>>();
    for (const directory of index.directories) {
      for (const key of directory.threadKeys) {
        const keys = members.get(key) ?? new Set<string>();
        keys.add(directory.key);
        members.set(key, keys);
      }
    }
    const byThread = new Map<string, Set<string>>();
    const byPath = new Map<string, Set<string>>();
    for (const thread of index.threads) {
      // Native agents also affect their owner's working marker. Their owner
      // publishes subAgents/updated separately; never guess its dependency here.
      if (thread.federation || thread.codexNativeSubAgent) continue;
      const key = buildThreadIdentityKey(thread.source, thread.id);
      const keys = members.get(key) ?? new Set<string>();
      byThread.set(key, keys);
      const path = navigationWorkingStatePath(thread);
      if (path) {
        const paths = byPath.get(path) ?? new Set<string>();
        for (const directory of keys) paths.add(directory);
        byPath.set(path, paths);
      }
    }
    this.byThread = byThread;
    this.byPath = byPath;
  }

  forEvent(event: AgentEvent): AgentEvent["navigationDirectoryScope"] {
    if (event.federationTarget?.scope === "remote" || !this.byThread) return undefined;
    const params = event.notification.params as Record<string, unknown>;
    const method = event.notification.method === "navigation/invalidated" ? params.sourceMethod : event.notification.method;
    if (navigationInvalidationMayChangeMembership(method)) return undefined;
    // Directory Git metadata also stamps rows homed elsewhere through their
    // secondary links. Membership alone cannot exclude those dependencies.
    if (method === "navigation/directoryGitStatus/updated") return undefined;
    let keys: Set<string> | undefined;
    if (method === "navigation/threadGitWorkingState/updated" && typeof params.worktreePath === "string") {
      keys = this.byPath?.get(params.worktreePath);
    } else if (typeof params.threadId === "string") {
      keys = this.byThread.get(buildThreadIdentityKey(event.backend, params.threadId));
    }
    if (!keys) return undefined;
    const scope = { version: 1 as const, directoryKeys: [...keys] };
    return readNavigationDirectoryScope(scope) ? scope : undefined;
  }
}
