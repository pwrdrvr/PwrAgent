/**
 * Identity of the context-rail tabs. Kept in its own dependency-light
 * module (no icon / panel imports) so `App.tsx` can seed + persist the
 * active tab without eagerly pulling the lazily-loaded ThreadView bundle.
 */
export type ContextTabId =
  | "info"
  | "edits"
  | "pricing"
  | "actions"
  | "subagents"
  | "automations"
  | "prs"
  | "projects"
  | "providers";

export const CONTEXT_TAB_IDS: ContextTabId[] = [
  "info",
  "edits",
  "pricing",
  "actions",
  "subagents",
  "automations",
  "prs",
  "projects",
  "providers",
];

export const DEFAULT_CONTEXT_TAB: ContextTabId = "info";

export function isContextTabId(value: unknown): value is ContextTabId {
  return (
    typeof value === "string" && (CONTEXT_TAB_IDS as string[]).includes(value)
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
