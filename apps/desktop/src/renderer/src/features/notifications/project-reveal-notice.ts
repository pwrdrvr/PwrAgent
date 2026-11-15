import { describeOpenPathFailure, type OpenPathOutcome } from "../../lib/open-path-failure";
import type { AppNoticeToastNotice } from "./AppNoticeToast";

/**
 * A project's "Show in Finder" that showed nothing, as a toast. The click
 * comes from a hover card or a context menu that has already closed, so the
 * toast is the only place to say the checkout is gone or the reveal failed.
 * One notice per project path, so repeated clicks replace rather than stack.
 */
export function resolveProjectRevealNotice(
  project: { label: string; path: string },
  outcome: OpenPathOutcome,
): AppNoticeToastNotice | undefined {
  const failure = describeOpenPathFailure(outcome, "The folder could not be shown.");
  if (!failure) return undefined;
  const base = {
    id: `project-reveal:${project.path}`,
    facts: [{ label: "Path", value: project.path }],
  };
  return failure.kind === "missing"
    ? {
        ...base,
        title: "Folder not found",
        message: `${project.label}'s folder was not found. It may have been moved or deleted.`,
        tone: "warning",
      }
    : {
        ...base,
        title: `Couldn't show ${project.label}`,
        message: failure.message,
        tone: "error",
      };
}
