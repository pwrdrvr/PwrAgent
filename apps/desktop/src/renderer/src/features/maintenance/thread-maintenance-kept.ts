import type { ThreadMaintenanceKeptCheckout, ThreadMaintenanceScanStep } from "@pwragent/shared";
import { allocationTotal, largestFirst, type AllocationTotal } from "./thread-maintenance-selection";

/** Kept checkouts that share one reason: the largest first, unmeasured last. */
export type KeptGroup = {
  reason: string;
  rows: ThreadMaintenanceKeptCheckout[];
  total?: AllocationTotal;
};

/**
 * Each path once, under the reason it was first sent with. Groups are ordered
 * by what they hold on disk, then by size of group, then by first appearance.
 * Owners are passed through untouched: a row the owner sent without threads
 * stays without threads.
 */
export function groupKeptCheckouts(rows: readonly ThreadMaintenanceKeptCheckout[]): KeptGroup[] {
  const seen = new Set<string>();
  const groups = new Map<string, ThreadMaintenanceKeptCheckout[]>();
  for (const row of rows) {
    if (seen.has(row.path)) continue;
    seen.add(row.path);
    const group = groups.get(row.reason) ?? [];
    group.push(row);
    groups.set(row.reason, group);
  }
  return [...groups].map(([reason, members], order) => {
    const sized = members.map((row) => ({ row, space: spaceOf(row), worktreePath: row.path }));
    const total = allocationTotal(sized);
    return { reason, order, rows: largestFirst(sized).map((item) => item.row), ...(total ? { total } : {}) };
  })
    .sort((a, b) => (b.total?.bytes ?? -1) - (a.total?.bytes ?? -1) || b.rows.length - a.rows.length || a.order - b.order)
    .map(({ order: _order, ...group }) => group);
}

export function spaceOf(row: ThreadMaintenanceKeptCheckout) {
  return row.allocatedBytes === undefined ? undefined : { allocatedBytes: row.allocatedBytes };
}

/** What the guidance may say about this scan. */
export type KeptGuidanceContext = {
  step: ThreadMaintenanceScanStep;
  /** Checkout hibernation's idle days for this scan. */
  idleDays?: number;
  /** The archive rule's inactivity days, when it archives by age. */
  inactivityDays?: number;
  /** This scan also reviews archived checkouts. */
  checkoutsStep?: boolean;
};

function days(count: number): string {
  return `${count} ${count === 1 ? "day" : "days"}`;
}

/**
 * What keeps a checkout, and what the operator can do about it, for the
 * reasons main sends. Each points at the thread, the plan or Settings, and
 * at a re-scan, never at a shortcut: there is no force here, and none of it
 * promises a checkout will be offered, since another protection may still
 * keep it. An unknown reason gets no guidance rather than a guess.
 */
export function keptGuidance(reason: string, context: KeptGuidanceContext): string | undefined {
  switch (reason) {
    case "Watching a PR":
      return "An active PR watch will wake this thread. This scan keeps its checkout while the watch is active. "
        + "Open the thread's Pull requests card and find Wakes this thread. If you no longer need the watch, use Stop, "
        + "then re-scan.";
    case "Recently active": {
      const threshold = context.step === "hibernate" ? context.idleDays : context.inactivityDays;
      return threshold === undefined
        ? "Recent enough that this scan's idle rule keeps it. A later scan considers it again."
        : `${context.step === "hibernate" ? "Worked in or restored" : "Active"} within the last ${days(threshold)}, `
          + "this scan's idle threshold, so it is not considered yet. Other protections may still keep it later. "
          + "To consider it sooner, lower the days in the plan and re-scan.";
    }
    case "Already archived":
      return context.step === "hibernate"
        ? "An older PwrAgent kept this because its thread was archived. Archived status no longer keeps a checkout. "
          + "The scan's idle threshold and other protections still apply. Re-scan with an updated PwrAgent."
        : "Already archived.";
    // Sent only by an older owner. Ignored files no longer keep a checkout.
    case "Other ignored files":
    case "Ignored files only":
      return "An older PwrAgent kept this for its ignored files. Ignored files no longer keep a checkout: they are "
        + "deleted with it and are not in its snapshot. Re-scan with an updated PwrAgent to consider it again.";
    case "Commits on no branch":
      return "The checkout has commits that no branch or tag holds, and removing it would lose them. Open the thread "
        + "and put any you want on a branch, then re-scan.";
    case "Uncommitted changes":
      return "The checkout has uncommitted changes. Open the thread to review them, commit or save what you want "
        + "to keep, then re-scan.";
    case "Changes over the snapshot limit":
      return context.step === "hibernate"
        ? "Its changes are larger than the hibernation snapshot limit (Settings → Worktrees → Largest snapshot), "
          + "so they could not be saved first. Review and commit them from the thread, or raise that limit, then re-scan."
        : "Its changes are larger than a snapshot can hold. Review and commit them from the thread, then re-scan.";
    case "Stashed changes":
      return "The repository has stashed changes from this checkout. Apply or drop them yourself, then re-scan.";
    case "Submodule changes":
      return "A submodule in the checkout has changes. Review them from the thread, then re-scan.";
    case "Git operation in progress":
      return "A merge, rebase or similar Git operation is waiting in this checkout. Finish or abort it, then re-scan.";
    case "Locked worktree":
      return "Git has this worktree locked. It stays until someone unlocks it.";
    case "Main checkout":
      return "This is a repository's main checkout. Maintenance never hibernates or removes one.";
    case "Used by an active thread":
      return "A thread that is not archived still uses this checkout. It may be one this scan did not read, such as "
        + "another profile's. The checkout stays while that thread uses it.";
    case "Externally managed":
    case "Checkout ownership not registered":
    case "Checkout not created by PwrAgent":
      return "An attached linked checkout inside PwrAgent's worktree folder no longer stays external because of an old "
        + "flag. Outside that folder, a checkout recorded as externally managed stays protected. Re-scan with an updated "
        + "PwrAgent, or open the thread to inspect its checkout.";
    case "Checkout outside PwrAgent's and Codex's worktrees":
    case "Codex chat folder":
      return "PwrAgent did not create this checkout, so maintenance leaves it to you or the app that made it.";
    case "Repository no longer exists":
      return "Its repository is gone, so maintenance cannot check what the checkout holds. Look at the folder yourself.";
    case "Pinned thread":
      return "Pinned threads are kept. Unpin it from the thread list if you are done with it, then re-scan.";
    case "Kept awake":
      return "Keep Checkout Awake is on for this thread, so hibernation leaves it alone. If it can sleep, turn that off in "
        + "the thread's menu in the sidebar, then re-scan.";
    case "Busy":
    case "Active or blocked chat":
    case "Active subagent":
    case "Pending work":
    case "Scheduled work":
      return "The thread has work in progress or waiting. Let it finish, or answer what it is waiting for, then re-scan.";
    case "Merge held":
      return "A merge hold is set on this thread. Once the hold is released, re-scan.";
    case "Shared with another thread":
      return "Another thread uses this checkout. It stays while any thread that uses it is kept.";
    case "Activity unknown":
      return "The provider gave no last activity, so its idle time cannot be judged. Open the thread to refresh it, then re-scan.";
    case "Agent thread":
      return "Agent threads are kept so the agent can come back to its work.";
    case "Already hibernated":
      return "Already hibernated. Its checkout comes back when the thread gets a message.";
    case "Remote execution":
      return "The thread runs on a remote target, so this machine does not manage its checkout.";
    default:
      return undefined;
  }
}

/** Only web links leave the app; main's allowlist checks them again. */
export function pullRequestHref(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}
