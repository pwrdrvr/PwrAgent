/**
 * Identity of the context-rail tabs. Kept in its own dependency-light
 * module (no icon / panel imports) so `App.tsx` can seed + persist the
 * active tab without eagerly pulling the lazily-loaded ThreadView bundle.
 */
export type ContextTabId =
  | "info"
  | "todos"
  | "research"
  | "waiting"
  | "edits"
  | "pricing"
  | "decisions"
  | "actions"
  | "subagents"
  | "automations"
  | "pr-activity"
  | "prs"
  | "projects"
  | "providers"
  // Launchpad-only, and never persisted: CONTEXT_TAB_IDS leaves it out so a
  // stored tab can never name it.
  | "connections";

export const CONTEXT_TAB_IDS: ContextTabId[] = [
  "info",
  "todos",
  "research",
  "waiting",
  "edits",
  "pricing",
  "decisions",
  "actions",
  "subagents",
  "automations",
  "pr-activity",
  "prs",
  "projects",
  "providers",
];

export const DEFAULT_CONTEXT_TAB: ContextTabId = "info";

export function isContextTabId(value: unknown): value is ContextTabId {
  return (
    typeof value === "string" &&
    (CONTEXT_TAB_IDS as string[]).includes(value)
  );
}

/**
 * The tabs the rail's icon spine draws. Details took in eight of the old
 * tabs; the rest kept their own icons.
 */
export type ContextRailTabId =
  | "details"
  | "todos"
  | "research"
  | "waiting"
  | "pricing"
  | "decisions"
  | "providers"
  | "connections";

/** The four views of the Details tab's segmented control. */
export type DetailsSegmentId = "thread" | "changes" | "prs" | "jobs";

export const DETAILS_SEGMENT_IDS: readonly DetailsSegmentId[] = [
  "thread",
  "changes",
  "prs",
  "jobs",
];

/** The section a segment scrolls to when a request named one. */
export type DetailsSectionId =
  | "folders"
  | "activity"
  | "commands"
  | "subagents"
  | "scheduled";

export type ContextRailTarget = {
  tab: ContextRailTabId;
  /** Set exactly when `tab` is `details`. */
  segment?: DetailsSegmentId;
  section?: DetailsSectionId;
};

/**
 * Where a context tab id lands on the rail. Every id stays valid: the
 * persisted `[ui] active_context_tab`, deep links, and reveal requests
 * (to-do, PR and sub-agent chips, Actions toasts) still name the old tabs,
 * and the eight that Details took in open it at their segment.
 */
export function resolveContextTabTarget(id: ContextTabId): ContextRailTarget {
  switch (id) {
    case "info":
      return { tab: "details", segment: "thread" };
    case "projects":
      return { tab: "details", segment: "thread", section: "folders" };
    case "edits":
      return { tab: "details", segment: "changes" };
    case "prs":
      return { tab: "details", segment: "prs" };
    case "pr-activity":
      return { tab: "details", segment: "prs", section: "activity" };
    case "actions":
      return { tab: "details", segment: "jobs", section: "commands" };
    case "subagents":
      return { tab: "details", segment: "jobs", section: "subagents" };
    case "automations":
      return { tab: "details", segment: "jobs", section: "scheduled" };
    case "todos":
    case "research":
    case "waiting":
    case "pricing":
    case "decisions":
    case "providers":
    case "connections":
      return { tab: id };
  }
}

/**
 * The id a segment is stored and announced as. It is one of the old tab
 * ids, so the persisted value keeps its shape and an older build reading it
 * opens the same view.
 */
export function contextTabIdForDetailsSegment(segment: DetailsSegmentId): ContextTabId {
  switch (segment) {
    case "thread":
      return "info";
    case "changes":
      return "edits";
    case "prs":
      return "prs";
    case "jobs":
      return "actions";
  }
}

/**
 * Where the accumulated edited-files list renders: above the composer
 * (default LiveWorkRail placement) or only in the context-rail Edits
 * panel. Persisted to `config.toml` `[ui] edited_files_dock`; lives
 * here for the same dependency-light reason as `ContextTabId`.
 */
export type EditedFilesDock = "above" | "sidebar";

export const DEFAULT_EDITED_FILES_DOCK: EditedFilesDock = "above";

export function isEditedFilesDock(value: unknown): value is EditedFilesDock {
  return value === "above" || value === "sidebar";
}

export type ActionRunsDock = "above" | "sidebar";

export const DEFAULT_ACTION_RUNS_DOCK: ActionRunsDock = "above";

export function isActionRunsDock(value: unknown): value is ActionRunsDock {
  return value === "above" || value === "sidebar";
}

/**
 * Where the new-thread connection cards (PwrGit, PwrSnap, Sandboxer) render:
 * in the launchpad above the composer (default), or only in the context
 * rail's Connections tab. Persisted to `config.toml`
 * `[ui] launchpad_connections_dock`.
 */
export type LaunchpadConnectionsDock = "launchpad" | "sidebar";

export const DEFAULT_LAUNCHPAD_CONNECTIONS_DOCK: LaunchpadConnectionsDock = "launchpad";

export function isLaunchpadConnectionsDock(
  value: unknown,
): value is LaunchpadConnectionsDock {
  return value === "launchpad" || value === "sidebar";
}
