import {
  classifyDirectory,
  isToolManagedWorktreePath,
  orderByHomePreference,
  resolveProjectForgeAutomation,
  type NavigationThreadSummary,
  type ProjectForgeAutomation,
} from "@pwragent/shared";
import type { NavigationDirectoryView } from "../../lib/navigation-loaded-rows";

/**
 * Whether a project row offers Pause Forge Activity and Forge Automation….
 * The setting lives on the instance that owns the project's threads, so only
 * a configured local `directory:` project in this instance's own window can
 * carry it. A peer window and a placeholder row get neither.
 */
export function canEditProjectForgeAutomation(
  directory: Pick<NavigationDirectoryView, "kind" | "localAvailability">,
  federationWindow: boolean,
): boolean {
  return !federationWindow
    && directory.kind === "directory"
    && directory.localAvailability !== "unconfigured";
}

export function isProjectForgeActivityPaused(
  directory: Pick<NavigationDirectoryView, "forgeAutomation">,
): boolean {
  return directory.forgeAutomation?.paused === true;
}

/** The stored settings with pause turned on or off. The switches are kept. */
export function withProjectForgePause(
  automation: ProjectForgeAutomation | undefined,
  paused: boolean,
  now: number,
): ProjectForgeAutomation {
  const { pausedAt: _pausedAt, ...current } = resolveProjectForgeAutomation(automation);
  return paused
    ? { ...current, paused: true, pausedAt: automation?.paused && automation.pausedAt ? automation.pausedAt : now }
    : { ...current, paused: false };
}

/**
 * The project row a thread is filed under, as the sidebar groups it
 * (`buildDirectorySummaries`): each linked directory is classified, so a
 * `.worktrees/` checkout folds onto its repository; a tool-managed worktree
 * (`~/.pwragent/worktrees/…`, `~/.codex/worktrees/…`) folds onto the one
 * project row with its name; and the home preference picks a stable project
 * over a throwaway worktree folder. Undefined when that row is not loaded.
 */
export function findThreadProjectDirectory<
  T extends Pick<NavigationDirectoryView, "key" | "kind" | "label" | "path">,
>(
  thread: Pick<NavigationThreadSummary, "linkedDirectories">,
  directories: readonly T[] | undefined,
): T | undefined {
  if (thread.linkedDirectories.length === 0 || !directories?.length) return undefined;
  const stableRowByLabel = new Map<string, T | null>();
  for (const directory of directories) {
    if (directory.kind !== "directory" || !directory.path || isToolManagedWorktreePath(directory.path)) {
      continue;
    }
    stableRowByLabel.set(
      directory.label,
      stableRowByLabel.has(directory.label) ? null : directory,
    );
  }
  const candidates = thread.linkedDirectories.map((linked) => {
    const descriptor = classifyDirectory(linked);
    const stableRow = descriptor.path && isToolManagedWorktreePath(descriptor.path)
      ? stableRowByLabel.get(descriptor.label)
      : undefined;
    return stableRow
      ? { key: stableRow.key, path: stableRow.path }
      : { key: descriptor.key, path: descriptor.path };
  });
  const home = orderByHomePreference(candidates, (candidate) => candidate.path)[0];
  return home ? directories.find((directory) => directory.key === home.key) : undefined;
}

/**
 * How a project's Forge Automation narrows a thread's Auto-fix control.
 * `muted` when nothing from the forge can start a repair; otherwise only the
 * tooltip changes. The thread's own value is never touched.
 */
export function describeProjectAutoFixOverride(
  automation: ProjectForgeAutomation | undefined,
  projectLabel: string,
): { muted: boolean; tooltip: string } | undefined {
  if (!automation) return undefined;
  const howToChange = "Change it from the project menu: Forge Automation…";
  if (automation.paused) {
    return {
      muted: true,
      tooltip: `Auto-fix is paused for ${projectLabel}. This thread's own setting returns on resume. ${howToChange}`,
    };
  }
  if (!automation.autoFixMergeConflicts && !automation.autoFixCiFailures) {
    return {
      muted: true,
      tooltip: `Auto-fix is turned off for ${projectLabel}. This thread's own setting returns when it is turned back on. ${howToChange}`,
    };
  }
  if (!automation.autoFixMergeConflicts) {
    return { muted: false, tooltip: `Auto-fix skips merge conflicts in ${projectLabel}.` };
  }
  if (!automation.autoFixCiFailures) {
    return { muted: false, tooltip: `Auto-fix skips failing CI in ${projectLabel}.` };
  }
  return undefined;
}

const timeOfDayFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

const dateAndTimeFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** "9:42 AM" today, "Oct 12, 9:42 AM" on another day. */
export function formatForgeAutomationTime(timestamp: number, now: number): string {
  const sameDay = new Date(timestamp).toDateString() === new Date(now).toDateString();
  return (sameDay ? timeOfDayFormatter : dateAndTimeFormatter).format(timestamp);
}

export function formatHeldWakeupCount(count: number): string {
  return `${count} ${count === 1 ? "wake-up" : "wake-ups"} held`;
}
