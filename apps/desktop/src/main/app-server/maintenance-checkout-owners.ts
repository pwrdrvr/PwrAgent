import path from "node:path";
import type { ThreadMaintenanceKeptThread } from "@pwragent/shared";
import { archiveCandidateLastActivity, type ThreadArchiveCandidate } from "./thread-archive-sweeper";
import { candidateCheckoutDirectories } from "./thread-owned-checkouts";
import { checkoutHibernationLastActivity } from "./checkout-hibernation";

/** Display metadata only. A PR association or a known owner never grants
 * permission to remove a checkout. No provider or forge requests are made. */
export function maintenanceKeptThread(candidate: ThreadArchiveCandidate, lastActivityAt = archiveCandidateLastActivity(candidate)): ThreadMaintenanceKeptThread {
  const { thread, overlay } = candidate;
  const branch = overlay?.gitBranch?.trim() || thread.gitBranch?.trim()
    || thread.linkedDirectories.find((directory) => directory.gitBranch)?.gitBranch;
  const pullRequests = new Map<string, NonNullable<ThreadMaintenanceKeptThread["pullRequests"]>[number]>();
  const known = [
    ...candidate.activePrWatches?.map((watch) => ({ url: watch.prUrl, title: watch.prTitle, number: watch.prNumber })) ?? [],
    ...overlay?.prs ?? [],
  ];
  for (const pr of known) {
    try {
      if (!["https:", "http:"].includes(new URL(pr.url).protocol) || pullRequests.has(pr.url)) continue;
      pullRequests.set(pr.url, { url: pr.url, ...(pr.title ? { title: pr.title } : {}), ...(pr.number ? { number: pr.number } : {}) });
    } catch { /* An unreadable cached link is not a navigation destination. */ }
  }
  return {
    backend: thread.source, threadId: thread.id, title: thread.title,
    ...(branch ? { branch } : {}),
    ...(Number.isFinite(lastActivityAt) && lastActivityAt > 0 ? { lastActivityAt } : {}),
    ...(pullRequests.size ? { pullRequests: [...pullRequests.values()] } : {}),
  };
}

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** The caller can supply canonical paths from its existing ownership read.
 * A thread with unknown cwd is never attributed to an arbitrary checkout. */
export class MaintenanceCheckoutOwners {
  private readonly paths = new Map<string, Set<string>>();
  private readonly threads = new Map<string, ThreadMaintenanceKeptThread>();

  add(target: string, thread: ThreadMaintenanceKeptThread): void {
    const key = pathKey(target);
    let owners = this.paths.get(key);
    if (!owners) this.paths.set(key, owners = new Set());
    const identity = JSON.stringify([thread.backend, thread.threadId]);
    owners.add(identity);
    this.threads.set(identity, thread);
  }

  forPath(target: string): ThreadMaintenanceKeptThread[] {
    const key = pathKey(target);
    const owners = new Map<string, ThreadMaintenanceKeptThread>();
    for (const [cwd, rows] of this.paths) {
      if (cwd !== key && !cwd.startsWith(key + path.sep)) continue;
      for (const identity of rows) owners.set(identity, this.threads.get(identity)!);
    }
    return [...owners.values()];
  }

  static fromCandidates(candidates: readonly ThreadArchiveCandidate[]): MaintenanceCheckoutOwners {
    const index = new MaintenanceCheckoutOwners();
    for (const candidate of candidates) {
      const owner = maintenanceKeptThread(candidate, checkoutHibernationLastActivity(candidate));
      for (const target of candidateCheckoutDirectories(candidate)) index.add(target, owner);
    }
    return index;
  }
}
