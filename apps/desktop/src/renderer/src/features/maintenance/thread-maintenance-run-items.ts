import type {
  ThreadMaintenanceProblem,
  ThreadMaintenanceRunItem,
  ThreadMaintenanceRunStage,
} from "@pwragent/shared";
import { formatBytes } from "./thread-maintenance-selection";

/** A run's items by where they are. Every item appears in exactly one
 * list. Rows never reorder as later work starts or ends:
 * - active rows keep the order they started in;
 * - finished rows keep the order they finished in, so a new result appends
 *   and an earlier success stays where it was;
 * - waiting rows keep the order main sent them. */
export type RunItemView = {
  active: ThreadMaintenanceRunItem[];
  waiting: ThreadMaintenanceRunItem[];
  failed: ThreadMaintenanceRunItem[];
  kept: ThreadMaintenanceRunItem[];
  done: ThreadMaintenanceRunItem[];
};

export type RunItemCounts = Record<keyof RunItemView, number> & { total: number; finished: number };

/** Each item id once: the first row main sent for it. */
function unique(items: readonly ThreadMaintenanceRunItem[]): { item: ThreadMaintenanceRunItem; index: number }[] {
  const seen = new Set<string>();
  const rows: { item: ThreadMaintenanceRunItem; index: number }[] = [];
  items.forEach((item, index) => {
    if (seen.has(item.itemId)) return;
    seen.add(item.itemId);
    rows.push({ item, index });
  });
  return rows;
}

/** Earlier time first; a missing time sorts after every known one; ties
 * keep main's order. */
function byTime(time: (item: ThreadMaintenanceRunItem) => number | undefined) {
  return (a: { item: ThreadMaintenanceRunItem; index: number }, b: { item: ThreadMaintenanceRunItem; index: number }) => {
    const ta = time(a.item);
    const tb = time(b.item);
    if (ta === undefined || tb === undefined) {
      if (ta !== tb) return ta === undefined ? 1 : -1;
      return a.index - b.index;
    }
    return ta - tb || a.index - b.index;
  };
}

export function runItemView(items: readonly ThreadMaintenanceRunItem[] | undefined): RunItemView {
  const rows = unique(items ?? []);
  const pick = (status: ThreadMaintenanceRunItem["status"], order: (a: typeof rows[number], b: typeof rows[number]) => number) =>
    rows.filter(({ item }) => item.status === status).sort(order).map(({ item }) => item);
  const sent = (a: typeof rows[number], b: typeof rows[number]) => a.index - b.index;
  const finished = byTime((item) => item.finishedAt);
  return {
    active: pick("running", byTime((item) => item.startedAt)),
    waiting: pick("queued", sent),
    failed: pick("failed", finished),
    kept: pick("kept", finished),
    done: pick("done", finished),
  };
}

export function runItemCounts(view: RunItemView): RunItemCounts {
  const counts = {
    active: view.active.length,
    waiting: view.waiting.length,
    failed: view.failed.length,
    kept: view.kept.length,
    done: view.done.length,
  };
  const finished = counts.failed + counts.kept + counts.done;
  return { ...counts, finished, total: finished + counts.active + counts.waiting };
}

/** Whether this run reports per-item rows. An older owner sends none. */
export function hasRunItems(items: readonly ThreadMaintenanceRunItem[] | undefined): items is ThreadMaintenanceRunItem[] {
  return (items?.length ?? 0) > 0;
}

/** What an active item is doing now, in its own words. Waiting means it
 * is queued behind its repository's removal lock. */
export function stageText(item: Pick<ThreadMaintenanceRunItem, "action" | "stage">): string {
  const stage: ThreadMaintenanceRunStage | undefined = item.stage;
  switch (stage) {
    case "checking":
      return "Checking";
    case "snapshotting":
      return "Saving snapshot";
    case "verifying":
      return "Verifying snapshot";
    case "waiting":
      return "Waiting for its repository";
    case "removing":
      return item.action === "trashCheckout"
        ? "Moving to the Trash"
        : item.action === "removeBuildOutput"
          ? "Deleting build output"
          : item.action === "removeEmptyFolders"
            ? "Removing folders"
            : "Removing worktree";
    case "recording":
      return "Recording";
    default:
      return "Starting";
  }
}

const DONE_TEXT: Record<ThreadMaintenanceRunItem["action"], string> = {
  archive: "Archived",
  hibernate: "Hibernated",
  removeCheckout: "Removed",
  trashCheckout: "Moved to the Trash",
  removeBuildOutput: "Build output deleted",
  removeEmptyFolders: "Folders removed",
};

/** A finished item's outcome. Allocation removed is what the checkout
 * held, not volume space recovered. */
export function outcomeText(item: ThreadMaintenanceRunItem): string {
  if (item.status === "done") {
    return `${DONE_TEXT[item.action]}${item.allocatedBytesRemoved ? ` · ${formatBytes(item.allocatedBytesRemoved)} allocation removed` : ""}`;
  }
  if (item.status === "kept") return item.reason ?? "Kept";
  if (item.status === "failed") return item.reason ?? "Failed";
  return item.status === "running" ? stageText(item) : "Waiting";
}

/** Whether `problem` is the same outcome as a kept or failed item, so the
 * finished view says it once. */
export function problemMatchesItem(problem: ThreadMaintenanceProblem, item: ThreadMaintenanceRunItem): boolean {
  if (item.status !== problem.kind || item.step !== problem.step) return false;
  if (problem.threadId && item.threadId) return problem.threadId === item.threadId && problem.backend === item.backend;
  if (problem.path && item.path) return problem.path === item.path;
  return problem.object === item.object;
}

/** Problems no item already reports, such as step-level notes or rows an
 * owner sent before it had items. */
export function problemsWithoutItems(
  problems: readonly ThreadMaintenanceProblem[],
  items: readonly ThreadMaintenanceRunItem[] | undefined,
): ThreadMaintenanceProblem[] {
  if (!hasRunItems(items)) return [...problems];
  return problems.filter((problem) => !items.some((item) => problemMatchesItem(problem, item)));
}
