/**
 * Identity of the context-rail tabs. Kept in its own dependency-light
 * module (no icon / panel imports) so `App.tsx` can seed + persist the
 * active tab without eagerly pulling the lazily-loaded ThreadView bundle.
 */
export type ContextTabId =
  | "info"
  | "todos"
  | "edits"
  | "pricing"
  | "tool-calls"
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
  "edits",
  "pricing",
  "tool-calls",
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
