/**
 * Identity of the context-rail tabs. Kept in its own dependency-light
 * module (no icon / panel imports) so `App.tsx` can seed + persist the
 * active tab without eagerly pulling the lazily-loaded ThreadView bundle.
 */
export type ContextTabId =
  | "info"
  | "subagents"
  | "automations"
  | "prs"
  | "projects"
  | "providers";

export const CONTEXT_TAB_IDS: ContextTabId[] = [
  "info",
  "subagents",
  "automations",
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
