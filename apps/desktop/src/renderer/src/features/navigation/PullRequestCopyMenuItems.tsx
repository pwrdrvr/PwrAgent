import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared";
import { statusPulseRef } from "../../lib/status-pulse";
import {
  prChipModifierClasses,
  resolvePrChipPresentation,
} from "../pr-status/pr-chip-state";
import { prNumberLabel, resolvePrRollup } from "../pr-status/pr-rollup";
import { ContextMenuCascade } from "./ContextMenuCascade";
import { needsRepoPrefix } from "./ThreadRow";

/** The flyout lists this many PRs; Copy All covers the rest. */
export const PR_COPY_MENU_LIMIT = 10;

/**
 * The thread menu's Copy Pull Request URL. One PR is a plain item. Several
 * cascade into a list in the PR list's order (`resolvePrRollup().ordered`),
 * the first `PR_COPY_MENU_LIMIT` of them, then Copy All, one URL per line.
 */
export function PullRequestCopyMenuItems(props: {
  thread: NavigationThreadSummary;
  prs: readonly PrSummary[];
  onCopy: (value: string) => void;
}) {
  const ordered = resolvePrRollup(props.prs)?.ordered ?? [];
  if (ordered.length === 0) {
    return null;
  }
  if (ordered.length === 1) {
    return (
      <button
        role="menuitem"
        type="button"
        onClick={() => props.onCopy(ordered[0]!.url)}
      >
        Copy Pull Request URL
      </button>
    );
  }
  const all = [...props.prs];
  return (
    <ContextMenuCascade
      label="Copy Pull Request URL"
      groupLabel={`${ordered.length} pull requests`}
    >
      {ordered.slice(0, PR_COPY_MENU_LIMIT).map((pr) => {
        const label = prNumberLabel(pr, needsRepoPrefix(props.thread, pr, all));
        const title = pr.title ?? `${pr.org}/${pr.repo}`;
        const presentation = resolvePrChipPresentation(pr);
        return (
          <button
            key={pr.url}
            role="menuitem"
            type="button"
            className="thread-context-menu__pr"
            aria-label={`Copy URL of ${label}, ${title}`}
            title={pr.url}
            onClick={() => props.onCopy(pr.url)}
          >
            <span
              aria-hidden="true"
              className={[
                "thread-context-menu__pr-state",
                ...prChipModifierClasses(presentation),
              ].join(" ")}
            >
              <span
                className="pr-chip__dot"
                ref={presentation.hasFailingChecksStillRunning ? statusPulseRef : undefined}
              />
            </span>
            <span aria-hidden="true" className="thread-context-menu__pr-number">{label}</span>
            <span aria-hidden="true" className="thread-context-menu__pr-title">{title}</span>
          </button>
        );
      })}
      <div className="thread-context-menu__separator" role="separator" />
      <button
        role="menuitem"
        type="button"
        onClick={() => props.onCopy(ordered.map((pr) => pr.url).join("\n"))}
      >
        Copy All {ordered.length} URLs
      </button>
    </ContextMenuCascade>
  );
}
