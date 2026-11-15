import type { OpenPathResponse } from "@pwragent/shared";
import type { AppNoticeToastNotice } from "./AppNoticeToast";

export type ProjectRevealOutcome =
  | { response: OpenPathResponse }
  | { error: unknown };

/**
 * A project's "Show in Finder" that showed nothing, as a toast. The click
 * comes from a hover card or a context menu that has already closed, so the
 * toast is the only place to say the checkout is gone or the reveal failed.
 * One notice per project path, so repeated clicks replace rather than stack.
 */
export function resolveProjectRevealNotice(
  project: { label: string; path: string },
  outcome: ProjectRevealOutcome,
): AppNoticeToastNotice | undefined {
  const base = {
    id: `project-reveal:${project.path}`,
    facts: [{ label: "Path", value: project.path }],
  };
  if ("response" in outcome) {
    const { response } = outcome;
    if (response.opened) return undefined;
    if (response.missing) {
      return {
        ...base,
        title: "Folder not found",
        message: `${project.label}'s folder was not found. It may have been moved or deleted.`,
        tone: "warning",
      };
    }
    return {
      ...base,
      title: `Couldn't show ${project.label}`,
      message: response.error ?? "The folder could not be shown.",
      tone: "error",
    };
  }
  const { error } = outcome;
  return {
    ...base,
    title: `Couldn't show ${project.label}`,
    message: error instanceof Error ? error.message : String(error),
    tone: "error",
  };
}
